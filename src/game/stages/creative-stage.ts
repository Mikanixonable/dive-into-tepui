// クリエイティブモード: 勝敗判定を発生させず、物体配置と軌道計画を自由に試すためのステージ。
import { Stage, type StageDeps, STORY_EPOCH } from './stage';
import { ManualSpawn } from '../creative/manual-spawn';
import { ObjectPlacement, type PlacedObject } from '../creative/object-placement';
import { StageControlsPanel, type EnemySpawnShape } from '../creative/stage-controls-panel';
import { isEnemy } from '../dynamic/dynamic-entity/enemy';
import { ProteinEnemy } from '../dynamic/dynamic-entity/protein-enemy';
import { hudRail } from '../hud/hud-root';
import { isPlayer } from '../player/player';
import { DEFAULT_PROTEIN_DISPLAY, type ProteinDisplaySettings } from '../protein/protein-display';
import { WaveAttack } from './stage-utils/wave-attack';
import type { KinematicState } from '../../physics/kinematic-state';
import type { CameraSystem } from '../camera/camera-system';
import type { FloatingOrigin } from '../camera/floating-origin';
import type { SimSpeedManager } from '../dynamic/sim-speed-manager';
import type { MapVisibilityPolicy } from '../map/visibility-policy';
import type { ObjectAuthoring } from '../pickable/inspected-object';
import type { CreativeStageSaveData, StageSaveData } from '../save/save-data';

export class CreativeStage extends Stage {
  static readonly id = 'creative' as const;
  static readonly epoch = STORY_EPOCH;
  // 開始日時の指定画面を挟む(SPEC GAME.md 9.0)。epoch はその欄の既定値になる。
  static readonly picksStartEpoch = true;
  static readonly selectLabel = 'CREATIVE';
  static readonly selectSub = '軌道上に艦艇を自由に配置して眺める';
  static readonly selectGroup = 'クリエイティブモード';
  static readonly selectKeys: string[] = [];
  readonly executesPlans = true;
  readonly authoring: ObjectAuthoring;

  private readonly objectPlacement: ObjectPlacement;
  private readonly manualSpawn: ManualSpawn;
  // 補給の自動投入・敵の波状攻撃を切り替えるトグルを載せたパネル。
  private readonly stageControlsPanel: StageControlsPanel;
  private readonly waveAttack: WaveAttack;
  // 敵の波状攻撃を発生させるかどうか(既定 OFF)。
  private waveAttackEnabled: boolean;

  // ステージ開始時に出すブリーフィングの本文(HTML)。
  briefingHtml(): string {
    return '<b>クリエイティブモード</b><br>マップから艦艇を配置して軌道を眺められる。';
  }

