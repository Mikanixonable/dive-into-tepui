// クリエイティブモード: 勝敗判定を発生させず、物体配置と軌道計画を自由に試すためのステージ。
import { Stage, type StageDeps, STORY_EPOCH } from './stage';
import { ManualSpawn } from '../creative/manual-spawn';
import { MAX_PLACED_SHIPS, ObjectPlacement } from '../creative/object-placement';
import { StageControlsPanel, type EnemySpawnShape } from '../creative/stage-controls-panel';
import { isEnemy } from '../dynamic/dynamic-entity/enemy';
import { proteinDisplayControllerOf } from '../dynamic/dynamic-entity/enemy-display-capabilities';
import { hudRail } from '../hud/hud-root';
import { isPlayer } from '../player/player';
import { DEFAULT_PROTEIN_DISPLAY, type ProteinDisplaySettings } from '../../render/protein/protein-display';
import { WaveAttack } from './stage-utils/wave-attack';
import type { DynamicEntityKind } from '../dynamic/dynamic-entity/entity-kind';
import type { KinematicState } from '../../physics/kinematic-state';
import type { CameraFrame } from '../../render/camera/camera-frame';
import type { SimSpeedManager } from '../dynamic/sim-speed-manager';
import type { ObjectAuthoring } from '../pickable/inspected-object';
import { creativeStageCommands, type CreativeStageCommands } from './creative-stage-commands';
import type { CreativeStageSaveData, StageSaveData } from '../save/save-data';
import { FREE_PLAY_STAGE_RULES } from './stage-rules';
import { queuedEventSink } from '../run-events';
import type { MarkerDeclaration } from '../../marker/marker-declaration';

export class CreativeStage extends Stage {
  public static readonly id = 'creative' as const;
  public static readonly stageRules = FREE_PLAY_STAGE_RULES;
  public static readonly epoch = STORY_EPOCH;
  // 開始日時の指定画面を挟む(SPEC GAME.md 9.0)。epoch はその欄の既定値になる。
  public static readonly picksStartEpoch = true;
  public static readonly selectLabel = 'CREATIVE';
  public static readonly selectSub = '軌道上に艦艇を自由に配置して眺める';
  public static readonly selectGroup = 'クリエイティブモード';
  public readonly executesPlans = true;
  public readonly authoring: ObjectAuthoring;

  private readonly objectPlacement: ObjectPlacement;
  private readonly manualSpawn: ManualSpawn;
  // 補給の自動投入・敵の波状攻撃を切り替えるトグルを載せたパネル。
  private readonly stageControlsPanel: StageControlsPanel;
  private readonly waveAttack: WaveAttack;
  // 敵の波状攻撃を発生させるかどうか(既定 OFF)。
  private waveAttackEnabled: boolean;
  // パネルの操作を積む先。
  private readonly commands: CreativeStageCommands;

  // ステージ開始時に出すブリーフィングの本文(HTML)。
  protected briefingHtml(): string {
    return '<b>クリエイティブモード</b><br>マップから艦艇を配置して軌道を眺められる。';
  }

