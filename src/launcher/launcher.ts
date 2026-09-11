import { Game } from '../game/game';
import type { GameHost } from '../game/game-host';
import { LoadingProgress } from '../game/loading-progress';
import type { Input } from '../input/input';
import { KEY_MAPPING as K } from '../input/key-mapping';
import type { PauseMenu } from '../hud/windows/pause-menu';
import { ResultScreen, type RunTransitions } from './result-screen';
import type { CurrentGameSource } from './save-browser/save-browser';
import type { HudShell } from '../hud/hud-shell';
import type { GamePhase, Stage, StageClass, StageResult } from '../game/stages/stage';
import { findStageClass } from '../game/stages/stage-dictionary';
import { selectStage } from './stage-select';
import type { UnlockManager } from './unlock-manager';
import type { SaveSlots } from './save/save-slots';
import type { SnapshotService } from './save/snapshot-service';
import type { GameSaveData } from '../game/save/save-data';
import { runSummary } from '../game/run-summary';
import type { AudioEngine } from '../audio/audio-engine';
import type { Bgm } from '../audio/bgm/bgm';
import type { GraphicsSettingsData } from '../render/graphics-settings';
import type { RenderStyle } from '../render/render-style';
import type { SettingValue } from '../settings/stored-setting';
import { showLoading, hideLoading, setLoadingProgress } from './loading-overlay';
import { showFatalError } from './fatal-error';
import type { TdbJulianDate } from '../physics/time';

// URL に ?perf=1 が付いているか。付いていればデバッグ情報ウィンドウを起動直後から開く。
export function debugInfoOpenAtStart(): boolean {
  return new URLSearchParams(location.search).get('perf') === '1';
}

// アクティブスロットの直近起動が今も選択可能(ロック解除済み・選択画面から隠されていない)なら、
// そのステージクラスを返す。再開できる情報が無ければ null。
function resumableStageClass(unlockManager: UnlockManager, slots: SaveSlots): StageClass | null {
  const slot = slots.activeSlot();
  if (slot === null) return null;
  const stageClass = findStageClass(slot.lastStageId);
  if (stageClass === null || stageClass.hiddenFromSelect || !unlockManager.isUnlocked(stageClass.id)) return null;
  return stageClass;
}

// StageResult はセーブに含まれないので、決着済みの phase を持つセーブを読んだときは
// 見出しだけを phase から復元する。内訳は残っていない。
function fallbackResult(phase: GamePhase): StageResult {
  return { win: phase !== 'lost', title: null, detailHtml: '結果の記録がありません' };
}

// 周回の遷移(起動・再出撃・タイトル復帰・スナップショットのロード・スロット切替)を担う。
// 今動いている周回の Game を保持し、遷移のたびに捨てて作り直す。
export class Launcher implements RunTransitions, CurrentGameSource {
  private readonly resultScreen: ResultScreen;
  private game: Game | null = null;
  private launchedStage: StageClass | null = null;
  // 遷移中に再入すると、組み立て中の Game が dispose されないまま取り残される。
  private transitioning = false;

  public get currentGame(): Game | null { return this.game; }

  // CurrentGameSource 実装。今動いている周回の読み口と一時停止の口。周回が無ければ null。
  // 状態を表す値は、読むたびにその周回の Game から引く。
  public get current(): CurrentGameSource['current'] {
    const game = this.game;
    if (game === null) return null;
    return {
      stageId: game.activeStage.id,
      get isPlaying(): boolean { return game.activeStage.isPlaying; },
      nameOfBody: (id) => game.celestialSystem.nameOf(id),
      // スナップショットの撮影に要る読み口。
      snapshot: {
        get isPaused(): boolean { return game.isPaused; },
        get isPlaying(): boolean { return game.activeStage.isPlaying; },
        runSummary: () => runSummary(game),
        serialize: () => game.serialize(),
      },
      pause: () => game.pause(),
      resume: () => game.resume(),
    };
  }

