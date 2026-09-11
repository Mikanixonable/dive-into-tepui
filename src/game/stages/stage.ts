// 全ステージ共通の骨格。撃破数による勝利判定・常時解放・HUD補助表示なしを既定実装として持ち、
// 必要なステージだけ override する。
import * as THREE from 'three/webgpu';
import { Enemy } from '../dynamic/dynamic-entity/enemy';
import { isPlayer, Player, type PlayerInit } from '../player/player';
import { Logistics } from './stage-utils/logistics';
import { ScoreCounter } from './stage-utils/score-counter';
import { StatusPanel } from './stage-utils/status-panel';
import { FlashEffects } from '../vfx/flash-effects';
import type { HudLayers } from '../hud/hud-layers';
import type { Notifier } from '../../hud/notifier';
import { WorldSfx } from '../../audio/sfx/world-sfx';
import { UiSfx } from '../../audio/sfx/ui-sfx';
import { SimSpeedManager } from '../dynamic/sim-speed-manager';
import type { CameraFrame } from '../../render/camera/camera-frame';
import type { MarkerSlots } from '../marker/marker-slots';
import type { StageSaveData } from '../save/save-data';
import type { ObjectAuthoring } from '../pickable/inspected-object';
import type { EnemyDeathCause, StageOutcome } from './stage-outcome';
import type { StageSimulationEvents } from './stage-simulation-events';
import type { ControlSelection } from '../control-selection';
import { loadEphemerisPoints } from '../../physics/ephemeris/catalog';
import { profileAtOrNull } from '../../physics/ephemeris/profile';
import { calendarDateToJulianDate, parseCalendarDate, TdbJulianDate } from '../../physics/time';
import { solarSystem } from '../celestial/solar-system/solar-system';
import type { CelestialSystem } from '../celestial/celestial-system';
import type { PhaseOffsets } from '../../physics/celestial-body-def';
import type { EntityRoster } from '../dynamic/entity-roster';
import type { EntityRegistry, SpawnGate } from '../dynamic/entity-registry';

// 作中の日時。遠未来 UTC は定義できないため、天体力学では TDB として解釈する。各ステージが
// 自分の epoch としてこれを宣言する — ステージに別の日時を与えるのはその1行を変えるだけ。
// **この定数を stage.ts の外から import しない**(元期は共有の定数ではなく、ステージの宣言)。
export const STORY_EPOCH: TdbJulianDate =
  calendarDateToJulianDate(parseCalendarDate('20115-05-14T06:00:00', 'TDB'));

export type StageId = '00' | '0' | '1' | '2' | 'creative' | 'debug' | 'debug-alt-system' | 'debug-load';

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
  hud: HudLayers & Notifier,
  worldSfx: WorldSfx,
  uiSfx: UiSfx,
  scene: THREE.Scene,
  dynamicSystem: EntityRegistry & EntityRoster,
  fx: FlashEffects,
  markers: MarkerSlots,
  celestialSystem: CelestialSystem,
  controlSelection: ControlSelection,
];