  // 配置・手動スポーンとステージ操作パネルを組み、保存データがあればそこから状態を戻す。
  // saved の型が StageSaveData なのは、復元の構築シグネチャを全ステージで揃えるため。
  constructor(saved: StageSaveData | undefined, ...deps: StageDeps) {
    super(saved, ...deps);
    const savedCreative = saved as CreativeStageSaveData | undefined;

    // 復元済みのタンパク質の敵がいれば、その表示設定を以後のスポーンにも引き継ぐ。
    const restoredProtein = this._dynamicSystem.all().find((entity) => entity instanceof ProteinEnemy);
    this.manualSpawn = new ManualSpawn(
      this._worldSfx, this._fx, this._scene, restoredProtein?.display ?? DEFAULT_PROTEIN_DISPLAY,
    );

    this.objectPlacement = new ObjectPlacement(
      this._hud, this._scene, this._dynamicSystem, this._celestialSystem, this._markers, this._worldSfx, this._fx,
    );
    this.objectPlacement.onPlace = (placed) => this.addPlacedObject(placed);
    this.authoring = this.objectPlacement;

    this.waveAttack = new WaveAttack(this._hud, this._worldSfx, this._fx, this._scene, this._celestialSystem.celestialMotions, savedCreative?.waveAttack);
    this.waveAttackEnabled = savedCreative?.waveAttackEnabled ?? false;
    this.stageControlsPanel = new StageControlsPanel(
      this.logistics.resupplyEnabled, this.logistics.rcsFuelResupplyEnabled, this.waveAttackEnabled,
      this.manualSpawn.spawnDistance, this.manualSpawn.display,
    );
    this.stageControlsPanel.onToggleResupply = (on) => { this.logistics.resupplyEnabled = on; };
    this.stageControlsPanel.onToggleFuelResupply = (on) => { this.logistics.rcsFuelResupplyEnabled = on; };
    this.stageControlsPanel.onToggleWaveAttack = (on) => { this.waveAttackEnabled = on; };
    this.stageControlsPanel.onRefillAmmo = () => this.refillShipAmmo();
    this.stageControlsPanel.onRefillFuel = () => this.refillShipRcsFuel();
    this.stageControlsPanel.onSpawnDistanceChange = (distance) => { this.manualSpawn.spawnDistance = distance; };
    this.stageControlsPanel.onSpawnEnemy = (shape, colorValue) => this.spawnManualEnemy(shape, colorValue);
    this.stageControlsPanel.onSpawnFormation = () => this.spawnProteinFormation();
    this.stageControlsPanel.onProteinDisplayChange = (display) => {
      this.manualSpawn.display = display;
      this.applyProteinDisplay(display);
    };
    hudRail(this._hud.mapRoot, 'right').appendChild(this.stageControlsPanel.element);

    this.begin();
  }

  // 出ているタンパク質の敵すべてへ、選ばれた表示設定を反映する。
  private applyProteinDisplay(display: ProteinDisplaySettings): void {
    for (const entity of this._dynamicSystem.all()) {
      if (entity instanceof ProteinEnemy) entity.setDisplay(display);
    }
  }

  // 操作艦の弾薬を満載にする。操作艦がいなければトーストで知らせる。
  private refillShipAmmo(): void {
    const player = this.ship;
    if (player === null || !player.alive) {
      this._hud.hint('操作艦がいないため弾薬を補充できません');
      return;
    }
    player.refillAmmo();
  }

  // 操作艦の RCS 燃料を満タンにする。操作艦がいなければトーストで知らせる。
  private refillShipRcsFuel(): void {
    const player = this.ship;
    if (player === null || !player.alive) {
      this._hud.hint('操作艦がいないためRCS燃料を補充できません');
      return;
    }
    player.refuelFuel(player.totalMaxFuel);
  }

  // shape で選んだ形の敵を1体、自機の前方へ出す。操作艦がいなければトーストで知らせる。
  private spawnManualEnemy(shape: EnemySpawnShape, colorValue: string): void {
    const player = this.ship;
    if (player === null || !player.alive) {
      this._hud.hint('操作艦がいないため敵をスポーンできません');
      return;
    }
    const spawn = this.manualSpawn.enemy(player, shape, colorValue);
    if (spawn !== null) this.spawnEnemyWhenReady(spawn.gate, spawn.build);
  }

  // タンパク質陣形(SPEC COMBAT.md「タンパク質陣形」節)の 3 役を、自機前方に一括スポーンする。
  private spawnProteinFormation(): void {
    const player = this.ship;
    if (player === null || !player.alive) {
      this._hud.hint('操作艦がいないため敵をスポーンできません');
      return;
    }
    for (const { gate, build } of this.manualSpawn.proteinFormation(player)) this.spawnEnemyWhenReady(gate, build);
  }

  // 置くと決まった物体を顔ぶれへ入れ、配置したことをトーストで知らせる。
  private addPlacedObject(placed: PlacedObject): void {
    if (placed.kind === 'player') {
      const ship = this.addPlayer(placed.init);
      this._hud.hint(`${ship.name} を配置`);
      return;
    }
    this._dynamicSystem.add(placed.entity);
    this._hud.hint(`${placed.name} を配置`);
  }