  // 配置・手動スポーンとステージ操作パネルを組み、保存データがあればそこから状態を戻す。
  public constructor(saved: StageSaveData | undefined, ...deps: StageDeps) {
    super(saved, ...deps);
    this.commands = creativeStageCommands(this._commandQueue, this);
    const savedCreative = saved as CreativeStageSaveData | undefined;

    // 復元済みのタンパク質の敵がいれば、その表示設定を以後のスポーンにも引き継ぐ。
    const restoredProtein = this._dynamicSystem.all().find((entity) => (
      isEnemy(entity) && proteinDisplayControllerOf(entity) !== null
    ));
    const restoredDisplay = restoredProtein === undefined
      ? DEFAULT_PROTEIN_DISPLAY
      : proteinDisplayControllerOf(restoredProtein)?.display ?? DEFAULT_PROTEIN_DISPLAY;
    this.manualSpawn = new ManualSpawn(
      this._fx, this._scene, this._celestialSystem.celestialMotions,
      this._dynamicSystem, this._dynamicSystem.idAllocators, restoredDisplay,
    );

    // 配置パネルの確定は DOM のイベントなので、そこで起きたことは列を通して記録する(R8)。
    this.objectPlacement = new ObjectPlacement(
      this._hud, this._scene, this._dynamicSystem, this._dynamicSystem.idAllocators,
      queuedEventSink(this._commandQueue, this._dynamicSystem.events),
      this._celestialSystem, this._fx,
    );
    this.objectPlacement.onPlace = (name, entityKind, state) => this.commands.placeObject(name, entityKind, state);
    this.authoring = this.objectPlacement;

    this.waveAttack = new WaveAttack(
      this._dynamicSystem.events, this._fx, this._scene, this._celestialSystem.celestialMotions,
      this._dynamicSystem.idAllocators, savedCreative?.waveAttack,
    );
    this.waveAttackEnabled = savedCreative?.waveAttackEnabled ?? false;
    this.stageControlsPanel = new StageControlsPanel(
      this.logistics.resupplyEnabled, this.logistics.rcsFuelResupplyEnabled, this.waveAttackEnabled,
      this.manualSpawn.spawnDistance, this.manualSpawn.display,
    );
    this.stageControlsPanel.onToggleResupply = (on) => this.commands.setResupplyEnabled(on);
    this.stageControlsPanel.onToggleFuelResupply = (on) => this.commands.setFuelResupplyEnabled(on);
    this.stageControlsPanel.onToggleWaveAttack = (on) => this.commands.setWaveAttackEnabled(on);
    this.stageControlsPanel.onAddMagazine = () => this.commands.addMagazineToShip();
    this.stageControlsPanel.onRefillFuel = () => this.commands.refillShipRcsFuel();
    this.stageControlsPanel.onSpawnDistanceChange = (distance) => this.commands.setSpawnDistance(distance);
    this.stageControlsPanel.onSpawnEnemy = (shape, colorValue) => this.commands.spawnManualEnemy(shape, colorValue);
    this.stageControlsPanel.onSpawnFormation = () => this.commands.spawnProteinFormation();
    this.stageControlsPanel.onProteinDisplayChange = (display) => this.commands.setProteinDisplay(display);
    hudRail(this._hud.mapRoot, 'right').appendChild(this.stageControlsPanel.element);

    this.begin();
  }

  // 弾薬の自動投入の可否を切り替える。
  public setResupplyEnabled(on: boolean): void {
    this.logistics.resupplyEnabled = on;
  }

  // RCS燃料の自動投入の可否を切り替える。
  public setFuelResupplyEnabled(on: boolean): void {
    this.logistics.rcsFuelResupplyEnabled = on;
  }

  // 敵の波状攻撃の可否を切り替える。
  public setWaveAttackEnabled(on: boolean): void {
    this.waveAttackEnabled = on;
  }

  // 手動スポーンが使う距離 [m] を差し替える。
  public setSpawnDistance(distanceM: number): void {
    this.manualSpawn.spawnDistance = distanceM;
  }

  // 以後のスポーンと、出ているタンパク質の敵すべてへ、選ばれた表示設定を渡す。
  public setProteinDisplay(display: ProteinDisplaySettings): void {
    this.manualSpawn.display = display;
    for (const entity of this._dynamicSystem.all()) {
      if (isEnemy(entity)) proteinDisplayControllerOf(entity)?.setDisplay(display);
    }
  }

  // 操作艦の弾薬チェーンへマガジンを1つ追加する。操作艦がいなければ、操作艦が要ることを記録する。
  public addMagazineToShip(): void {
    const player = this.ship;
    if (player === null || !player.motion.alive) {
      this._dynamicSystem.events.record({ kind: 'shipRequiredForAction', action: 'addMagazine' });
      return;
    }
    player.onPickup(1);
  }

  // 操作艦の RCS 燃料を満タンにする。操作艦がいなければ、操作艦が要ることを記録する。
  public refillShipRcsFuel(): void {
    const player = this.ship;
    if (player === null || !player.motion.alive) {
      this._dynamicSystem.events.record({ kind: 'shipRequiredForAction', action: 'refillRcsFuel' });
      return;
    }
    player.refuelFuel(player.totalMaxFuel);
  }

