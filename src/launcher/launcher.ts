import { Game } from '../game/game';
import type { Input } from '../input/input';
import { KEY_MAPPING as K } from '../input/key-mapping';
import type { PauseMenu, SettingsView } from '../hud/windows/index';
import { ResultScreen, type RunTransitions } from './result-screen';
import type { CurrentGameSource } from './save-browser/save-browser';
import type { Hud } from '../game/hud/hud';
import type { HudShell } from '../hud/hud-shell';
import type { GamePhase, Stage, StageClass, StageResult } from '../game/stages/stage';
import { findStageClass } from '../game/stages/stage-dictionary';
import { selectStage } from './stage-select';
import type { UnlockManager } from './unlock-manager';
import type { SaveSlots } from './save/save-slots';
import type { SnapshotService } from './save/snapshot-service';
import type { GameSaveData } from '../game/save/save-data';
import type { AudioEngine } from '../audio/audio-engine';
import type { Bgm } from '../audio/bgm/bgm';
import type { WorldSfx } from '../audio/sfx/world-sfx';
import type { UiSfx } from '../audio/sfx/ui-sfx';
import type { GameScene } from '../render/scene';
import type { RenderPipeline } from '../render/pipeline/render-pipeline';
import type { FrameSections } from '../frame-sections';
import type { CelestialSystem } from '../game/celestial/celestial-system';
import { showLoading, hideLoading, setLoadingProgress } from './loading-overlay';
import { showFatalError } from './fatal-error';
import { createJulianDate, TdbJulianDate } from '../physics/time';

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

// スナップショットが持つ元期。無い(旧形式)なら null。
function savedEpoch(save: GameSaveData | undefined): TdbJulianDate | null {
  const jdTdb = save?.ephemerisContext?.epochJdTdb;
  return jdTdb === undefined ? null : createJulianDate('TDB', jdTdb);
}

// ローディング表示の下で、このステージの星系を組む。
async function initCelestialSystem(
  stageClass: StageClass, phaseOffsets: Partial<Record<string, number>>, earthSpinPhase0: number,
  epoch: TdbJulianDate,
): Promise<CelestialSystem> {
  showLoading();
  try {
    return await stageClass.createCelestialSystem(phaseOffsets, earthSpinPhase0, epoch, setLoadingProgress);
  } finally {
    hideLoading();
  }
}

// 再出撃・タイトル復帰・スナップショットのロード・スロット切替 — 「Game インスタンスを
// 捨てて次の周回へ移る」判断を1箇所へ集約する。game/ 配下は location.* を一切知らない。
// 今動いている周回の Game 自体もここが保持する。
export class Launcher implements RunTransitions, CurrentGameSource {
  private readonly resultScreen: ResultScreen;
  private game: Game | null = null;
  private launchedStage: StageClass | null = null;
  // 遷移中に再入すると、組み立て中の Game が dispose されないまま取り残される。
  private transitioning = false;

  get current(): Game | null { return this.game; }

  constructor(
    private readonly shell: HudShell,
    private readonly hud: Hud,
    private readonly gs: GameScene,
    private readonly audioEngine: AudioEngine,
    private readonly bgm: Bgm,
    private readonly worldSfx: WorldSfx,
    private readonly uiSfx: UiSfx,
    private readonly pauseMenu: PauseMenu,
    private readonly settingsView: SettingsView,
    private readonly unlockManager: UnlockManager,
    private readonly sections: FrameSections,
    private readonly pipeline: RenderPipeline,
    private readonly slots: SaveSlots,
    private readonly snapshotService: SnapshotService,
  ) {
    this.resultScreen = new ResultScreen(shell, this);
  }

