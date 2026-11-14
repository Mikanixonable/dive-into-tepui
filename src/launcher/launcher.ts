import { LoadingProgress } from '../game/loading-progress';
import { Run } from '../run/run';
import { KEY_MAPPING as K } from '../input/key-mapping';
import { ResultScreen, type RunTransitions } from './result-screen';
import { findStageClass } from '../game/stages/stage-dictionary';
import { selectStage } from './stage-select';
import { showLoading, hideLoading, setLoadingProgress } from './loading-overlay';
import { showFatalError } from './fatal-error';
import { BlueprintShelf } from './save/blueprint-shelf';
import { SALVAGE_BLUEPRINTS } from '../game/ship/salvage-blueprints';
import type { SerializedGame } from '../game/game';
import type { RunEvent } from '../game/run-events';
import type { PageDevices } from '../run/page-devices';
import type { FrameSections } from '../game/frame-sections';
import type { ViewOptionsSettings } from '../game/hud/panels/view-options-control';
import type { ThemePalette } from '../theme';
import type { CurrentGameSource } from './save-browser/save-browser';
import type { HudShell } from '../hud/hud-shell';
import type { GamePhase, RunOptions, RunStats, Stage, StageClass, StageResult } from '../game/stages/stage';
import { BODY_REVEAL_BASE } from '../game/celestial/body-reveal';
import { StageRecords, FORECAST_LOSS_STREAK, bestDetailHtml, type BestComparison } from './stage-records';
import type { UnlockManager } from './unlock-manager';
import type { SaveSlots } from './save/save-slots';
import type { SnapshotService } from './save/snapshot-service';
import type { AutoSave } from './save/autosave';
import type { GraphicsSettingsData } from '../render/graphics-settings';
import type { RenderStyle } from '../render/render-style';
import type { SettingValue } from '../settings/setting-value';
import type { TdbJulianDate } from '../physics/time';

// 起動時からデバッグ表示を開くか。URL に ?perf=1 が付いていれば開く。
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
  return {
    win: phase !== 'lost', title: null, detailHtml: '結果の記録がありません', stats: null, lossCause: null,
  };
}

