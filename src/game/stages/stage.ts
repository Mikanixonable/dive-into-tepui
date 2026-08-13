// 全ステージ共通の骨格。撃破数による勝利判定・常時解放・HUD補助表示なしを既定実装として持ち、
// 必要なステージだけ override する。
import * as THREE from 'three/webgpu';
import { Enemy } from '../game-entity/enemy';
import { Player, type PlayerInit } from '../player/player';
import { Logistics } from './stage-utils/logistics';
import { ScoreCounter } from './stage-utils/score-counter';
import { StageStatusPanel } from './stage-utils/stage-status-panel';
import { EffectsSystem } from '../vfx/effects-system';
import { Hud } from '../hud/hud';
import { Sfx } from '../../audio/sfx';
import { showResultScreen, showWinScreen } from '../hud/result-screen';
import type { ClearCounts, UnlockManager } from '../unlock-manager';
import type { EntityManager } from '../simulation/entity-manager';
import type { Input } from '../input/input';
import { KEY_MAPPING as K } from '../input/key-mapping';
import { SimSpeedManager } from '../sim-speed-manager';
import type { ProjectFn, ScaleFn } from '../camera/camera-system';
import type { FloatingOrigin } from '../floating-origin';
import type { MarkerManager } from '../marker/marker-manager';
import type { Ephemeris } from '../../physics/ephemeris';
import type { Simulator } from '../simulation/simulator';
import type { StageSaveData } from '../save-data';
import type { MapVisibilityPolicy } from '../celestial/map-visibility';
import type { ObjectType } from '../creative/ship-placer-panel';
import type { KinematicState } from '../../physics/kinematic-state';
import type { ActivePlayerController } from '../active-player-controller';
import type { CelestialRegistry } from '../../physics/solar-system';
import type { AttractorId } from '../../physics/attractor';

export type StageId = '00' | '0' | '1' | '2' | 'creative' | 'debug' | 'debug-alt-system' | 'debug-load';

const BRIEFING_TOAST_MS = 12000;

// Ephemeris のコンストラクタ3引数をそのまま束ねた静的宣言。省略したステージは既定の
// レジストリ・地球原点のまま動く。
export type EphemerisConfig = {
  readonly registry: CelestialRegistry;
  readonly originId: AttractorId;
  readonly epochOffsetSec: number;
};

// 全ステージ共通の生成引数(セーブデータを除く)。具象ステージは自分のコンストラクタで
// これをそのまま基底へ渡す。
export type StageDeps = [
  hud: Hud,
  sfx: Sfx,
  scene: THREE.Scene,
  entities: EntityManager,
  unlockManager: UnlockManager,
  fx: EffectsSystem,
  markerManager: MarkerManager,
  ephemeris: Ephemeris,
  simulator: Simulator,
  activePlayers: ActivePlayerController,
];

// ステージクラスの静的側。起動時の設定はここから読む。
export interface StageClass {
  readonly id: StageId;
  readonly ephemerisConfig: EphemerisConfig | undefined;
  // 選択画面が読む項目。
  readonly selectLabel: string;
  readonly selectSub: string;
  readonly selectLockedSub: string | undefined;
  readonly selectKeys: readonly string[];
  readonly selectGroup: string;
  readonly hiddenFromSelect: boolean;
  isUnlocked(clearCounts: ClearCounts): boolean;
  new (saved: StageSaveData | undefined, ...deps: StageDeps): Stage;
}

// 軌道上へオブジェクトを配置・複製する編集機能。これを持つステージだけがマップの
// 「配置」「複製」項目を出す。focusId はマップの現在フォーカスで、基準天体の初期選択に使う。
export interface ObjectAuthoring {
  openShipPlacer(focusId?: string): void;
  openShipPlacerForDuplicate(objectType: ObjectType, state: KinematicState): void;
}

export type GamePhase = 'playing' | 'won' | 'lost' | 'timeup';

export abstract class Stage {
  // 固有の天体暦を使うステージだけが宣言する。既定のレジストリ・地球原点で構築される。
  static readonly ephemerisConfig: EphemerisConfig | undefined = undefined;
  // 選択画面でロック中に出す説明。指定が無ければ selectSub をそのまま出す。
  static readonly selectLockedSub: string | undefined = undefined;
  // タイトルのステージ選択ボタン列に並べない。
  static readonly hiddenFromSelect: boolean = false;
  // 選択画面でこのステージを並べるタブの名前。表示のまとまりだけを決め、挙動には影響しない。
  static readonly selectGroup: string = 'ステージモード';

