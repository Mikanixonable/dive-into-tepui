// 1ランの組み立て: モデル層の根 Game と表示の導出の根 GamePresentation を組み、フレームの位相を
// 入力の解釈 → 進行 → 導出と同期 → 描画の順に呼ぶ(R8)。
import { Game, type SerializedGame } from '../game/game';
import { GamePresentation } from '../game/game-presentation';
import { proteinMotionFrameSample, type ProteinMotionFrameSample } from '../game/protein/protein-motion-metrics';
import type { PageDevices } from './page-devices';
import type { StageClass } from '../game/stages/stage';
import type { FrameSections } from '../game/frame-sections';
import type { LoadingProgress } from '../game/loading-progress';
import type { RunSummary } from '../game/run-summary';
import type { PerfCounts, PerfCountSource } from '../game/perf-counts';
import type { GameInputPort } from '../game/input/game-input-router';
import type { ViewOptionsSettings } from '../game/hud/panels/view-options-control';
import type { SnapshotSource } from '../launcher/save/snapshot-service';
import type { GraphicsSettingsData } from '../render/graphics-settings';
import type { RenderStyle } from '../render/render-style';
import type { Viewport } from '../render/viewport';
import type { SettingValue } from '../settings/setting-value';
import type { ThemePalette } from '../theme';
import type { TdbJulianDate } from '../physics/time';

// 1フレームで進める実時間の上限 [s]。
const MAX_FRAME_DT = 0.1;

// 進行と導出の間で、モデル層だけが確定した瞬間のランを毎フレーム読む者。
export interface ProgressReader {
  update(source: SnapshotSource): void;
}

export class Run implements SnapshotSource, PerfCountSource {
  // 畳まれた後か。入力の途中で畳まれたフレームを、そこで打ち切るのに読む。
  private disposed = false;

  // stageClass の新しいランを組む。startEpoch は選ばれた開始日時。viewOptions はマップ・天球の表示設定と
  // 表示パネルのタブの選択、themePalette は選ばれている配色。
  public static async create(
    stageClass: StageClass,
    startEpoch: TdbJulianDate | undefined,
    devices: PageDevices,
    viewOptions: ViewOptionsSettings,
    themePalette: SettingValue<ThemePalette>,
    graphics: SettingValue<GraphicsSettingsData>,
    renderStyle: SettingValue<RenderStyle>,
    sections: FrameSections,
    progressReader: ProgressReader,
    progress: LoadingProgress,
  ): Promise<Run> {
    const warmUpGraphics = graphics.current;
    const warmUpStyle = renderStyle.current;
    const game = await Game.create(stageClass, startEpoch, devices.scene, devices.hud, sections, progress);
    return Run.launch(
      game, warmUpGraphics, warmUpStyle, devices, viewOptions, themePalette, graphics, renderStyle, sections,
      progressReader, progress,
    );
  }

  // 直列化したラン serialized を、stageClass のランとして再開する。ほかの引数は create と同じ。
  public static async resume(
    serialized: SerializedGame,
    stageClass: StageClass,
    devices: PageDevices,
    viewOptions: ViewOptionsSettings,
    themePalette: SettingValue<ThemePalette>,
    graphics: SettingValue<GraphicsSettingsData>,
    renderStyle: SettingValue<RenderStyle>,
    sections: FrameSections,
    progressReader: ProgressReader,
    progress: LoadingProgress,
  ): Promise<Run> {
    const warmUpGraphics = graphics.current;
    const warmUpStyle = renderStyle.current;
    const game = await Game.deserialize(serialized, stageClass, devices.scene, devices.hud, sections, progress);
    return Run.launch(
      game, warmUpGraphics, warmUpStyle, devices, viewOptions, themePalette, graphics, renderStyle, sections,
      progressReader, progress,
    );
  }

  // 組み上がったモデル層 game に表示の導出を繋ぎ、最初に描かれるフレームで描画資源を組む。
  // warmUpGraphics・warmUpStyle は、ランを組み始めた時点の描画設定。
  private static async launch(
    game: Game,
    warmUpGraphics: GraphicsSettingsData,
    warmUpStyle: RenderStyle,
    devices: PageDevices,
    viewOptions: ViewOptionsSettings,
    themePalette: SettingValue<ThemePalette>,
    graphics: SettingValue<GraphicsSettingsData>,
    renderStyle: SettingValue<RenderStyle>,
    sections: FrameSections,
    progressReader: ProgressReader,
    progress: LoadingProgress,
  ): Promise<Run> {
    const presentation = new GamePresentation(game, devices, viewOptions, themePalette, sections);
    const run = new Run(game, presentation, devices, graphics, renderStyle, sections, progressReader);
    // ランがまだ無い起動中のフレームに、雲場の供給ジョブのような重い前倒し駆動を差し込める
    // よう組み立て中のランを載せる。暖機が終わるか投げたら外す。
    devices.loadingJobs = run;
    try {
      // 組み立ての間に積まれた出来事は、最初のフレームの進行が記録を空にすると消えるので、
      // ここで視点に反映してプレゼンテーション層へ反映しておく。新規開始のブリーフィングもこの場で表示する。
      game.followProgress();
      presentation.anchorFrameAt(game.simTime);
      game.followCamera(presentation.cameraSamples());
      presentation.presentRunStart();
      await run.warmUp(warmUpGraphics, warmUpStyle, progress);
    } finally {
      devices.loadingJobs = null;
    }
    return run;
  }

