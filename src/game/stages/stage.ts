// 全ステージ共通の骨格。撃破数による勝利判定・常時解放・HUD補助表示なしを既定実装として持ち、
// 必要なステージだけ override する。
import * as THREE from 'three/webgpu';
import { Enemy } from '../dynamic/dynamic-entity/enemy';
import type { ProteinAssetId } from '../protein/protein-asset-loader';
import { Player, type PlayerInit } from '../player/player';
import { Logistics } from './stage-utils/logistics';
import { ScoreCounter } from './stage-utils/score-counter';
import { StatusPanel } from './stage-utils/status-panel';
import { EffectsSystem } from '../vfx/effects-system';
import { Hud } from '../hud/hud';
import { WorldSfx } from '../../audio/sfx/world-sfx';
import { UiSfx } from '../../audio/sfx/ui-sfx';
import type { ClearCounts, UnlockManager } from '../unlock-manager';
import type { DynamicSystem } from '../dynamic/dynamic-system';
import { SimSpeedManager } from '../dynamic/sim-speed-manager';
import type { CameraSystem } from '../camera/camera-system';
import type { FloatingOrigin } from '../camera/floating-origin';
import type { MarkerManager } from '../marker/marker-manager';
import type { Simulator } from '../dynamic/simulator';
import type { StageSaveData } from '../save/save-data';
import type { MapVisibilityPolicy } from '../map/visibility-policy';
import type { ObjectType } from '../creative/object-placer-panel';
import type { KinematicState } from '../../physics/kinematic-state';
import type { ActivePlayerController } from '../active-controllable-controller';
import { loadAbsoluteEphemeris } from '../../physics/ephemeris-catalog';
import { profileAtOrNull } from '../../physics/ephemeris-profile';
import { SIM_EPOCH_ET, SIM_EPOCH_JD_TDB } from '../sim-epoch';
import { solarSystem } from '../celestial/solar-system/solar-system';
import type { CelestialSystem } from '../celestial/celestial-system';
import type { PhaseOffsets } from '../../physics/celestial-motion';

export type StageId = '00' | '0' | '1' | '2' | 'creative' | 'debug' | 'debug-alt-system' | 'debug-load';

// 敵が失われた理由。'killed' 以外は自然損耗で、撃破数ではなく喪失数へ数える。
// 焼失(大気)と衝突(固体表面)は別の現象なので分けて持つ。
export type EnemyDeathCause = 'killed' | 'burnup' | 'collision' | 'despawn';

// 自然損耗の理由ごとのヒント文。Record にすることで、cause を足したときに文言の
// 追加漏れが型検査で落ちる(三項演算子では黙って既定の文言に落ちていた)。
const ENEMY_LOSS_HINT: Record<Exclude<EnemyDeathCause, 'killed'>, string> = {
  burnup: '大気圏で焼失',
  collision: '天体へ衝突',
  despawn: '交戦圏を離脱',
};

const BRIEFING_TOAST_MS = 12000;

// 全ステージ共通の生成引数(セーブデータを除く)。具象ステージは自分のコンストラクタで
// これをそのまま基底へ渡す。
export type StageDeps = [
  hud: Hud,
  worldSfx: WorldSfx,
  uiSfx: UiSfx,
  scene: THREE.Scene,
  entities: DynamicSystem,
  unlockManager: UnlockManager,
  fx: EffectsSystem,
  markerManager: MarkerManager,
  celestialSystem: CelestialSystem,
  simulator: Simulator,
  activePlayers: ActivePlayerController,
];

// ステージクラスの静的側。起動時の設定はここから読む。
export interface StageClass {
  readonly id: StageId;
  createCelestialSystem(
    phaseOffsets: PhaseOffsets, earthSpinPhase0: number, onProgress?: (ratio: number) => void,
    startSimTime?: number,
  ): Promise<CelestialSystem>;
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
  openObjectPlacer(focusId?: string): void;
  openObjectPlacerForDuplicate(objectType: ObjectType, state: KinematicState): void;
}

export type GamePhase = 'playing' | 'won' | 'lost' | 'timeup';

// 決着した周回の結果画面に出す内容。
export type StageResult = {
  readonly win: boolean;
  // 勝敗から決まる既定の見出しに収まらないときだけ差し替える。
  readonly title: string | null;
  readonly detailHtml: string;
};