  // ステージ操作パネルは、表示中のビューの右ドックへ追従させる。
  private mountStageControlsPanel(inMapView: boolean): void {
    const root = inMapView ? this._hud.mapRoot : this._hud.combatRoot;
    const rightRail = hudRail(root, 'right');
    if (this.stageControlsPanel.element.parentElement === rightRail) return;
    const vessel = rightRail.querySelector<HTMLElement>('#hud-vessel-status');
    if (vessel !== null) rightRail.insertBefore(this.stageControlsPanel.element, vessel);
    else rightRail.appendChild(this.stageControlsPanel.element);
  }

  // 共通のステータス表示に加えて、ステージ操作パネルと配置プレビューを同期する。
  sync(
    fo: FloatingOrigin, cameraSystem: CameraSystem, displayTime: number,
    visibilityPolicy: MapVisibilityPolicy | null,
  ): void {
    super.sync(fo, cameraSystem, displayTime, visibilityPolicy);
    const ship = this.ship;
    this.stageControlsPanel.setSpawnButtonsEnabled(ship !== null && ship.alive);
    this.mountStageControlsPanel(cameraSystem.view === 'map');
    this.objectPlacement.sync(fo, cameraSystem, displayTime);
    this.stageControlsPanel.element.classList.remove('hidden');
  }

  // 補給の投入と波状攻撃を進める。波状攻撃のトグルが決めるのは新しいウェーブが出るかどうかで、
  // OFF にしても既に出ている敵は残る。
  update(dt: number, simTime: number, simSpeed: SimSpeedManager): void {
    const player = this.ship;
    if (player) {
      this.logistics.updateLogistics(simTime, player, simSpeed, true);
      if (this.waveAttackEnabled) {
        this.waveAttack.update(
          dt, player, this._dynamicSystem.all().filter(isEnemy), simTime, this,
          (enemy) => this.addEnemy(enemy));
      }
    }
  }

  // 'instant' の艦が次に消化するノードの時刻。積分をその時刻ちょうどで切らせるために返す。
  // 待っているノードが1つも無ければ null。
  nextSimulationEventTime(simTime: number): number | null {
    let next: number | null = null;
    for (const ship of this._dynamicSystem.all().filter(isPlayer)) {
      const t = ship.planExecution === 'instant' ? ship.plan.firstNode()?.t : undefined;
      if (t !== undefined && t >= simTime && (next === null || t < next)) next = t;
    }
    return next;
  }

  // ノード時刻ちょうどでノードの絶対状態へ乗り移る。
  applySimulationEvents(simTime: number): void {
    for (const ship of this._dynamicSystem.all().filter(isPlayer)) {
      if (ship.planExecution !== 'instant') continue;
      const node = ship.plan.firstNode();
      if (!node || node.t > simTime + 1e-9) continue;
      // 消化する最後のノードの絶対状態がそのまま到達状態になる(誤差が無い)。
      const nodes = ship.plan.nodes;
      let reached: KinematicState | undefined;
      for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i];
        if (n && n.t <= simTime) { reached = n; break; }
      }
      if (!reached) continue;
      ship.plan.consumeNodesUpTo(simTime, reached);
      ship.state = reached;
    }
  }

  // 勝利条件を持たないモードなので、常に false。
  checkWin(): boolean {
    return false;
  }

  // 艦を喪失したことを、トーストで知らせる。
  recordPlayerLost(reason: string): void {
    this._hud.hint(reason);
  }

  // ステータス表示の副題に出す文字列。
  hudSubStatus(): string {
    return this.waveAttackEnabled ? '波状攻撃: ON' : 'クリエイティブ';
  }

  // このステージが持つ表示物とパネルを片付ける。
  dispose(): void {
    super.dispose();
    this.objectPlacement.dispose();
    this.stageControlsPanel.element.remove();
  }

  // 共通のステージ保存データへ、波状攻撃のトグルと進行状況を足して返す。
  serialize(): CreativeStageSaveData {
    return {
      ...super.serialize(),
      waveAttackEnabled: this.waveAttackEnabled,
      waveAttack: this.waveAttack.serialize(),
    };
  }
}