// ステージクラスの静的側。起動時の設定はここから読む。
export interface StageClass {
  readonly id: StageId;
  createCelestialSystem(
    phaseOffsets: PhaseOffsets, earthSpinPhase0: number, epoch: TdbJulianDate,
    onProgress?: (ratio: number) => void, renderer?: THREE.WebGPURenderer,
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
  readonly selectKeys: readonly string[];
  readonly selectGroup: string;
  readonly hiddenFromSelect: boolean;
  isUnlocked(clearCounts: ClearCounts): boolean;
  new (saved: StageSaveData | undefined, ...deps: StageDeps): Stage;
}

// ステージ ID → クリア回数。将来の拡張(周回数によるアンロック等)を見越して、
// 「クリアしたか否か」ではなく回数を記録する。
export type ClearCounts = Readonly<Record<string, number>>;

export type GamePhase = 'playing' | 'won' | 'lost' | 'timeup';

// 決着した周回の結果画面に出す内容。
export interface StageResult {
  readonly win: boolean;
  // 勝敗から決まる既定の見出しに収まらないときだけ差し替える。
  readonly title: string | null;
  readonly detailHtml: string;
}

export abstract class Stage implements StageOutcome, StageSimulationEvents {
  // 起動時に1度だけ組む星系。既定は現実の太陽系で、元期(simTime=0 が指す絶対時刻)が
  // 近未来/遠未来いずれかの数値暦の期間に入っていれば暦パックを読み込み、どちらにも
  // 入らなければ CELESTIAL.md 2.2 のとおり解析暦だけで組む。
  public static async createCelestialSystem(
    phaseOffsets: PhaseOffsets, earthSpinPhase0: number, epoch: TdbJulianDate,
    onProgress?: (ratio: number) => void, renderer?: THREE.WebGPURenderer,
  ): Promise<CelestialSystem> {
    const profile = profileAtOrNull(epoch.value);
    const ephemerisPoints = profile === null ? null : await loadEphemerisPoints(
      profile.id, epoch, profile.validEndJdTdb, onProgress,
    );
    return solarSystem('earth', phaseOffsets, earthSpinPhase0, ephemerisPoints, epoch, renderer);
  }
  // 選択画面でロック中に出す説明。指定が無ければ selectSub をそのまま出す。
  public static readonly selectLockedSub: string | undefined = undefined;
  // タイトルのステージ選択ボタン列に並べない。
  public static readonly hiddenFromSelect: boolean = false;
  // 開始前に開始日時の指定画面を挟まない。挟むステージだけが true を宣言する。
  public static readonly picksStartEpoch: boolean = false;
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

  // 艦の軌道計画を自動実行させるか。既定では実行しない。
  public readonly executesPlans: boolean = false;
  // オブジェクトの配置・複製に対応するステージは自身の編集口を返す。既定では非対応。
  public readonly authoring: ObjectAuthoring | null = null;

  public readonly scoreCounter: ScoreCounter;
  protected readonly logistics: Logistics;
  private readonly statusPanel: StatusPanel;

  protected readonly _hud: HudLayers & Notifier;
  protected readonly _worldSfx: WorldSfx;
  protected readonly _uiSfx: UiSfx;
  protected readonly _scene: THREE.Scene;
  protected readonly _fx: FlashEffects;
  protected readonly _dynamicSystem: EntityRegistry & EntityRoster;
  protected readonly _markers: MarkerSlots;
  protected readonly _celestialSystem: CelestialSystem;
  protected readonly _controlSelection: ControlSelection;

  private _phase: GamePhase;
  public get phase(): GamePhase { return this._phase; }
  public get isPlaying(): boolean { return this._phase === 'playing'; }
  private _result: StageResult | null = null;
  public get result(): StageResult | null { return this._result; }
  // decide() が決着を確定させた瞬間に一度だけ呼ぶ。
  public onDecided: (() => void) | null = null;
  // 勝敗と結果画面の内容を同時に確定させ、鳴らし続けている継続音を畳む。
  protected decide(phase: Exclude<GamePhase, 'playing'>, result: StageResult): void {
    this._phase = phase;
    this._result = result;
    // 決着後は積分が止まるため、ここで畳まないと噴射音・RCS 音が鳴り続ける。
    this._worldSfx.setThrust(false);
    this._worldSfx.setRcs(false);
    this.onDecided?.();
  }
  private readonly restored: boolean;