  // ラン跨ぎの持ち物と、ランを起こすときに読む設定の現在値を受け取り、結果画面を組む。
  public constructor(
    private readonly shell: HudShell,
    private readonly host: GameHost,
    private readonly audioEngine: AudioEngine,
    private readonly bgm: Bgm,
    private readonly pauseMenu: PauseMenu,
    private readonly unlockManager: UnlockManager,
    private readonly slots: SaveSlots,
    private readonly snapshotService: SnapshotService,
    private readonly graphics: SettingValue<GraphicsSettingsData>,
    private readonly renderStyle: SettingValue<RenderStyle>,
  ) {
    this.resultScreen = new ResultScreen(shell, this);
  }

  // タイトル解決から Game の起動までを行う。
  public async start(): Promise<void> {
    if (this.transitioning) return;
    this.transitioning = true;
    try {
      const { stageClass, startEpoch } = await this.resolveStage();
      await this.startRun(stageClass, undefined, startEpoch);
    } finally {
      this.transitioning = false;
    }
  }

  // ?title=1 は選択画面へ強制する。?stage= は共有リンク・デバッグ用の明示指定として最優先。
  // どちらも無ければアクティブスロットの直近起動を再開し、それも無ければ選択画面を出す。
  private async resolveStage(): Promise<{ stageClass: StageClass; startEpoch?: TdbJulianDate }> {
    const params = new URLSearchParams(location.search);
    if (params.get('title') !== '1') {
      const fromParam = findStageClass(params.get('stage'));
      if (fromParam !== null) return { stageClass: fromParam };
      const resumed = resumableStageClass(this.unlockManager, this.slots);
      if (resumed !== null) return { stageClass: resumed };
    }
    return this.selectStageScreen();
  }

  // 選択画面を出し、選ばれたステージクラス(クリエイティブなら開始日時も)で解決される Promise を返す。
  private selectStageScreen(): Promise<{ stageClass: StageClass; startEpoch?: TdbJulianDate }> {
    return selectStage(
      this.unlockManager,
      () => { if (!this.shell.overlayManager.closeTopmostOnEscape()) this.pauseMenu.toggle(); },
      () => this.pauseMenu.toggle(false),
      () => this.pauseMenu.openSettings(),
    );
  }

  // 現在の周回を畳む。Game を破棄し、結果画面と一時停止メニューを閉じる。
  // 何も動いていない状態で呼んでも安全。
  private endRun(): void {
    this.game?.dispose();
    this.game = null;
    this.resultScreen.close();
    this.pauseMenu.toggle(false);
  }

  // 現在の周回を畳んだ上で、天体暦の構築から Game の生成までを行い、起動をスロットへ記録する。
  private async startRun(stageClass: StageClass, snapshotId?: string, startEpoch?: TdbJulianDate): Promise<void> {
    this.endRun();
    const initialSave = this.initialSaveFor(stageClass, snapshotId, startEpoch);
    showLoading();
    try {
      this.game = await Game.create(
        this.host, stageClass, this.audioEngine, this.pauseMenu,
        initialSave, startEpoch, this.graphics.current, this.renderStyle.current,
        new LoadingProgress(setLoadingProgress),
      );
    } finally {
      hideLoading();
    }
    // AudioContext はユーザー操作の中でしか作れないので、周回ごとの Input の入力エッジへ unlock を張る。
    this.game.input.onUserGesture = () => {
      this.audioEngine.unlock();
      this.bgm.ensureStarted();
    };
    const stage = this.game.activeStage;
    stage.onDecided = () => {
      // クリア回数は決着した瞬間に数える。決着済みのセーブから始めたランはここを通らないので、
      // 読むたびには増えない。
      if (stage.phase === 'won') this.unlockManager.reportClear(stage.id, this.host.hud);
      this.showResult(stage);
    };
    this.noteLaunched(stageClass);
    this.bgm.resume();
    // 決着済みのスナップショットから始まったランは decide() を通らないため、ここで締める。
    if (!stage.isPlaying) this.showResult(stage);
  }

  // 決着したランを締め、結果画面を出す。
  private showResult(stage: Stage): void {
    this.bgm.stop();
    const activeSlotId = this.slots.activeSlotId;
    if (activeSlotId !== null) this.slots.noteRunEnded(activeSlotId);
    this.resultScreen.show(stage.result ?? fallbackResult(stage.phase));
  }

