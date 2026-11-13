// 全ステージ共通の骨格。撃破数による勝利判定・常時解放・HUD補助表示なしを既定実装として持ち、
// 必要なステージだけ override する。
import { isModularShip, ModularShip, type ModularShipInit } from '../ship/modular-ship';
import { dropMagsOf, Logistics, type SerializedLogistics } from './stage-utils/logistics';
import { ScoreCounter, type SerializedScoreCounter } from './stage-utils/score-counter';
import { StatusPanel } from './stage-utils/status-panel';
import { loadEphemerisPoints } from '../../physics/ephemeris/catalog';
import { profileAtOrNull } from '../../physics/ephemeris/profile';
import { calendarDateToJulianDate, parseCalendarDate, type TdbJulianDate } from '../../physics/time';
import { addPrimaryRelative, kinematicState, type KinematicState } from '../../physics/kinematic-state';
import { v3 } from '../../math/vec3';
import { solarSystem } from '../celestial/solar-system/solar-system';
import { CAMPAIGN_STAGE_RULES, type StageRules } from './stage-rules';
import {
  crossedSalvageMilestones, nextSalvageMilestoneRemaining, nextSalvageRemaining, SALVAGE_REPEAT_EVERY,
  salvageGranted, type SalvageKind,
} from '../ship/salvage-blueprints';
import { SalvageCargo } from './stage-utils/salvage-cargo';
import type { ShipBlueprintShelf } from '../ship/ship-blueprint';
import type * as THREE from 'three/webgpu';
import type { Enemy } from '../dynamic/dynamic-entity/enemy';
import type { HudLayers } from '../hud/hud-layers';
import type { SimSpeedManager } from '../dynamic/sim-speed-manager';
import type { CameraFrame } from '../../render/camera/camera-frame';
import type { MarkerDeclaration } from '../../marker/marker-declaration';
import type { ObjectAuthoring } from '../pickable/inspected-object';
import type { ProteinDisplayControl } from '../creative/stage-controls-panel';
import type { EnemyDeathCause, PlayerLossCause, StageOutcome } from './stage-outcome';
import { ENEMY_MAX_ATTACKERS_PER_GROUP } from '../dynamic/dynamic-entity/enemy-fire-controller';
import type { StageSimulationEvents } from './stage-simulation-events';
import type { ControlSelection } from '../control-selection';
import type { CommandQueue } from '../command-queue';
import type { CelestialSystem } from '../celestial/celestial-system';
import type { EntityRoster } from '../dynamic/entity-roster';
import type { EntityRegistry } from '../dynamic/entity-registry';
import type { OrbitSlotRegistry } from '../navigation/orbit-slot-registry';
import type { ProteinEnemyRequest } from '../dynamic/dynamic-entity/protein-enemy';
import type { ViewMode } from '../view/view-mode';

// 作中の日時。遠未来 UTC は定義できないため、天体力学では TDB として解釈する。ステージの epoch の
// 宣言以外から読まない(元期は共有の定数ではなく、ステージの宣言)。
export const STORY_EPOCH: TdbJulianDate =
  calendarDateToJulianDate(parseCalendarDate('20115-05-14T06:00:00', 'TDB'));

export type StageId = '00' | '0' | '1' | '2' | 'creative' | 'debug' | 'debug-alt-system' | 'debug-load';

// 状態を指定せずに置く自機の既定の円軌道。高度は中心天体の表面半径から、傾斜角は中心天体の
// 中心に置いた ECI 軸の Y から測る。
const PLAYER_INITIAL_ALT = 420e3; // [m]
const PLAYER_INITIAL_INC_DEG = 97.0; // [deg]