  // saved が undefined ならスナップショットからの再開ではない新規開始で、スコア0・進行中・
  // 補給タイマー未経過から始まり begin() が初期配置を行う。固有の内訳を持つ具象ステージは
  // 自分のコンストラクタで super(saved, ...deps) を呼んでから自分の分を組み立て、末尾で begin() を呼ぶ。
  protected constructor(saved: StageSaveData | undefined, ...deps: StageDeps) {
    const [hud, worldSfx, uiSfx, scene, dynamicSystem, fx, markers, celestialSystem, controlSelection] = deps;
    this._hud = hud;
    this._worldSfx = worldSfx;
    this._uiSfx = uiSfx;
    this._scene = scene;
    this._fx = fx;
    this._dynamicSystem = dynamicSystem;
    this._markers = markers;
    this._celestialSystem = celestialSystem;
    this._controlSelection = controlSelection;
    this.scoreCounter = new ScoreCounter(saved?.scoreCounter);
    this._phase = saved?.phase ?? 'playing';
    this.restored = saved !== undefined;
    this.logistics = new Logistics(hud, worldSfx, uiSfx, scene, dynamicSystem, saved?.logistics);
    this.statusPanel = new StatusPanel(hud.combatRoot);
  }

  // 新規開始なら初期配置・ブリーフィングを行う。具象ステージは自分のコンストラクタの
  // 末尾で必ずこれを呼ぶ — 初期配置は具象側のフィールドが揃ってからでないと走らせられない。
  protected begin(): void {
    if (this.restored) return;
    this.init();
    this._hud.toast(this.briefingHtml(), BRIEFING_TOAST_MS);
  }

  // ステージ固有の UI(トグル等)をステータスウィンドウ左部へ追加する。
  protected addStatusPanelWidget(el: HTMLElement): void {
    this.statusPanel.appendLeftWidget(el);
  }

  // ステータスパネルを同期する。camera・displayTime は配置プレビューなどステージ固有の
  // 描画物を持つサブクラスが使う。
  public sync(
    camera: CameraFrame, _displayTime: number,
  ): void {
    this.syncStatusPanel(camera.mode === 'map');
  }

  // hudSubStatus() が null のとき、またはマップビューのときはパネルを畳む。
  private syncStatusPanel(mapView: boolean): void {
    const message = this.hudSubStatus();
    const show = message !== null && !mapView;
    this.statusPanel.sync(show ? this.ship : null, message ?? '', this.scoreCounter.kills);
  }

  // 台本が相手にする自艦。補給の投入先・敵の追跡先・ステータスパネルの表示対象はどれもこれ。
  // 操作対象が基地でも台本は止まらないので、そのときは生存中の先頭の艦を使う。
  protected get ship(): Player | null {
    const controlled = this._controlSelection.current;
    if (controlled instanceof Player) return controlled;
    return this._dynamicSystem.all().filter(isPlayer).find((p) => p.motion.alive) ?? null;
  }

  // 自機を1隻置き、操作対象が居なければそれを操作対象にする。艦の隻数は0..n隻が一般形で、
  // 何隻をどこへ置くかはステージ自身の宣言。
  protected addPlayer(init?: PlayerInit): Player {
    const ship = new Player(this._hud, this._worldSfx, this._scene, this._fx, this._markers, init);
    this._dynamicSystem.add(ship);
    this._controlSelection.claimIfNone(ship);
    return ship;
  }

  // 敵を登録し、出撃数をスコアへ記録する。
  protected addEnemy(enemy: Enemy): void {
    this._dynamicSystem.add(enemy);
    this.scoreCounter.recordSpawnEnemy();
  }

  // 外部資源の取得待ちで実体化を遅らせうる敵を登録する。gate が通り次第登録され、
  // そのときに出撃数をスコアへ記録する(SPEC/PROTEIN.md「出現」節)。
  protected spawnEnemyWhenReady(gate: SpawnGate | null, build: () => Enemy): void {
    this._dynamicSystem.spawnWhenReady(gate, build, () => this.scoreCounter.recordSpawnEnemy());
  }

  protected abstract briefingHtml(): string;
  // 初期配置。既定では何も置かない。
  protected init(): void { }
  // 毎フレーム呼ぶ。台本が相手にする自艦は this.ship から引く。
  public abstract update(dt: number, simTime: number, simSpeed: SimSpeedManager): void;

  // 時刻固定イベントを持つステージだけが override する。
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
    if (this.isPlaying && this.checkWin()) this.onWin(simTime);
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