  // 周回の初期セーブ。snapshotId があればそれを、無ければ進行中だった周回の再開(直前起動と同じ
  // ステージ、かつ開始日時の指定なし)に限り最新スナップショットを復元する。直前起動を読むので
  // noteLaunched より前に呼ぶ。復元できなければ undefined。
  private initialSaveFor(stageClass: StageClass, snapshotId?: string, startEpoch?: TdbJulianDate): GameSaveData | undefined {
    const activeSlotId = this.slots.activeSlotId;
    const resumesLastLaunchedStage = startEpoch === undefined
      && activeSlotId !== null && this.slots.activeSlot()?.lastStageId === stageClass.id;
    const initialSnapshotId = snapshotId
      ?? (resumesLastLaunchedStage ? this.slots.latestSnapshot(activeSlotId, stageClass.id)?.id ?? null : null);
    const initialSave = initialSnapshotId !== null
      ? this.snapshotService.load(initialSnapshotId, stageClass.id) ?? undefined
      : undefined;
    // ロードした時点より後の自動スナップショットは、もう起きなかった未来なので破棄する。
    if (initialSave && initialSnapshotId !== null) this.slots.discardAfter(initialSnapshotId);
    return initialSave;
  }

  // 実際に遊び始めたステージをスロットへ記録し、restart()/loadSnapshot() のために覚えておく。
  private noteLaunched(stageClass: StageClass): void {
    this.launchedStage = stageClass;
    const activeSlotId = this.slots.activeSlotId;
    if (activeSlotId !== null) this.slots.noteLaunch(activeSlotId, stageClass.id);
  }

  // 決着後の再出撃キーを拾う。game.update が入力エッジを消費した後に呼ぶ。
  public handleInput(input: Input): void {
    if (this.game === null || this.game.activeStage.isPlaying) return;
    if (input.takeKey(K.restart)) this.restart();
  }

  // 現在の起動ステージへ作り直す。まだ何も起動していなければ何もしない。
  public restart(): void {
    if (this.launchedStage === null) return;
    if (this.transitioning) return;
    this.transitioning = true;
    this.startRun(this.launchedStage)
      .catch((err) => this.fail(err))
      .finally(() => { this.transitioning = false; });
  }

  // 選択画面を出し直し、選ばれたステージで作り直す。直前起動の記録を消すので、この後に
  // 再読み込みしても選択画面から始まる。
  public returnToTitle(): void {
    if (this.transitioning) return;
    this.transitioning = true;
    this.endRun();
    const activeSlotId = this.slots.activeSlotId;
    if (activeSlotId !== null) this.slots.noteRunEnded(activeSlotId);
    this.selectStageScreen()
      .then(({ stageClass, startEpoch }) => this.startRun(stageClass, undefined, startEpoch))
      .catch((err) => this.fail(err))
      .finally(() => { this.transitioning = false; });
  }

  // 現在の起動ステージを、指定したスナップショットの状態から作り直す。
  // まだ何も起動していなければ何もしない。
  public loadSnapshot(snapshotId: string): void {
    if (this.launchedStage === null) return;
    if (this.transitioning) return;
    this.transitioning = true;
    this.startRun(this.launchedStage, snapshotId)
      .catch((err) => this.fail(err))
      .finally(() => { this.transitioning = false; });
  }

  // アクティブスロットが切り替わった後に呼ぶ。再開できる起動先があればそれで、
  // 無ければ選択画面で決めたステージで作り直す。
  public switchSlot(): void {
    if (this.transitioning) return;
    this.transitioning = true;
    this.endRun();
    // 切り替え先のスロットで再開できるステージが無ければ、選択画面で決める。
    const resumed = resumableStageClass(this.unlockManager, this.slots);
    const resolved: Promise<{ stageClass: StageClass; startEpoch?: TdbJulianDate }> =
      resumed !== null ? Promise.resolve({ stageClass: resumed }) : this.selectStageScreen();
    resolved
      .then(({ stageClass, startEpoch }) => this.startRun(stageClass, undefined, startEpoch))
      .catch((err) => this.fail(err))
      .finally(() => { this.transitioning = false; });
  }

  // 周回の遷移の失敗を画面に出す。遷移が失敗すると current が null のまま進まなくなる。
  private fail(err: unknown): void {
    console.error(err);
    showFatalError(
      '次の周回の開始に失敗しました。',
      'ブラウザやGPUの状態を確認し、ページを再読み込みしてください。',
      err,
    );
  }
}