// 全ステージ共通の協力者。create・deserialize が受け、基底のコンストラクタへそのまま渡す。
export type StageDeps = [
  hud: HudLayers,
  scene: THREE.Scene,
  dynamicSystem: EntityRegistry & EntityRoster,
  celestialSystem: CelestialSystem,
  controlSelection: ControlSelection,
  commandQueue: CommandQueue,
  orbitSlots: OrbitSlotRegistry,
  // セーブスロットの設計図の棚の読み取り面。鹵獲の授与が既に棚にある同名を除くために読む。
  blueprintShelf: ShipBlueprintShelf,
];

// 全ステージ共通の状態(スコア・決着状態・補給)。基底のコンストラクタが deps の後ろに受け、
// 省いたものは新しいランの初期値から始まる。
export type CommonStageState = [
  scoreCounter?: ScoreCounter, phase?: GamePhase, logistics?: Logistics, reinforced?: boolean,
  salvageCargo?: SalvageCargo,
];

// ステージクラスの静的側。起動時の設定はここから読む。
export interface StageClass {
  readonly id: StageId;
  readonly stageRules: StageRules;
  createCelestialSystem(
    epoch: TdbJulianDate, onProgress?: (ratio: number) => void, renderer?: THREE.WebGPURenderer,
  ): Promise<CelestialSystem>;
  // simTime=0 に置く絶対時刻。**基底に既定値は無く、全ステージが自分で宣言する** —
  // 置くと宣言し忘れが型検査に落ちなくなり、元期が共有の定数へ静かに戻る。
  readonly epoch: TdbJulianDate;
  // 開始前にプレイヤーへ開始日時を選ばせるか(GAME.md 9.0)。選ばせないステージは epoch で始まる。
  readonly picksStartEpoch: boolean;
  // 選択画面が読む項目。
  readonly selectLabel: string;
  readonly selectSub: string;
  readonly selectLockedSub: string | undefined;
  // 行に出し、押されたら選ぶキー。持たないステージは null(SPEC GAME.md 1)。
  readonly selectKey: string | null;
  readonly selectGroup: string;
  readonly hiddenFromSelect: boolean;
  isUnlocked(clearCounts: ClearCounts): boolean;
  // 新しいランのステージを組み、初期配置を置く。
  create(...deps: StageDeps): Stage;
  // このステージクラスが直列化した形 serialized から復元する。記録が欠けていれば(null)、
  // 新しいランの初期値で補う。
  deserialize(serialized: SerializedStage | null, ...deps: StageDeps): Stage;
}

// ステージ ID → クリア回数(周回数によるアンロックに備えて、クリアの有無でなく回数で持つ)。
export type ClearCounts = Readonly<Record<string, number>>;

export type GamePhase = 'playing' | 'won' | 'lost' | 'timeup';

// 全ステージ共通の内訳(スコア・決着状態・補給タイマー)。ステージ固有の内訳は、これを拡張した
// 型に持つ。
export interface SerializedStage {
  readonly scoreCounter: SerializedScoreCounter;
  readonly phase: GamePhase;
  readonly logistics: SerializedLogistics;
  // 援護付きの再出撃か。古い記録には無いので欠けは援護なしとして読む。
  readonly reinforced?: boolean;
  // 補給艇で届けていない積荷。欠けた記録は空の待ち行列から始まる。
  readonly pendingSalvageCargo?: readonly SalvageKind[];
}

// 1周回の成績。撃破・命中・生存の値を結果画面と記録の両方が読む。
export interface RunStats {
  readonly kills: number;
  readonly appeared: number; // 戦場に現れた敵の数
  readonly shots: number;
  readonly hits: number;
  readonly survivalSec: number; // シミュレーション時間 [s]
}

// 決着した周回の結果画面に出す内容。stats と lossCause は、ステージが決着を記録したときだけ持つ
// (セーブに含まれない結果の代わりには null)。
export interface StageResult {
  readonly win: boolean;
  // 結果画面の見出し。null なら勝敗から決まる既定の見出し。
  readonly title: string | null;
  readonly detailHtml: string;
  readonly stats: RunStats | null;
  // 敗北の原因。勝利と原因の無い決着では null。
  readonly lossCause: PlayerLossCause | null;
}