export abstract class Stage {
  // 起動時に1度だけ組む星系。既定は現実の太陽系で、開始時刻(startSimTime、省略時は
  // ゲーム既定のエポック)が近未来/遠未来いずれかの高精度期間に入っていれば精密暦パックを
  // 読み込み、どちらにも入らなければ CELESTIAL.md 2.2 のとおり解析暦だけで組む。
  public static async createCelestialSystem(
    phaseOffsets: PhaseOffsets, earthSpinPhase0: number, onProgress?: (ratio: number) => void,
    startSimTime = 0,
  ): Promise<CelestialSystem> {
    const startJdTdb = SIM_EPOCH_JD_TDB + startSimTime / 86400;
    const profile = profileAtOrNull(startJdTdb);
    const pack = profile === null ? null : await loadAbsoluteEphemeris(
      profile.id, profile.validStartJdTdb, profile.validEndJdTdb, onProgress,
    );
    return solarSystem('earth', phaseOffsets, earthSpinPhase0, pack, SIM_EPOCH_ET, SIM_EPOCH_JD_TDB);
  }
  // 選択画面でロック中に出す説明。指定が無ければ selectSub をそのまま出す。
  public static readonly selectLockedSub: string | undefined = undefined;
  // タイトルのステージ選択ボタン列に並べない。
  public static readonly hiddenFromSelect: boolean = false;
  // 選択画面でこのステージを並べるタブの名前。表示のまとまりだけを決め、挙動には影響しない。
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

  // ドックでの購入・修理・燃料補給を無償にするか。既定では通貨を消費する。
  public readonly freeProcurement: boolean = false;
  // 艦の軌道計画を自動実行させるか。既定では実行しない。
  public readonly executesPlans: boolean = false;
  // オブジェクトの配置・複製に対応するステージは自身の編集口を返す。既定では非対応。
  public readonly authoring: ObjectAuthoring | null = null;

  public readonly scoreCounter: ScoreCounter;
  protected readonly logistics: Logistics;
  private readonly statusPanel: StatusPanel;

  protected readonly _hud: Hud;
  protected readonly _worldSfx: WorldSfx;
  protected readonly _uiSfx: UiSfx;
  protected readonly _scene: THREE.Scene;
  protected readonly _fx: EffectsSystem;
  protected readonly _unlockManager: UnlockManager;
  protected readonly _entities: DynamicSystem;
  protected readonly _markerManager: MarkerManager;
  protected readonly _celestialSystem: CelestialSystem;
  protected readonly _simulator: Simulator;
  protected readonly _activePlayers: ActivePlayerController;

  private _phase: GamePhase;
  public get phase(): GamePhase { return this._phase; }
  public get isPlaying(): boolean { return this._phase === 'playing'; }
  private _result: StageResult | null = null;
  public get result(): StageResult | null { return this._result; }
  // 勝敗と結果画面の内容を同時に確定させる。表示は呼び出し側(Launcher)の役目。
  protected decide(phase: Exclude<GamePhase, 'playing'>, result: StageResult): void {
    this._phase = phase;
    this._result = result;
  }
  private readonly restored: boolean;

