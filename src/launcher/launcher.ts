import { LoadingProgress } from '../game/loading-progress';
import { Run } from '../run/run';
import { KEY_MAPPING as K } from '../input/key-mapping';
import { ResultScreen, type RunTransitions } from './result-screen';
import { findStageClass } from '../game/stages/stage-dictionary';
import { selectStage } from './stage-select';
import { showLoading, hideLoading, setLoadingProgress } from './loading-overlay';
import { showFatalError } from './fatal-error';
import type { SerializedGame } from '../game/game';
import type { PageDevices } from '../run/page-devices';
import type { FrameSections } from '../game/frame-sections';
import type { ViewOptionsSettings } from '../game/hud/panels/view-options-control';
import type { ThemePalette } from '../theme';
import type { CurrentGameSource } from './save-browser/save-browser';
import type { HudShell } from '../hud/hud-shell';
import type { GamePhase, Stage, StageClass, StageResult } from '../game/stages/stage';
import type { UnlockManager } from './unlock-manager';
import type { SaveSlots } from './save/save-slots';
import type { SnapshotService } from './save/snapshot-service';
import type { AutoSave } from './save/autosave';
import type { GraphicsSettingsData } from '../render/graphics-settings';
import type { RenderStyle } from '../render/render-style';
import type { SettingValue } from '../settings/setting-value';
import type { TdbJulianDate } from '../physics/time';

// URL に ?perf=1 が付いているか。
export function debugInfoOpenAtStart(): boolean {
  return new URLSearchParams(location.search).get('perf') === '1';
}

// アクティブスロットの直近の周回がまだ終わっておらず、そのステージが今も選択可能(ロック解除済み・
// 選択画面から隠されていない)なら、そのステージクラスを返す。再開できなければ null。
function resumableStageClass(unlockManager: UnlockManager, slots: SaveSlots): StageClass | null {
  const lastRun = slots.activeSlot()?.lastRun ?? null;
  if (lastRun === null || lastRun.ended) return null;
  const stageClass = findStageClass(lastRun.stageId);
  if (stageClass === null || stageClass.hiddenFromSelect || !unlockManager.isUnlocked(stageClass.id)) return null;
  return stageClass;
}

// セーブに含まれない StageResult の代わりに、決着した phase から見出しだけを組む。
function fallbackResult(phase: GamePhase): StageResult {
  return { win: phase !== 'lost', title: null, detailHtml: '結果の記録がありません' };
}

// 周回の遷移(起動・再出撃・タイトル復帰・スナップショットのロード・スロット切替)を担う。
// 今動いている周回の Run を保持し、遷移のたびに捨てて作り直す。
export class Launcher implements RunTransitions, CurrentGameSource {
  private readonly resultScreen: ResultScreen;
  private run: Run | null = null;
  private launchedStage: StageClass | null = null;
  // 遷移中に再入すると、組み立て中の Run が dispose されないまま取り残される。
  private transitioning = false;

  // 今動いている周回。周回が無ければ null。
  public get current(): Run | null { return this.run; }

  // ラン跨ぎの持ち物と、ランを起こすときに読む設定を受け取り、結果画面を組む。viewOptions は
  // マップ・天球の表示設定と表示パネルのタブの選択、themePalette は選ばれている配色。
  public constructor(
    private readonly shell: HudShell,
    private readonly devices: PageDevices,
    private readonly viewOptions: ViewOptionsSettings,
    private readonly themePalette: SettingValue<ThemePalette>,
    private readonly sections: FrameSections,
    private readonly unlockManager: UnlockManager,
    private readonly slots: SaveSlots,
    private readonly snapshotService: SnapshotService,
    private readonly autoSave: AutoSave,
    private readonly graphics: SettingValue<GraphicsSettingsData>,
    private readonly renderStyle: SettingValue<RenderStyle>,
  ) {
    this.resultScreen = new ResultScreen(shell, this);
  }

  // タイトル解決から Run の起動までを行う。
  public async start(): Promise<void> {
    if (this.transitioning) return;
    this.transitioning = true;
    try {
      const { stageClass, startEpoch } = await this.resolveStage();
      await this.startRun(stageClass, undefined, startEpoch);
    } catch (err) {
      this.fail(err);
    } finally {
      this.transitioning = false;
    }
  }