// 周回の始め方で決まる選択。再出撃のたびに launcher が決めて、周回を組むときに渡す。
export interface RunOptions {
  // 援護付きの再出撃か(→ applyRunOptions)。
  readonly reinforced: boolean;
  // 連敗の予告を出すか。予告を持つステージだけが読む。
  readonly forecast: boolean;
}

// 原因ごとの次の一手の助言。結果画面の敗北の本文に一行で添える。
const LOSS_ADVICE: Readonly<Record<PlayerLossCause, string>> = {
  surface: '次は降下の角度を先に見る — 近地点が地表へ届いていないかを、交戦の前に確かめる',
  structural: '次は濃い大気の中で速度を落としすぎない — 動圧は速度の二乗で効く',
  heatSaturated: '次は加熱が始まったら、射撃より先に姿勢と速度を下げる',
  heatOverload: '次は連射の前に排熱の余裕を見る',
};

// 生存時間を T+ の時分秒で書く。
export function missionTimeText(seconds: number): string {
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m ${Math.floor(seconds % 60)}s`;
}

// 撃破・命中・生存の要約。勝敗に関わらず結果画面の本文に同じ形で出す。
export function summaryHtml(stats: RunStats): string {
  const rate = stats.appeared > 0 ? (stats.kills / stats.appeared) * 100 : 0;
  const accuracy = stats.shots > 0 ? (stats.hits / stats.shots) * 100 : 0;
  const perKill = stats.kills > 0 ? (stats.shots / stats.kills).toFixed(1) : '—';
  return (
    `撃破 ${stats.kills}/${stats.appeared} 機（撃破率 ${rate.toFixed(0)}%）<br>` +
    `命中率 ${accuracy.toFixed(1)}%（${stats.hits}/${stats.shots} 発）・撃破あたり ${perKill} 発<br>` +
    `生存時間 T+ ${missionTimeText(stats.survivalSec)}`
  );
}

export abstract class Stage implements StageOutcome, StageSimulationEvents {
  public static readonly stageRules = CAMPAIGN_STAGE_RULES;
  // 起動時に1度だけ組む星系。既定は現実の太陽系で、元期(simTime=0 が指す絶対時刻)が
  // 近未来/遠未来いずれかの数値暦の期間に入っていれば暦パックを読み込み、どちらにも
  // 入らなければ CELESTIAL.md 2.2 のとおり解析暦だけで組む。
  public static async createCelestialSystem(
    epoch: TdbJulianDate, onProgress?: (ratio: number) => void, renderer?: THREE.WebGPURenderer,
  ): Promise<CelestialSystem> {
    const profile = profileAtOrNull(epoch.value);
    const ephemerisPoints = profile === null ? null : await loadEphemerisPoints(
      profile.id, epoch, profile.validEndJdTdb, onProgress,
    );
    return solarSystem('earth', ephemerisPoints, epoch, renderer);
  }
  // 選択画面でロック中に出す説明。指定が無ければ selectSub をそのまま出す。
  public static readonly selectLockedSub: string | undefined = undefined;
  // タイトルのステージ選択ボタン列から隠すか。既定では並べる。
  public static readonly hiddenFromSelect: boolean = false;
  // ショートカットキーを持たない。持つステージだけが宣言する。
  public static readonly selectKey: string | null = null;
  // 開始前に開始日時の指定画面を挟まない。挟むステージだけが true を宣言する。
  public static readonly picksStartEpoch: boolean = false;
  // 選択画面でこのステージを並べるタブの名前。
  public static readonly selectGroup: string = 'ステージモード';

  // このステージが解放済みかどうかをクリア回数から判定する。既定では常に解放。
  public static isUnlocked(_clearCounts: ClearCounts): boolean {
    return true;
  }

  // 自身のクラス。起動時の静的宣言はここから読む。
  public get stageClass(): StageClass {
    return this.constructor as unknown as StageClass;
  }
  public get id(): StageId { return this.stageClass.id; }
  public get stageRules(): StageRules { return this.stageClass.stageRules; }

  // 艦の軌道計画を自動実行させるか。既定では実行しない。
  public readonly executesPlans: boolean = false;
  // オブジェクトの配置・複製に対応するステージは自身の編集口を返す。既定では非対応。
  public readonly authoring: ObjectAuthoring | null = null;
  // タンパク質の表示形態と着色を選ぶ UI を持つステージはそれを差し出す。既定では持たない。
  public readonly proteinDisplayControl: ProteinDisplayControl | null = null;

  protected readonly logistics: Logistics;
  private readonly statusPanel: StatusPanel;

  protected readonly _hud: HudLayers;
  protected readonly _scene: THREE.Scene;
  protected readonly _dynamicSystem: EntityRegistry & EntityRoster;
  protected readonly _celestialSystem: CelestialSystem;
  protected readonly _controlSelection: ControlSelection;
  // モデル層の外から届いた書き換えを積む先。ステージ固有の命令の口はここへ積む。
  protected readonly _commandQueue: CommandQueue;
  // このランの軌道標識の台帳。
  protected readonly _orbitSlots: OrbitSlotRegistry;
  // セーブスロットの設計図の棚の読み取り面。鹵獲の授与の重複判定にだけ読む。
  private readonly blueprintShelf: ShipBlueprintShelf;
  // このランで授与を記録した鹵獲の設計図名。棚への書き戻しはランの外で遅れて行われるので、
  // ランの中ではこの控えで重複授与を防ぐ。
  private readonly grantedSalvageNames = new Set<string>();
  // まだ補給艇で届けていない積荷(SPEC GAME.md 2.3)。
  protected readonly salvageCargo: SalvageCargo;

  public get phase(): GamePhase { return this._phase; }
  public get isPlaying(): boolean { return this._phase === 'playing'; }
  // 敵の射撃を許しているか。射撃の可否を切り替えるステージが上書きする。
  public get enemiesMayFire(): boolean { return true; }
  private _result: StageResult | null = null;
  public get result(): StageResult | null { return this._result; }
  // 勝敗と結果画面の内容を同時に確定させ、確定したことを出来事として記録する。
  protected decide(phase: Exclude<GamePhase, 'playing'>, result: StageResult): void {
    this._phase = phase;
    this._result = result;
    this._dynamicSystem.events.record({ kind: 'stageDecided' });
  }
  // 協力者 deps と全ステージ共通の状態から組む。省いた状態は新しいランの初期値(スコア 0・進行中・
  // 補給タイマー未経過)から始まる。固有の状態を持つ具象ステージは、自分の分を deps の直後に受け、
  // 共通の状態を末尾で受けてここへ渡す。
  protected constructor(
    deps: StageDeps,
    public readonly scoreCounter = new ScoreCounter(),
    private _phase: GamePhase = 'playing',
    logistics?: Logistics,
    private _reinforced = false,
    salvageCargo?: SalvageCargo,
  ) {
    const [hud, scene, dynamicSystem, celestialSystem, controlSelection, commandQueue, orbitSlots, blueprintShelf] = deps;
    this._hud = hud;
    this._scene = scene;
    this._dynamicSystem = dynamicSystem;
    this._celestialSystem = celestialSystem;
    this._controlSelection = controlSelection;
    this._commandQueue = commandQueue;
    this._orbitSlots = orbitSlots;
    this.blueprintShelf = blueprintShelf;
    this.logistics = logistics ?? new Logistics(scene, dynamicSystem, this.stageRules.automaticResupply);
    this.salvageCargo = salvageCargo ?? new SalvageCargo();
    this.statusPanel = new StatusPanel(hud.combatRoot);
  }

  // 直列化した共通の内訳 serialized から、全ステージ共通の状態を戻す。具象の deserialize が自分の
  // コンストラクタの末尾へ渡す。rules はそのステージクラスの規則。
  protected static deserializeCommonState(
    serialized: SerializedStage | null, deps: StageDeps, rules: StageRules,
  ): CommonStageState {
    const [, scene, dynamicSystem] = deps;
    const scoreCounter = serialized?.scoreCounter;
    const phase = serialized?.phase;
    const logistics = serialized?.logistics;
    const reinforced = serialized?.reinforced;
    // null も欠けと同じく新しいランの初期値から始める(既定引数は undefined でしか働かない)。
    return [
      scoreCounter == null ? undefined : ScoreCounter.deserialize(scoreCounter),
      phase ?? undefined,
      logistics == null
        ? undefined
        : Logistics.deserialize(logistics, scene, dynamicSystem, rules.automaticResupply),
      reinforced ?? undefined,
      SalvageCargo.deserialize(serialized?.pendingSalvageCargo ?? null),
    ];
  }

  private _briefing: string | null = null;

  // 新規開始のランで1度だけ出すブリーフィングの本文(HTML)。復元したランでは null。
  public get briefing(): string | null { return this._briefing; }

  // ブリーフィングの本文を、いまの状態から組む。新しいランのステージで、初期配置を終えた後に1度だけ呼ぶ。
  protected composeBriefing(): void {
    this._briefing = this.briefingHtml();
  }

  // ステージ固有の UI(トグル等)をステータスウィンドウ左部へ追加する。
  protected addStatusPanelWidget(el: HTMLElement): void {
    this.statusPanel.appendLeftWidget(el);
  }

  // ステータスパネルを同期する。
  public sync(
    _camera: CameraFrame, view: ViewMode, _displayTime: number,
  ): void {
    this.syncStatusPanel(view === 'map');
  }

  // 直近の sync が組んだ、このステージ固有のマーカーの宣言。
  public get markerDeclarations(): readonly MarkerDeclaration[] { return []; }

  // hudSubStatus() が null のとき、またはマップビューのときはパネルを畳む。
  private syncStatusPanel(mapView: boolean): void {
    const message = this.hudSubStatus();
    const show = message !== null && !mapView;
    const salvageRemaining = this.salvageRemaining();
    this.statusPanel.sync(show ? this.ship : null, message ?? '', this.scoreCounter.kills, salvageRemaining);
  }

  // 台本が相手にする自艦。操作対象が基地でも台本は止まらないので、そのときは生存中の先頭の艦を使う。
  protected get ship(): ModularShip | null {
    const controlled = this._controlSelection.current;
    if (controlled instanceof ModularShip) return controlled;
    return this._dynamicSystem.all().filter(isModularShip).find((ship) => ship.motion.alive) ?? null;
  }

  // 自機を1隻置き、操作対象が居なければそれを操作対象にする。state を省いた新規配置は
  // 既定の円軌道(defaultPlayerState)に置き、機首と上面はその位置で最も強く引く天体を基準に向ける。
  protected addPlayer(init: ModularShipInit = {}): ModularShip {
    const state = init.state ?? this.defaultPlayerState();
    const ship = ModularShip.create({ ...init, state }, this._dynamicSystem, this._scene);
    this._dynamicSystem.add(ship);
    this._controlSelection.claimIfNone(ship);
    return ship;
  }

  // 状態を指定しない自機の、いまの simTime における既定の状態: ECI 原点の天体を回る、
  // 高度 PLAYER_INITIAL_ALT・傾斜角 PLAYER_INITIAL_INC_DEG の円軌道上。
  private defaultPlayerState(): KinematicState {
    const t = this._dynamicSystem.simTime;
    const center = this._celestialSystem.origin.motion;
    const radius = center.def.radius + PLAYER_INITIAL_ALT;
    const speed = Math.sqrt(center.def.mu / radius);
    const inc = (PLAYER_INITIAL_INC_DEG * Math.PI) / 180;
    const rel = kinematicState<'primaryRel'>(
      t, v3(radius, 0, 0), v3(0, speed * Math.sin(inc), -speed * Math.cos(inc)),
    );
    return addPrimaryRelative(center.stateAt(t), rel);
  }

  // 自機の発砲を1発数える。
  public recordShot(): void {
    this.scoreCounter.recordShot();
  }

  // 敵への命中を1発数える。
  public recordHit(): void {
    this.scoreCounter.recordHit();
  }

  // 敵を登録し、出撃数をスコアへ記録する。
  public addEnemy(enemy: Enemy): void {
    this._dynamicSystem.add(enemy);
    this.scoreCounter.recordSpawnEnemy();
  }

  // タンパク質の敵を要求し、出撃数をスコアへ記録する。敵はアセットが揃い次第実体化する。
  public addProteinEnemy(request: ProteinEnemyRequest): void {
    this._dynamicSystem.spawnWhenReady({ kind: 'protein-enemy', request });
    this.scoreCounter.recordSpawnEnemy();
  }

  // 戦場に現れた敵の数。アセットを待つ敵は、実体化した時点から数える(SPEC/PROTEIN.md「出現」節)。
  public get enemiesAppeared(): number {
    return this.scoreCounter.totalEnemiesSpawned - this._dynamicSystem.pendingEnemyCount;
  }

  // ステージごとのブリーフィングの本文(HTML)。初期配置を終えた状態から組む。
  protected abstract briefingHtml(): string;
  // 毎フレーム呼ぶ。台本が相手にする自艦は this.ship から引く。
  public abstract update(dt: number, simTime: number, simSpeed: SimSpeedManager): void;

  // 時刻に固定したイベントの、次の時刻(無ければ null)と、その時刻に達したときの適用。既定ではイベントを持たない。
  public nextSimulationEventTime(_simTime: number): number | null { return null; }
  public applySimulationEvents(_simTime: number): void { }

  // 残存敵数が 0 以下なら勝利。
  protected checkWin(): boolean {
    return this.enemiesAppeared - this.scoreCounter.kills - this.scoreCounter.losses <= 0;
  }
  // 決着を「勝利」で確定させる。
  protected onWin(_simTime: number): void {
    const stats = this.runStats;
    this.decide('won', { win: true, title: null, detailHtml: summaryHtml(stats), stats, lossCause: null });
  }

  // いまの周回の成績。生存時間は自機が生きていた時間ではなく、周回の開始からのシミュレーション時間。
  public get runStats(): RunStats {
    const { shots, hits, kills } = this.scoreCounter;
    return {
      kills, appeared: this.enemiesAppeared, shots, hits, survivalSec: this._dynamicSystem.simTime,
    };
  }

  // 同じ攻撃グループで同時に発砲してよい敵の数。援護付きの周回では 1 つ減る(1 を下回らない)。
  public get enemyAttackLimit(): number {
    return Math.max(1, ENEMY_MAX_ATTACKERS_PER_GROUP - (this._reinforced ? 1 : 0));
  }

  // 再出撃のときの選択を、周回を始める前に当てる。省いた選択は既定のまま。
  public applyRunOptions(options: RunOptions): void {
    this._reinforced = options.reinforced;
  }

  // 交戦中の集団が 0 になった波間に、積まれた鹵獲を補給艇で届ける。既定では届けない(SPEC GAME.md 2.3)。
  public onLull(): boolean {
    return false;
  }

  // ステータスパネルに表示する補助メッセージ。既定では非表示(null)。
  protected hudSubStatus(): string | null {
    return null;
  }

  // 敵1体の消滅を原因ごとに数えて記録する。撃破では敵機の位置へ弾薬補給を1個放出する。
  // 撃破以外の消滅でも、残存数が 0 になれば勝利で決着させる。
  public recordEnemyDeath(enemy: Enemy, simTime: number, cause: EnemyDeathCause = 'killed'): void {
    if (cause === 'killed') {
      const killsBefore = this.scoreCounter.kills;
      this.scoreCounter.recordKill();
      this.logistics.dropAt(enemy.motion.state, this.ship?.motion.state ?? null, dropMagsOf(enemy.formationRole));
      this.grantSalvageBlueprints(killsBefore);
    } else {
      this.scoreCounter.recordEnemyLoss();
    }
    this._dynamicSystem.events.record({ kind: 'enemyDied', name: enemy.name, cause });

    // isPlaying ガード: 敗北後に残存敵が再突入で消えても勝利判定が上書きしないよう。
    if (this.isPlaying && this.checkWin()) this.onWin(simTime);
  }

  // 撃破数が跨いだ節目の鹵獲を授与する(SPEC GAME.md 3.1)。授与はラン内で毎回記録し、補給艇のある
  // ステージでは積荷の待ち行列へ積む。設計図棚へは同名が無いときだけ書く。鹵獲を数えないステージでは
  // 記録しない。
  private grantSalvageBlueprints(killsBefore: number): void {
    const rules = this.stageRules;
    if (!rules.salvageRewards) return;
    const repeatEvery = rules.salvageTender ? SALVAGE_REPEAT_EVERY : null;
    for (const milestone of crossedSalvageMilestones(killsBefore, this.scoreCounter.kills, repeatEvery)) {
      this._dynamicSystem.events.record({ kind: 'salvageAwarded', name: milestone.name });
      if (rules.salvageTender) this.salvageCargo.add(milestone.kind);
      if (salvageGranted(milestone.name, this.grantedSalvageNames, this.blueprintShelf)) continue;
      this.grantedSalvageNames.add(milestone.name);
      this._dynamicSystem.events.record({ kind: 'salvageBlueprintGranted', name: milestone.name });
    }
  }

  // HUD に出す次の鹵獲までの残り撃破数(SPEC GAME.md 3.1)。鹵獲を数えないステージでは出さない。
  // 補給艇のあるステージでは、このランでまだ越えていない次の節目までを出す。
  private salvageRemaining(): number | null {
    const rules = this.stageRules;
    if (!rules.salvageRewards) return null;
    if (rules.salvageTender) return nextSalvageMilestoneRemaining(this.scoreCounter.kills, SALVAGE_REPEAT_EVERY);
    return nextSalvageRemaining(this.scoreCounter.kills, this.grantedSalvageNames, this.blueprintShelf);
  }

  // 敗北を記録し、reason と原因に応じた助言を添えて決着を「敗北」で確定させる。
  public recordPlayerLost(reason: string, cause: PlayerLossCause): void {
    // isPlaying ガード: 勝利後に自機が再突入しても敗北で上書きしないよう。
    if (!this.isPlaying) return;
    const stats = this.runStats;
    this.decide('lost', {
      win: false,
      title: null,
      detailHtml: `${reason}<br>${summaryHtml(stats)}<br>${LOSS_ADVICE[cause]}`,
      stats,
      lossCause: cause,
    });
  }

  // statusPanel を片付ける。自前の DOM/シーンオブジェクトを持つ具象ステージは
  // super.dispose() を呼んでから続きを片付ける。
  public dispose(): void {
    this.statusPanel.dispose();
  }

  // スコア・決着状態・補給タイマーを直列化した形へ変換する。固有の内訳を持つ具象ステージは
  // これを拡張した戻り値型で override する。
  public serialize(): SerializedStage {
    return {
      scoreCounter: this.scoreCounter.serialize(),
      phase: this._phase,
      logistics: this.logistics.serialize(),
      reinforced: this._reinforced,
      pendingSalvageCargo: this.salvageCargo.serialize(),
    };
  }
}