  // このステージが解放済みかどうかをクリア回数から判定する。既定では常に解放。
  static isUnlocked(_clearCounts: ClearCounts): boolean {
    return true;
  }

  // 自身のクラス。起動時の静的宣言はここから読む。
  get stageClass(): StageClass {
    return this.constructor as unknown as StageClass;
  }
  get id(): StageId { return this.stageClass.id; }

  // ドックでの購入・修理・燃料補給を無償にするか。既定では通貨を消費する。
  readonly freeProcurement: boolean = false;
  // 艦の軌道計画を PlanExecutor / 瞬間移動で実行させるか。既定では実行しない。
  readonly executesPlans: boolean = false;
  // オブジェクトの配置・複製に対応するステージは自身の編集口を返す。既定では非対応。
  readonly authoring: ObjectAuthoring | null = null;

  readonly scoreCounter: ScoreCounter;
  protected readonly logistics: Logistics;
  private readonly statusPanel: StageStatusPanel;

  protected readonly _hud: Hud;
  protected readonly _sfx: Sfx;
  protected readonly _scene: THREE.Scene;
  protected readonly _fx: EffectsSystem;
  protected readonly _unlockManager: UnlockManager;
  protected readonly _entities: EntityManager;
  protected readonly _markerManager: MarkerManager;
  protected readonly _ephemeris: Ephemeris;
  protected readonly _simulator: Simulator;
  protected readonly _activePlayers: ActivePlayerController;

  private _phase: GamePhase;
  get phase(): GamePhase { return this._phase; }
  get isPlaying(): boolean { return this._phase === 'playing'; }
  protected setPhase(phase: GamePhase): void { this._phase = phase; }
  private readonly restored: boolean;

  // saved が undefined ならスナップショットからの再開ではない新規開始で、スコア0・進行中・
  // 補給タイマー未経過から始まり begin() が初期配置を行う。固有の内訳を持つ具象ステージは
  // 自分のコンストラクタで super(saved, ...deps) を呼んでから自分の分を組み立て、末尾で begin() を呼ぶ。
  constructor(saved: StageSaveData | undefined, ...deps: StageDeps) {
    const [hud, sfx, scene, entities, unlockManager, fx, markerManager, ephemeris, simulator, activePlayers] = deps;
    this._hud = hud;
    this._sfx = sfx;
    this._scene = scene;
    this._unlockManager = unlockManager;
    this._fx = fx;
    this._entities = entities;
    this._markerManager = markerManager;
    this._ephemeris = ephemeris;
    this._simulator = simulator;
    this._activePlayers = activePlayers;
    this.scoreCounter = new ScoreCounter(saved?.scoreCounter);
    this._phase = saved?.phase ?? 'playing';
    this.restored = saved !== undefined;
    this.logistics = new Logistics(hud, sfx, scene, entities, markerManager, saved?.logistics);
    this.statusPanel = new StageStatusPanel(hud.layers.panel);
  }

  // 新規開始なら初期配置・ブリーフィングを行う。具象ステージは自分のコンストラクタの
  // 末尾で必ずこれを呼ぶ — 初期配置は具象側のフィールドが揃ってからでないと走らせられない。
  protected begin(): void {
    if (this.restored) return;
    this.init(this._entities);
    this._hud.toast(this.briefingHtml(), BRIEFING_TOAST_MS);
  }

  // ステージ固有の UI(トグル等)をステータスウィンドウ左部へ追加する。
  protected addStatusPanelWidget(el: HTMLElement): void {
    this.statusPanel.appendLeftWidget(el);
  }

  // 決着後の [R] で再出撃。プレイ中は素通しする。
  handleInput(input: Input): void {
    if (this.isPlaying) return;
    if (input.takeKey(K.restart)) this.restart();
  }

  // ?stage= を明示して replace する: 素のリロードでは選択画面へ戻るため。
  private restart(): void {
    location.replace(`${location.pathname}?stage=${this.id}`);
  }

  // ステータスパネルを同期する。fo・project・scale・displayTime・camera は配置プレビューなど
  // ステージ固有の描画物を持つサブクラスが使う。
  sync(
    player: Player | null, _fo: FloatingOrigin, _project: ProjectFn, _scale: ScaleFn, _displayTime: number,
    overviewMode: boolean, _visibilityPolicy: MapVisibilityPolicy | null, _camera: THREE.Camera,
  ): void {
    this.syncStatusPanel(player, overviewMode);
  }