  // ?title=1 は選択画面へ強制する。?stage= は共有リンク・デバッグ用の明示指定として最優先。
  // どちらも無ければアクティブスロットの終わっていない周回を再開し、それも無ければ選択画面を出す。
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
      this.themePalette.current,
      () => { if (!this.shell.overlayManager.closeTopmostOnEscape()) this.devices.pauseMenu.toggle(); },
      () => this.devices.pauseMenu.toggle(false),
      () => this.devices.pauseMenu.openSettings(),
    );
  }

  // 現在の周回を畳む。何も動いていない状態で呼んでも安全。
  private endRun(): void {
    this.run?.dispose();
    this.run = null;
    this.resultScreen.close();
    this.devices.pauseMenu.toggle(false);
  }

  // 現在の周回を畳んだ上で、再開する記録があればそこから、無ければ新しく Run を組み、起動をスロットへ記録する。
  private async startRun(stageClass: StageClass, snapshotId?: string, startEpoch?: TdbJulianDate): Promise<void> {
    this.endRun();
    const initialSave = this.initialSaveFor(stageClass, snapshotId, startEpoch);
    showLoading();
    try {
      const progress = new LoadingProgress(setLoadingProgress);
      this.run = initialSave === undefined
        ? await Run.create(
          stageClass, startEpoch, this.devices, this.viewOptions, this.themePalette,
          this.graphics, this.renderStyle, this.sections, this.autoSave, progress,
        )
        : await Run.resume(
          initialSave, stageClass, this.devices, this.viewOptions, this.themePalette,
          this.graphics, this.renderStyle, this.sections, this.autoSave, progress,
        );
    } finally {
      hideLoading();
    }
    const stage = this.run.game.activeStage;
    this.noteLaunched(stageClass);
    this.autoSave.beginRun(this.run.snapshot);
    // 決着済みのスナップショットから始まったランは決着の出来事を記録しないため、ここで締める。
    if (!stage.isPlaying) this.showResult(stage);
  }

  // このフレームの進行が決着を記録していたら、クリアを数えて結果画面を出す。Run.frame を回し
  // 終えたフレームごとに呼ぶ。
  public followProgress(): void {
    if (this.run === null) return;
    const { activeStage: stage, events } = this.run.game;
    if (!events.recent.some(({ body }) => body.kind === 'stageDecided')) return;
    if (stage.phase === 'won') this.unlockManager.reportClear(stage.id, this.devices.hud);
    this.showResult(stage);
  }

  // 決着したランを締め、結果画面を出す。
  private showResult(stage: Stage): void {
    const activeSlotId = this.slots.activeSlotId;
    if (activeSlotId !== null) this.slots.noteRunEnded(activeSlotId);
    this.resultScreen.show(stage.result ?? fallbackResult(stage.phase));
  }

  // 周回の初期セーブ。snapshotId があればそれを、無ければ終わっていない周回の再開(直近の周回と同じ
  // ステージ、かつ開始日時の指定なし)に限り自動セーブを復元する。直近の周回を読むので
  // noteLaunched より前に呼ぶ。復元できなければ undefined。
  private initialSaveFor(
    stageClass: StageClass, snapshotId?: string, startEpoch?: TdbJulianDate,
  ): SerializedGame | undefined {
    const activeSlotId = this.slots.activeSlotId;
    const lastRun = this.slots.activeSlot()?.lastRun ?? null;
    const resumesRunInProgress = startEpoch === undefined && activeSlotId !== null
      && lastRun !== null && !lastRun.ended && lastRun.stageId === stageClass.id;
    const initialSnapshotId = snapshotId
      ?? (resumesRunInProgress ? this.slots.autoSaveId(activeSlotId, stageClass.id) : null);
    return initialSnapshotId !== null
      ? this.snapshotService.load(initialSnapshotId, stageClass.id) ?? undefined
      : undefined;
  }

  // 実際に遊び始めたステージをスロットへ記録し、作り直しのために覚えておく。
  private noteLaunched(stageClass: StageClass): void {
    this.launchedStage = stageClass;
    const activeSlotId = this.slots.activeSlotId;
    if (activeSlotId !== null) this.slots.noteRunLaunched(activeSlotId, stageClass.id);
  }

  // router から決着後の再出撃キーを受け取る。
  public handleCommand(commandId: string): void {
    if (commandId === K.restart.code && this.run !== null && !this.run.game.activeStage.isPlaying) this.restart();
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

  // 選択画面を出し直し、選ばれたステージで作り直す。直近の周回を締めるので、この後に
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
