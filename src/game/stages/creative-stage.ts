// クリエイティブモード: 物体配置と軌道計画を自由に試すための、勝利条件の無いステージ。
import { Stage, type CommonStageState, type SerializedStage, type StageDeps, STORY_EPOCH } from './stage';
import { ManualSpawn, type SerializedManualSpawn } from '../creative/manual-spawn';
import {
  ObjectPlacement, reachesPlacedShipLimit, type SerializedObjectPlacement,
} from '../creative/object-placement';
import type { ObjectPlacementSelection } from '../creative/object-placer-panel';
import {
  StageControlsPanel, type EnemySpawnShape, type ProteinDisplayControl,
} from '../creative/stage-controls-panel';
import { isEnemy } from '../dynamic/dynamic-entity/enemy';
import { hudRail } from '../hud/hud-root';
import { isModularShip } from '../ship/modular-ship';
import { WaveAttack, type SerializedWaveAttack } from './stage-utils/wave-attack';
import { creativeStageCommands, type CreativeStageCommands } from './creative-stage-commands';
import { FREE_PLAY_STAGE_RULES } from './stage-rules';
import { queuedEventSink, type RunEventSink } from '../run-events';
import type { KinematicState } from '../../physics/kinematic-state';
import type { CameraFrame } from '../../render/camera/camera-frame';
import type { SimSpeedManager } from '../dynamic/sim-speed-manager';
import type { ObjectAuthoring } from '../pickable/inspected-object';
import type { MarkerDeclaration } from '../../marker/marker-declaration';
import type { ViewMode } from '../view/view-mode';

// クリエイティブモードの内訳。波状攻撃のトグルと進行状態を持ち、進行状態はトグルが OFF の間も
// 保つ(ON に戻したとき波数を続きから再開する)。手動スポーンと物体配置の設定・連番も持つ。
export interface SerializedCreativeStage extends SerializedStage {
  readonly waveAttackEnabled: boolean;
  readonly waveAttack: SerializedWaveAttack;
  readonly manualSpawn: SerializedManualSpawn;
  readonly objectPlacement: SerializedObjectPlacement;
}