  private constructor(
    public readonly game: Game,
    private readonly presentation: GamePresentation,
    private readonly devices: PageDevices,
    private readonly graphics: SettingValue<GraphicsSettingsData>,
    private readonly renderStyle: SettingValue<RenderStyle>,
    private readonly sections: FrameSections,
    private readonly progressReader: ProgressReader,
  ) {}

  // シェーダを組む前に、最初に描かれるフレームと同じ表示状態を、進行の後の導出と同期で作る —
  // 天体表面の分割段のように導出と同期が決めるまで現れない表示物が、事前コンパイルから漏れる。
  private async warmUp(graphics: GraphicsSettingsData, style: RenderStyle, progress: LoadingProgress): Promise<void> {
    const viewport = this.devices.scene.viewport;
    // 進行を通すと、読み込んだ記録が保存した瞬間の状態から続かなくなる(SAVE.md「保存される内容」)。
    this.deriveAfterProgress(0, viewport);
    this.presentation.sync(graphics, style, viewport, 0);
    await progress.enter('shaders');
    await this.presentation.compile(style, progress);
    // 出力段の階調変換は three が実際に描いたときにしか組まないので、捨てる 1 フレームで組ませる。
    this.presentation.render(style);
  }

  // このランが足したものを、表示の導出、モデル層の順に取り除く。呼んだ後のこのインスタンスは使えない。
  public dispose(): void {
    this.disposed = true;
    this.presentation.dispose();
    this.game.dispose();
  }

  // 1フレームを回す。dtRaw [s] は実時間の経過、nowMs [ms] はフレームの先頭で1度だけ読んだ実時刻。
  // ports はランが消費しなかった入力エッジを処理するラン外部のハンドラ。入力の途中でランが破棄されたら
  // (再出撃キーなど)導出と同期の前に打ち切り、false を返す。
  public frame(
    dtRaw: number, nowMs: number, viewport: Viewport, ports: readonly GameInputPort[],
    renderFrame = true,
  ): boolean {
    const debugInfo = this.devices.debugInfo;
    const t0 = debugInfo.on ? performance.now() : 0;
    this.sections.beginFrame();
    this.advanceFrame(Math.min(dtRaw, MAX_FRAME_DT), nowMs, viewport);
    this.sections.endFrame();
    this.presentation.routeInput(ports);
    if (this.disposed) return false;
    // ランを読む者へは、進行と導出の間のモデル層だけが確定した瞬間を渡す(R8)。
    this.progressReader.update(this.snapshot);
    const t1 = debugInfo.on ? performance.now() : 0;
    this.presentation.sync(this.graphics.current, this.renderStyle.current, viewport, nowMs);
    const t2 = debugInfo.on ? performance.now() : 0;
    let t3 = t2;
    if (renderFrame) {
      this.presentation.render(this.renderStyle.current);
      t3 = debugInfo.on ? performance.now() : t2;
      // 時刻印クエリを溜めないため、描画したフレームだけ解決させる。
      this.devices.scene.gpu.resolve();
    }
    if (debugInfo.on) debugInfo.record(this, t1 - t0, t2 - t1, t3 - t2, t3);
    return true;
  }

  // 入力の解釈から、進行とその後の導出までを dt [s] で1回通す。
  private advanceFrame(dt: number, nowMs: number, viewport: Viewport): void {
    const { game, presentation } = this;
    presentation.interpretInput(dt, nowMs, viewport);
    game.advance(dt, presentation.pilotControls, presentation.isPaused);
    this.deriveAfterProgress(nowMs, viewport);
  }

  // 進行の結果へ表示窓とカメラ視点を合わせ、予測を伸ばし、表示の値を組む。nowMs [ms] はフレームの実時刻。
  private deriveAfterProgress(nowMs: number, viewport: Viewport): void {
    const { game, presentation } = this;
    presentation.resolveFrame();
    game.followCamera(presentation.cameraSamples());
    presentation.presentProgress();
    // 需要は予測を読む側より前に立てる。
    game.extendPredictions(presentation.trajectoryDemand());
    presentation.update(nowMs, viewport);
  }

  // ------------------------------------------------------------ ランの外への読み口

  // loadingJobs が呼ぶ、起動中の前倒し駆動。ペンディング中の雲場供給ジョブを
  // timeBudgetMs [ms] ぶん進める。
  public drivePendingJobs(timeBudgetMs: number): void {
    this.presentation.drivePendingJobs(timeBudgetMs);
  }

  public get stageId(): string { return this.game.activeStage.id; }
  public get isPaused(): boolean { return this.presentation.isPaused; }
  public get isPlaying(): boolean { return this.game.activeStage.isPlaying; }
  // 記録を1件残すときの読み口。
  public get snapshot(): SnapshotSource { return this; }

  // 天体 id の表示名。
  public nameOfBody(id: string): string {
    return this.game.celestialSystem.nameOf(id);
  }

  // このランのいまの要約。
  public runSummary(): RunSummary {
    return this.game.runSummary();
  }

  // このランを直列化した形へ畳む。
  public serialize(): SerializedGame {
    return this.game.serialize();
  }

  // 各モジュールが答えた計測値を1つに合流させる。
  public perfCounts(): PerfCounts {
    const game = this.game;
    const shown = this.presentation.perfCounts();
    return {
      ...game.dynamicSystem.perfCounts(),
      ...game.predictor.perfCounts(game.simTime, shown.displayDurationSec, game.activeControllable?.motion ?? null),
      ...game.celestialSystem.perfCounts(),
      ...shown,
      warp: game.simSpeedManager.simSpeed,
    };
  }

  // タンパク質敵モーションの集計値。
  public proteinMotionFrameSample(): ProteinMotionFrameSample {
    return proteinMotionFrameSample(this.game.dynamicSystem.all());
  }
}