  // タイトル解決から Game の起動までを行う。
  async start(): Promise<void> {
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
      () => this.settingsView.toggle(true),
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
    // このランの元期。スナップショットを読むならその元期をそのまま継ぐ(照合はしない) —
    // 保存されている simTime はその元期からの経過秒なので、別の元期で組むと全天体がずれる。
    // 次に開始日時の指定、最後にステージの宣言。**星系を組む前に決まっていなければならない。**
    const epoch = savedEpoch(initialSave) ?? startEpoch ?? stageClass.epoch;
    // 地球の自転初期位相。起動ごとに無作為だが、下位を決定的に保つため乱数はここでだけ引く。
    const earthSpinPhase0 = initialSave?.earthSpinPhase0 ?? Math.random() * 2 * Math.PI;
    const celestialSystem = await initCelestialSystem(
      stageClass, initialSave?.phaseOffsets ?? {}, earthSpinPhase0, epoch,
    );
    this.game = new Game(
      this.gs, stageClass, this.hud, this.worldSfx, this.uiSfx, this.pauseMenu,
      this.sections, celestialSystem, this.pipeline, initialSave,
    );
    // AudioContext は実際のユーザー操作でしか作れないため、unlock は入力エッジの発火点へ配線する。
    // Input は周回ごとに作り直されるので、配線もそのたびに張り直す。
    this.game.input.onUserGesture = () => {
      this.audioEngine.unlock();
      this.bgm.ensureStarted();
    };
    const stage = this.game.activeStage;
    stage.onDecided = () => {
      // クリア回数はラン跨ぎの記録なので、決着した瞬間にランの外側が書く。決着済みのセーブを
      // 読んだときはここを通らない — 読むたびに回数が増えないようにするため、これでよい。
      if (stage.phase === 'won') this.unlockManager.reportClear(stage.id, this.hud);
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

  // snapshotId を最優先で使う。無ければ、起動するステージがアクティブスロットの直前起動と
  // 同じ場合(=そのスロットで進行中だった周回の再開)に限り、そのステージの最新スナップショット
  // を自動で復元する。startEpoch が明示されている(開始日時の指定画面で選んだ)場合は、その
  // 日時を新規開始の元期として使うべきなので自動復元の対象から外す — 外さないと直前セッションの
  // スナップショットの元期が指定日時を上書きしてしまう。
  // noteLaunched は Game 構築後に呼ばれるため、この時点の lastStageId は今回の起動より前の
  // 値を指している。本体の欠損・バージョン不一致・ステージ不一致は SnapshotService.load() に
  // 判定させ、復元できない場合は通常の新規起動状態をそのまま使う。
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

  // [R] は決着後だけ再出撃キーとして働く。この呼び出し時点で game.update が消費しなかった
  // エッジだけを見る。
  handleInput(input: Input): void {
    if (this.game === null || this.game.activeStage.isPlaying) return;
    if (input.takeKey(K.restart)) this.restart();
  }

  // 現在の起動ステージへ作り直す。まだ何も起動していなければ何もしない。
  restart(): void {
    if (this.launchedStage === null) return;
    if (this.transitioning) return;
    this.transitioning = true;
    this.startRun(this.launchedStage)
      .catch((err) => this.fail(err))
      .finally(() => { this.transitioning = false; });
  }

  // 選択画面を出し直し、選ばれたステージで作り直す。noteRunEnded で「直前に遊んでいたステージ」を
  // クリアし、リロード時の復元(resolveStage)がタイトル画面へフォールバックできるようにする。
  returnToTitle(): void {
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
  loadSnapshot(snapshotId: string): void {
    if (this.launchedStage === null) return;
    if (this.transitioning) return;
    this.transitioning = true;
    this.startRun(this.launchedStage, snapshotId)
      .catch((err) => this.fail(err))
      .finally(() => { this.transitioning = false; });
  }

  // アクティブスロットが切り替わった後に呼ぶ。再開できる起動先があればそれで、
  // 無ければ選択画面で決めたステージで作り直す。
  switchSlot(): void {
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

  // 次の周回への遷移そのものが失敗すると current が null のまま何も進まなくなるため、
  // 拾って明示する。
  private fail(err: unknown): void {
    console.error(err);
    showFatalError(
      '次の周回の開始に失敗しました。',
      'ブラウザやGPUの状態を確認し、ページを再読み込みしてください。',
      err,
    );
  }
}