// 配置が記録する出来事の行き先。配置パネルの確定は DOM のイベントなので、列を通して記録する(R8)。
function placementEventSink(deps: StageDeps): RunEventSink {
  const [, , dynamicSystem, , , commandQueue] = deps;
  return queuedEventSink(commandQueue, dynamicSystem.events);
}

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
  public readonly proteinDisplayControl: ProteinDisplayControl;

  private readonly objectPlacement: ObjectPlacement;
  private readonly manualSpawn: ManualSpawn;
  // 補給の自動投入・敵の波状攻撃のトグルと、手動スポーンの操作を載せたパネル。
  private readonly stageControlsPanel: StageControlsPanel;
  private readonly waveAttack: WaveAttack;
  // パネルの操作を積む先。
  private readonly commands: CreativeStageCommands;

  // ステージ開始時に出すブリーフィングの本文(HTML)。
  protected briefingHtml(): string {
    return '<b>クリエイティブモード</b><br>マップから艦艇を配置して軌道を眺められる。';
  }

  // 波状攻撃の進行・トグル、手動スポーン、配置した自機の id の連番と共通の状態から組む。省いたものは
  // 新しいランの初期値から始まる。
  private constructor(
    deps: StageDeps,
    waveAttack?: WaveAttack,
    // 敵の波状攻撃を発生させるかどうか。
    private waveAttackEnabled = false,
    manualSpawn?: ManualSpawn,
    placedPlayerIdCounter?: number,
    ...common: CommonStageState
  ) {
    super(deps, ...common);
    this.commands = creativeStageCommands(this._commandQueue, this);

    // 手動スポーン・配置・波状攻撃。配置の確定は命令として積む。
    this.manualSpawn = manualSpawn ?? ManualSpawn.create(
      this._scene, this._celestialSystem.celestialMotions, this._dynamicSystem.idAllocators,
    );

    this.objectPlacement = new ObjectPlacement(
      this._hud, this._scene, this._dynamicSystem, this._dynamicSystem.idAllocators,
      placementEventSink(deps), this._celestialSystem, this.commands, placedPlayerIdCounter,
    );
    this.authoring = this.objectPlacement;

    this.waveAttack = waveAttack ?? new WaveAttack(
      this._dynamicSystem.events, this._scene, this._celestialSystem.celestialMotions,
      this._dynamicSystem.idAllocators,
    );
    // ステージ操作パネル。操作は命令として積む。
    this.stageControlsPanel = new StageControlsPanel(
      this.logistics.resupplyEnabled, this.logistics.rcsFuelResupplyEnabled, this.waveAttackEnabled,
      this.manualSpawn.spawnDistance,
    );
    this.proteinDisplayControl = this.stageControlsPanel;
    this.stageControlsPanel.onToggleResupply = (on) => this.commands.setResupplyEnabled(on);
    this.stageControlsPanel.onToggleFuelResupply = (on) => this.commands.setFuelResupplyEnabled(on);
    this.stageControlsPanel.onToggleWaveAttack = (on) => this.commands.setWaveAttackEnabled(on);
    this.stageControlsPanel.onAddMagazine = () => this.commands.addMagazineToShip();
    this.stageControlsPanel.onRefillFuel = () => this.commands.refillShipRcsFuel();
    this.stageControlsPanel.onSpawnDistanceChange = (distance) => this.commands.setSpawnDistance(distance);
    this.stageControlsPanel.onSpawnEnemy = (shape, colorValue) => this.commands.spawnManualEnemy(shape, colorValue);
    this.stageControlsPanel.onSpawnFormation = () => this.commands.spawnProteinFormation();
    hudRail(this._hud.mapRoot, 'right').appendChild(this.stageControlsPanel.element);
  }

  // 新しいランのステージを組む。
  public static create(...deps: StageDeps): CreativeStage {
    const stage = new CreativeStage(deps);
    stage.composeBriefing();
    return stage;
  }

  // 直列化した形から復元する。
  public static deserialize(serialized: SerializedCreativeStage | null, ...deps: StageDeps): CreativeStage {
    const [, scene, dynamicSystem, celestialSystem] = deps;
    const waveAttack = serialized?.waveAttack;
    const manualSpawn = serialized?.manualSpawn;
    return new CreativeStage(
      deps,
      // null も欠けと同じく新しいランの初期値から始める(既定引数は undefined でしか働かない)。
      waveAttack == null ? undefined : WaveAttack.deserialize(
        waveAttack, dynamicSystem.events, scene, celestialSystem.celestialMotions, dynamicSystem.idAllocators,
      ),
      serialized?.waveAttackEnabled ?? undefined,
      manualSpawn == null ? undefined : ManualSpawn.deserialize(
        manualSpawn, scene, celestialSystem.celestialMotions, dynamicSystem.idAllocators,
      ),
      serialized?.objectPlacement?.playerIdAllocator ?? undefined,
      ...Stage.deserializeCommonState(serialized, deps, CreativeStage.stageRules),
    );
  }

  // 弾薬の自動投入の可否を切り替える。
  public setResupplyEnabled(on: boolean): void {
    this.logistics.setResupplyEnabled(on);
  }

  // RCS燃料の自動投入の可否を切り替える。
  public setFuelResupplyEnabled(on: boolean): void {
    this.logistics.setFuelResupplyEnabled(on);
  }

  // 敵の波状攻撃の可否を切り替える。
  public setWaveAttackEnabled(on: boolean): void {
    this.waveAttackEnabled = on;
  }

  // 手動スポーンが使う距離 [m] を差し替える。
  public setSpawnDistance(distanceM: number): void {
    this.manualSpawn.setSpawnDistance(distanceM);
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
    player.refuelRcsFuel(player.totalMaxRcsFuel);
  }

  // shape で選んだ形の敵を1体、自機の前方へ出す。操作艦がいなければ、操作艦が要ることを記録する。
  public spawnManualEnemy(shape: EnemySpawnShape, colorValue: string): void {
    const player = this.ship;
    if (player === null || !player.motion.alive) {
      this._dynamicSystem.events.record({ kind: 'shipRequiredForAction', action: 'spawnEnemy' });
      return;
    }
    const spawn = this.manualSpawn.enemy(player, shape, colorValue);
    if (spawn === null) return;
    if (spawn.kind === 'enemy') this.addEnemy(spawn.enemy);
    else this.addProteinEnemy(spawn.request);
  }

  // タンパク質陣形(SPEC COMBAT.md「タンパク質陣形」節)の 3 役を、自機前方に一括スポーンする。
  public spawnProteinFormation(): void {
    const player = this.ship;
    if (player === null || !player.motion.alive) {
      this._dynamicSystem.events.record({ kind: 'shipRequiredForAction', action: 'spawnEnemy' });
      return;
    }
    for (const request of this.manualSpawn.proteinFormation(player)) this.addProteinEnemy(request);
  }

  // 検証を通過した配置指定からオブジェクトを生成し、システムへ追加して配置を記録する。
  // 自機の隻数が上限に達していれば、作らずに返る(SPEC GAME.md 9.1)。
  public placeObject(name: string, selection: ObjectPlacementSelection, state: KinematicState): void {
    if (reachesPlacedShipLimit(
      selection, this._dynamicSystem.all().filter(isModularShip).length,
    )) return;
    // 自機は配置指定から艦として配置し、それ以外は生成した実体をそのままシステムへ追加する。
    const placed = this.objectPlacement.createObject(name, selection, state);
    if (placed.kind === 'ship') {
      const ship = this.addPlayer(placed.init);
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
    camera: CameraFrame, view: ViewMode, displayTime: number,
  ): void {
    super.sync(camera, view, displayTime);
    const ship = this.ship;
    this.stageControlsPanel.setSpawnButtonsEnabled(ship !== null && ship.motion.alive);
    this.mountStageControlsPanel(view === 'map');
    this.objectPlacement.sync(camera, view, displayTime);
    this.stageControlsPanel.element.classList.remove('hidden');
  }

  // 直近の sync が組んだ、配置プレビューのマーカーの宣言。
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
        this.waveAttack.update(dt, player, this._dynamicSystem.all().filter(isEnemy), simTime, this);
      }
    }
  }

  // 'instant' の艦が次に消化するノードの時刻。待っているノードが1つも無ければ null。
  public nextSimulationEventTime(simTime: number): number | null {
    let next: number | null = null;
    for (const ship of this._dynamicSystem.all().filter(isModularShip)) {
      const t = ship.instantNodeTime;
      if (t !== null && t >= simTime && (next === null || t < next)) next = t;
    }
    return next;
  }

  // ノード時刻ちょうどでノードの絶対状態へ乗り移る。
  public applySimulationEvents(simTime: number): void {
    for (const ship of this._dynamicSystem.all().filter(isModularShip)) ship.executeInstantNodesUpTo(simTime);
  }

  // 勝利条件を持たないモードなので、常に false。
  protected checkWin(): boolean {
    return false;
  }

  // 艦の喪失を出来事として記録する。
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

  // 共通の内訳へ、波状攻撃のトグルと進行状況、手動スポーンと配置を足して直列化する。
  public serialize(): SerializedCreativeStage {
    return {
      ...super.serialize(),
      waveAttackEnabled: this.waveAttackEnabled,
      waveAttack: this.waveAttack.serialize(),
      manualSpawn: this.manualSpawn.serialize(),
      objectPlacement: this.objectPlacement.serialize(),
    };
  }
}