// 周回の遷移(起動・再出撃・タイトル復帰・スナップショットのロード・スロット切替)を担う。
// 今動いている周回の Run を保持し、遷移のたびに捨てて作り直す。
export class Launcher implements RunTransitions, CurrentGameSource {
  private readonly resultScreen: ResultScreen;
  private readonly blueprintShelf: BlueprintShelf;
  // ステージごとのベストと連敗。ランを跨いで保たれる。
  private readonly stageRecords = new StageRecords();
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
    this.blueprintShelf = new BlueprintShelf(slots);
  }

  // 起動時の遷移。始めるステージを決めて Run を起こし、失敗したら画面に出す。
  public async start(): Promise<void> {
    // 遷移は1つずつ。遷移中に重なった呼び出しは捨てる。
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

  // 始めるステージを決める。?title=1 なら選択画面、?stage= があればそのステージ、どちらも無ければ
  // アクティブスロットの終わっていない周回を再開し、それも無ければ選択画面で選ばせる。
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

  // 勝敗を判定するステージだけが、遊んでいるセーブ枠の解放の記録を読む。判定しないステージは基底の天体から始める。
  private revealedBodiesFor(stageClass: StageClass): readonly string[] {
    const slot = this.slots.activeSlot();
    return stageClass.judgesOutcome && slot !== null ? slot.revealedBodies ?? BODY_REVEAL_BASE : BODY_REVEAL_BASE;
  }

  // 現在の周回を畳んだ上で、再開する記録があればそこから、無ければ新しく Run を組み、起動をスロットへ記録する。
  // reinforced は援護付きの再出撃か。新しく始めるランには、連敗の予告の選択もここで決める。
  private async startRun(
    stageClass: StageClass, snapshotId?: string, startEpoch?: TdbJulianDate, reinforced = false,
  ): Promise<void> {
    this.endRun();
    this.blueprintShelf.reload();
    const initialSave = this.initialSaveFor(stageClass, snapshotId, startEpoch);
    const runOptions: RunOptions = {
      reinforced,
      forecast: this.stageRecords.lossStreak(stageClass.id) >= FORECAST_LOSS_STREAK,
      revealedBodies: this.revealedBodiesFor(stageClass),
    };
    showLoading();
    try {
      const progress = new LoadingProgress(setLoadingProgress);
      this.run = initialSave === undefined
        ? await Run.create(
          stageClass, startEpoch, this.devices, this.viewOptions, this.themePalette,
          this.graphics, this.renderStyle, this.sections, this.blueprintShelf, this.autoSave, progress,
          runOptions,
        )
        : await Run.resume(
          initialSave, stageClass, this.devices, this.viewOptions, this.themePalette,
          this.graphics, this.renderStyle, this.sections, this.blueprintShelf, this.autoSave, progress,
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

  // このフレームの進行が記録した出来事を処理する。設計図の記録は棚へ写し、決着が記録されて
  // いればクリアを数えて結果画面を出す。Run.frame を回し終えたフレームごとに呼ぶ。
  public followProgress(): void {
    if (this.run === null) return;
    const { activeStage: stage, events } = this.run.game;
    this.recordBlueprintEvents(events.recent);
    if (!events.recent.some(({ body }) => body.kind === 'stageDecided')) return;
    if (stage.phase === 'won') {
      this.unlockManager.reportClear(stage.id, this.devices.hud);
      // 勝利で解放された天体を、遊んでいるセーブ枠へ記録する。
      const slotId = this.slots.activeSlotId;
      if (slotId !== null) this.slots.setRevealedBodies(slotId, stage.revealedBodies);
    }
    const stats = stage.result?.stats ?? null;
    const comparison = stats === null ? null : this.noteOutcome(stage, stats);
    this.showResult(stage, comparison);
  }

  // 決着した成績を、ベストと比べてから記録する。比べた結果を返す。
  private noteOutcome(stage: Stage, stats: RunStats): BestComparison {
    const comparison = this.stageRecords.compare(stage.id, stats);
    this.stageRecords.record(stage.id, stage.phase, stats);
    return comparison;
  }

  // 直近の進行が記録した設計図の記録を棚へ写す。記録できなかった操作があれば警告を出す。
  private recordBlueprintEvents(events: readonly RunEvent[]): void {
    const records = events.filter(
      ({ body }) => body.kind === 'blueprintRenamed' || body.kind === 'blueprintDeleted'
        || body.kind === 'salvageBlueprintGranted',
    );
    if (records.length === 0) return;
    // 棚の一覧がアクティブなセーブデータの切り替えに乗り遅れていると、別の一覧へ重ねて書き込む。
    this.blueprintShelf.reload();
    let failed = false;
    for (const { body } of records) {
      switch (body.kind) {
        case 'blueprintRenamed':
          if (!this.blueprintShelf.rename(body.id, body.name)) failed = true;
          break;
        case 'blueprintDeleted':
          if (!this.blueprintShelf.delete(body.id)) failed = true;
          break;
        case 'salvageBlueprintGranted': {
          const salvage = SALVAGE_BLUEPRINTS.find((entry) => entry.name === body.name);
          if (salvage === undefined || !this.blueprintShelf.add({
            id: salvage.id, name: salvage.name, createdAtReal: Date.now(), piece: salvage.piece,
          })) failed = true;
          break;
        }
        default:
          break;
      }
    }
    if (failed) this.devices.hud.hint('設計図を記録できませんでした', undefined, 'warn');
  }

  // 決着したランを締め、結果画面を出す。comparison は今回の決着をベストと比べた結果。読み直した
  // 決着では比べていないので null で、ベストの行は出さない。
  private showResult(stage: Stage, comparison: BestComparison | null = null): void {
    const activeSlotId = this.slots.activeSlotId;
    if (activeSlotId !== null) this.slots.noteRunEnded(activeSlotId);
    const result = stage.result ?? fallbackResult(stage.phase);
    const withBest = comparison !== null && result.stats !== null
      ? { ...result, detailHtml: result.detailHtml + bestDetailHtml(result.stats, comparison) }
      : result;
    this.resultScreen.show(withBest);
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

  // 入力のコマンド commandId を受け、決着後の再出撃キーなら作り直す。
  public handleCommand(commandId: string): void {
    if (commandId === K.restart.code && this.run !== null && !this.run.game.activeStage.isPlaying) this.restart();
  }

  // 現在の起動ステージへ作り直す。reinforced なら援護付きで作る。まだ何も起動していなければ何もしない。
  public restart(reinforced = false): void {
    if (this.launchedStage === null) return;
    if (this.transitioning) return;
    this.transitioning = true;
    this.startRun(this.launchedStage, undefined, undefined, reinforced)
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
    // 前のスロットの周回を畳んでから、次の起動先を決める。
    this.endRun();
    this.blueprintShelf.reload();
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