  // saved が undefined ならスナップショットからの再開ではない新規開始で、スコア0・進行中・
  // 補給タイマー未経過から始まり begin() が初期配置を行う。固有の内訳を持つ具象ステージは
  // 自分のコンストラクタで super(saved, ...deps) を呼んでから自分の分を組み立て、末尾で begin() を呼ぶ。
  protected constructor(saved: StageSaveData | undefined, ...deps: StageDeps) {
    const [hud, worldSfx, uiSfx, scene, entities, unlockManager, fx, markerManager, celestialSystem, simulator, activePlayers] = deps;
    this._hud = hud;
    this._worldSfx = worldSfx;
    this._uiSfx = uiSfx;
    this._scene = scene;
    this._unlockManager = unlockManager;
    this._fx = fx;
    this._entities = entities;
    this._markerManager = markerManager;
    this._celestialSystem = celestialSystem;
    this._simulator = simulator;
    this._activePlayers = activePlayers;
    this.scoreCounter = new ScoreCounter(saved?.scoreCounter);
    this._phase = saved?.phase ?? 'playing';
    this.restored = saved !== undefined;
    this.logistics = new Logistics(hud, worldSfx, uiSfx, scene, entities, saved?.logistics);
    this.statusPanel = new StatusPanel(hud.combatRoot);
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

  // ステータスパネルを同期する。fo・displayTime・visibilityPolicy は配置プレビューなど
  // ステージ固有の描画物を持つサブクラスが使う。
  public sync(
    player: Player | null, _fo: FloatingOrigin, cameraSystem: CameraSystem, _displayTime: number,
    _visibilityPolicy: MapVisibilityPolicy | null,
  ): void {
    this.syncStatusPanel(player, cameraSystem.overviewMode);
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
    const ship = new Player(this._hud, this._worldSfx, this._scene, this._fx, this._markerManager, init);
    this._entities.addPlayer(ship);
    this._activePlayers.claimIfNone(ship);
    return ship;
  }

  // 敵を entities へ登録し、出撃数をスコアへ記録する。
  protected addEnemy(enemy: Enemy, entities: DynamicSystem): void {
    entities.addEnemy(enemy);
    this.scoreCounter.recordSpawnEnemy();
  }

  // タンパク質アセットの fetch 待ちで実体化を遅らせうる敵を登録する。準備が整い次第
  // entities へ登録され、そのときに出撃数をスコアへ記録する(SPEC/PROTEIN.md「出現」節)。
  protected spawnEnemyWhenReady(assetId: ProteinAssetId | null, build: () => Enemy, entities: DynamicSystem): void {
    entities.spawnEnemyWhenReady(assetId, build, () => this.scoreCounter.recordSpawnEnemy());
  }

  // 生存中の敵全てに AI 行動を1フレーム分実行させる。
  protected behaveAllEnemies(player: Player, entities: DynamicSystem, simTime: number, simSpeed: SimSpeedManager): void {
    for (const e of entities.enemies) {
      if (e.alive) e.behave(simTime, player, entities, simSpeed, this._celestialSystem);
    }
  }

  protected abstract briefingHtml(): string;
  // 初期配置。既定では何も置かない。
  protected init(_entities: DynamicSystem): void { }
  // 毎フレーム呼ぶ。艦が1隻も無い間は player が null になる。
  public abstract update(dt: number, player: Player | null, entities: DynamicSystem, simTime: number, simSpeed: SimSpeedManager): void;

  // Simulator がsubstepをイベント直前で切るためのhook。通常ステージには時刻固定イベントがない。
  public nextSimulationEventTime(_simTime: number): number | null { return null; }
  public applySimulationEvents(_simTime: number): void { }

  // 残存敵数が 0 以下なら勝利。
  protected checkWin(): boolean {
    return this.scoreCounter.totalEnemiesSpawned - this.scoreCounter.kills - this.scoreCounter.losses <= 0;
  }
  // 決着を「勝利」で確定させる。
  protected onWin(simTime: number): void {
    this.decide('won', {
      win: true,
      title: null,
      detailHtml: winDetailHtml(this.scoreCounter, this.scoreCounter.totalEnemiesSpawned, simTime),
    });
  }

  // ステータスパネルに表示する補助メッセージ。既定では非表示(null)。
  protected hudSubStatus(): string | null {
    return null;
  }

  // 原因によらず勝利判定を通す: 再突入・離脱でも残存数 0 なら決着させる。
  public recordEnemyDeath(enemy: Enemy, simTime: number, cause: EnemyDeathCause = 'killed'): void {
    if (cause === 'killed') {
      this.scoreCounter.recordKill();
      this._hud.hint(`${enemy.name} 撃破`);
    } else {
      this.scoreCounter.recordEnemyLoss();
      this._hud.hint(`${enemy.name} ${ENEMY_LOSS_HINT[cause]}`);
    }

    // isPlaying ガード: 敗北後に残存敵が再突入で消えても勝利判定が上書きしないよう。
    if (this.isPlaying && this.checkWin()) {
      this._unlockManager.reportClear(this.id, this._hud);
      this.onWin(simTime);
    }
  }

  // 敗北を記録し、reason を添えて決着を「敗北」で確定させる。
  public recordPlayerLost(reason: string): void {
    // isPlaying ガード: 勝利後に自機が再突入しても敗北で上書きしないよう。
    if (!this.isPlaying) return;
    this.decide('lost', {
      win: false,
      title: null,
      detailHtml: `${reason}<br>撃破 ${this.scoreCounter.kills}/${this.scoreCounter.totalEnemiesSpawned} 機`,
    });
  }

  // statusPanel を片付ける。自前の DOM/シーンオブジェクトを持つ具象ステージは
  // super.dispose() を呼んでから続きを片付ける。
  public dispose(): void {
    this.statusPanel.dispose();
  }

  // スコア・決着状態・補給タイマーをセーブデータへ変換する。固有の内訳を持つ具象ステージは
  // これを拡張した戻り値型で override する。
  public serialize(): StageSaveData {
    return {
      scoreCounter: this.scoreCounter.serialize(),
      phase: this._phase,
      logistics: this.logistics.serialize(),
    };
  }
}

// 全機撃破・ミッション時間・命中率をまとめた勝利画面の本文。
function winDetailHtml(scoreCounter: ScoreCounter, totalEnemies: number, simTime: number): string {
  const { shots, hits } = scoreCounter;
  const acc = shots > 0 ? ((hits / shots) * 100).toFixed(1) : '0.0';
  return (
    `全 ${totalEnemies} 機撃破<br>` +
    `ミッション時間 T+ ${Math.floor(simTime / 3600)}h ${Math.floor((simTime % 3600) / 60)}m ${Math.floor(simTime % 60)}s<br>` +
    `発射 ${shots} 発 / 命中 ${hits} 発 (命中率 ${acc}%)`
  );
}