  // shape で選んだ形の敵を1体、自機の前方へ出す。操作艦がいなければ、操作艦が要ることを記録する。
  public spawnManualEnemy(shape: EnemySpawnShape, colorValue: string): void {
    const player = this.ship;
    if (player === null || !player.motion.alive) {
      this._dynamicSystem.events.record({ kind: 'shipRequiredForAction', action: 'spawnEnemy' });
      return;
    }
    const spawn = this.manualSpawn.enemy(player, shape, colorValue);
    if (spawn !== null) this.spawnEnemyWhenReady(spawn.gate, spawn.build);
  }

  // タンパク質陣形(SPEC COMBAT.md「タンパク質陣形」節)の 3 役を、自機前方に一括スポーンする。
  public spawnProteinFormation(): void {
    const player = this.ship;
    if (player === null || !player.motion.alive) {
      this._dynamicSystem.events.record({ kind: 'shipRequiredForAction', action: 'spawnEnemy' });
      return;
    }
    for (const { gate, build } of this.manualSpawn.proteinFormation(player)) this.spawnEnemyWhenReady(gate, build);
  }

  // 検証を通った配置の指定から物体を作り、顔ぶれへ入れて、配置したことを記録する。
  // 自機の隻数が上限に達していれば、作らずに返る(SPEC GAME.md 9.1)。
  public placeObject(name: string, entityKind: DynamicEntityKind, state: KinematicState): void {
    if (entityKind === 'player'
      && this._dynamicSystem.all().filter(isPlayer).length >= MAX_PLACED_SHIPS) return;
    const placed = this.objectPlacement.createObject(name, entityKind, state);
    if (placed.kind === 'player') {
      const ship = this.addPlayer(placed.placement);
      this._dynamicSystem.events.record({ kind: 'objectPlaced', name: ship.name });
      return;
    }
    this._dynamicSystem.add(placed.entity);
    this._dynamicSystem.events.record({ kind: 'objectPlaced', name: placed.entity.name });
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
  public sync(
    camera: CameraFrame, displayTime: number,
  ): void {
    super.sync(camera, displayTime);
    const ship = this.ship;
    this.stageControlsPanel.setSpawnButtonsEnabled(ship !== null && ship.motion.alive);
    this.mountStageControlsPanel(camera.mode === 'map');
    this.objectPlacement.sync(camera, displayTime);
    this.stageControlsPanel.element.classList.remove('hidden');
  }

  public override get markerDeclarations(): readonly MarkerDeclaration[] {
    return this.objectPlacement.markerDeclarations;
  }

  // 補給の投入と波状攻撃を進める。波状攻撃のトグルが決めるのは新しいウェーブが出るかどうかで、
  // OFF にしても既に出ている敵は残る。
  public update(dt: number, simTime: number, simSpeed: SimSpeedManager): void {
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

  // 'instant' の艦が次に消化するノードの時刻。待っているノードが1つも無ければ null。
  public nextSimulationEventTime(simTime: number): number | null {
    let next: number | null = null;
    for (const ship of this._dynamicSystem.all().filter(isPlayer)) {
      const t = ship.planExecution === 'instant' ? ship.plan.firstNode()?.t : undefined;
      if (t !== undefined && t >= simTime && (next === null || t < next)) next = t;
    }
    return next;
  }

  // ノード時刻ちょうどでノードの絶対状態へ乗り移る。
  public applySimulationEvents(simTime: number): void {
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
      ship.motion.state = reached;
    }
  }

  // 勝利条件を持たないモードなので、常に false。
  protected checkWin(): boolean {
    return false;
  }

  // 艦の喪失を、決着させずに知らせるだけで済ませる。
  public recordPlayerLost(reason: string): void {
    this._dynamicSystem.events.record({ kind: 'shipLost', reason });
  }

  // ステータス表示の副題に出す文字列。
  protected hudSubStatus(): string {
    return this.waveAttackEnabled ? '波状攻撃: ON' : 'クリエイティブ';
  }

  // このステージが持つ表示物とパネルを片付ける。
  public dispose(): void {
    super.dispose();
    this.objectPlacement.dispose();
    this.stageControlsPanel.element.remove();
  }

  // 共通のステージ保存データへ、波状攻撃のトグルと進行状況を足して返す。
  public serialize(): CreativeStageSaveData {
    return {
      ...super.serialize(),
      waveAttackEnabled: this.waveAttackEnabled,
      waveAttack: this.waveAttack.serialize(),
    };
  }
}