  // hudSubStatus() が null のとき、またはマップ視点のときはパネルを畳む。
  private syncStatusPanel(player: Player | null, overviewMode: boolean): void {
    const message = this.hudSubStatus();
    const show = message !== null && !overviewMode;
    this.statusPanel.sync(show ? player : null, message ?? '', this.scoreCounter.kills);
  }

  // 自機を1隻置き、操作対象が居なければそれを操作対象にする。艦の隻数は0..n隻が一般形で、
  // 何隻をどこへ置くかはステージ自身の宣言。
  protected addPlayer(init?: PlayerInit): Player {
    const ship = new Player(this._hud, this._sfx, this._scene, this._fx, this._markerManager, init);
    this._entities.addPlayer(ship);
    this._activePlayers.claimIfNone(ship);
    return ship;
  }

  // 敵を entities へ登録し、出撃数をスコアへ記録する。
  protected addEnemy(enemy: Enemy, entities: EntityManager): void {
    entities.addEnemy(enemy);
    this.scoreCounter.recordSpawnEnemy();
  }

  // 生存中の敵全てに AI 行動を1フレーム分実行させる。
  protected behaveAllEnemies(dt: number, player: Player, entities: EntityManager, simTime: number, simSpeed: SimSpeedManager): void {
    for (const e of entities.enemies) {
      if (e.alive) e.behave(dt, simTime, player, entities, simSpeed, this._ephemeris);
    }
  }

  abstract briefingHtml(): string;
  // 初期配置。既定では何も置かない。
  protected init(_entities: EntityManager): void { }
  // 毎フレーム呼ぶ。艦が1隻も無い間は player が null になる。
  abstract update(dt: number, player: Player | null, entities: EntityManager, simTime: number, simSpeed: SimSpeedManager): void;

  // Simulator がsubstepをイベント直前で切るためのhook。通常ステージには時刻固定イベントがない。
  nextSimulationEventTime(_simTime: number): number | null { return null; }
  applySimulationEvents(_simTime: number): void { }

  // 残存敵数が 0 以下なら勝利。
  checkWin(): boolean {
    return this.scoreCounter.totalEnemiesSpawned - this.scoreCounter.kills - this.scoreCounter.losses <= 0;
  }
  // 勝利画面を表示する。
  onWin(simTime: number): void {
    showWinScreen(this._sfx, this.scoreCounter, this.scoreCounter.totalEnemiesSpawned, simTime);
  }

  // ステータスパネルに表示する補助メッセージ。既定では非表示(null)。
  hudSubStatus(): string | null {
    return null;
  }

  // 原因によらず勝利判定を通す: 再突入・離脱でも残存数 0 なら決着させる。
  recordEnemyDeath(enemy: Enemy, simTime: number, cause: 'killed' | 'reentry' | 'despawn' = 'killed'): void {
    if (cause === 'killed') {
      this.scoreCounter.recordKill();
      this._hud.hint(`${enemy.name} 撃破`);
    } else {
      this.scoreCounter.recordEnemyLoss();
      this._hud.hint(`${enemy.name} ${cause === 'reentry' ? '再突入により喪失' : '交戦圏を離脱'}`);
    }

    // isPlaying ガード: 敗北後に残存敵が再突入で消えても勝利判定が上書きしないよう。
    if (this.isPlaying && this.checkWin()) {
      this.setPhase('won');
      this._unlockManager.reportClear(this.id, this._hud);
      this.onWin(simTime);
    }
  }

  // 敗北を記録し、reason を添えて敗北画面を表示する。
  recordPlayerLost(reason: string): void {
    // isPlaying ガード: 勝利後に自機が再突入しても敗北で上書きしないよう。
    if (!this.isPlaying) return;
    this.setPhase('lost');
    showResultScreen(this._sfx, false, `${reason}<br>撃破 ${this.scoreCounter.kills}/${this.scoreCounter.totalEnemiesSpawned} 機`);
  }

  // スコア・決着状態・補給タイマーをセーブデータへ変換する。固有の内訳を持つ具象ステージは
  // これを拡張した戻り値型で override する。
  serialize(): StageSaveData {
    return {
      scoreCounter: this.scoreCounter.serialize(),
      phase: this._phase,
      logistics: this.logistics.serialize(),
    };
  }
}
