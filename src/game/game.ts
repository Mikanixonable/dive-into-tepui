// 1ランのモデル層の根: 進行と視点を所有し、直列化と進行の位相を持つ。
import { SECTION, type FrameSections } from './frame-sections';
import { CommandQueue } from './command-queue';
import { ControlSelection, type SerializedControlSelection } from './control-selection';
import { PlanNodeRules, type SerializedPlanNodeRules } from './plan/plan-node-rules';
import { SimSpeedManager, type SerializedSimSpeedManager } from './dynamic/sim-speed-manager';
import { DynamicSystem, type SerializedDynamicSystem } from './dynamic/dynamic-system';
import { RunEventLog } from './run-events';
import { Predictor } from './dynamic/predictor';
import { recordTargetBoardPasses } from './dynamic/target-board-passes';
import { Viewer, type SerializedViewer } from './viewer/viewer';
import { ephemerisContextFor, type EphemerisContext } from '../physics/ephemeris/ephemeris-context';
import { createJulianDate, type TdbJulianDate } from '../physics/time';
import { summarizeRun, type RunSummary } from './run-summary';
import type { GameScene } from '../render/scene';
import type { Controllable } from './dynamic/dynamic-entity/controllable';
import type { SerializedStage, Stage, StageClass } from './stages/stage';
import type { HudLayers } from './hud/hud-layers';
import type { CelestialSystem } from './celestial/celestial-system';
import type { LoadingProgress } from './loading-progress';
import type { PilotControls } from './dynamic/dynamic-entity/pilot-controls';
import type { TrajectoryDemand } from './dynamic/trajectory-demand';
import type { CameraFrameSamples } from './viewer/camera-selection';

// 1ランの直列化した形。進行と視点を分けて持つ(R4)。
export interface SerializedGame {
  readonly progress: SerializedProgress;
  readonly viewer: SerializedViewer;
}

// 進行の直列化した形。Game 自身の値と、Game が持つ進行の所有者ごとの記録から成る。
export interface SerializedProgress {
  readonly stageId: string;
  // そのランの元期と、それが選ぶ暦データの識別。元期は読み込み側が継承する値で、照合するのは
  // 暦データの識別。
  readonly ephemerisContext: EphemerisContext;
  readonly dynamicSystem: SerializedDynamicSystem;
  readonly simSpeedManager: SerializedSimSpeedManager;
  readonly controlSelection: SerializedControlSelection;
  readonly stage: SerializedStage;
  readonly planNodeRules: SerializedPlanNodeRules;
}

export class Game {
  // 顔ぶれの予測軌道のキャッシュ。需要が求める長さまで伸ばす。
  public readonly predictor: Predictor;

  // いま操作している対象。操作しているものが無ければ null。
  public get activeControllable(): Controllable | null { return this.controlSelection.current; }
  public get simTime(): number { return this.dynamicSystem.simTime; }

  // 組み上がった各所有者から組む。星系は実体化済みで渡る。
  private constructor(
    public readonly celestialSystem: CelestialSystem,
    // 計測区間の境界を打つ先。
    private readonly sections: FrameSections,
    // モデル層の外から届いた書き換えを溜める列。進行の位相の先頭で適用する。
    public readonly commands: CommandQueue,
    // 直近の進行で起きた一回きりの出来事の記録。
    public readonly events: RunEventLog,
    public readonly dynamicSystem: DynamicSystem,
    public readonly simSpeedManager: SimSpeedManager,
    // 操作対象(艦 0..n 隻と基地のうちどれを操作するか)の切替を持つ。
    public readonly controlSelection: ControlSelection,
    public readonly activeStage: Stage,
    // 直近ノードの消化と、接近・達成の記録。進行の末尾で通す。
    private readonly planNodeRules: PlanNodeRules,
    // 遊ぶ人の選択のうち、セーブごとに持つもの。
    public readonly viewer: Viewer,
  ) {
    this.predictor = new Predictor(dynamicSystem, celestialSystem);
  }

  // stageClass の新しいランを組む。元期は開始日時 startEpoch、無ければステージの宣言から採る。
  // 段の切れ目で描画を明け渡すので、組み立て中の Game は誰にも観測されないまま数フレームをまたぐ。
  // scene は天体系と実体の表示物の置き場、hud はステージのパネルの置き場。
  public static async create(
    stageClass: StageClass,
    startEpoch: TdbJulianDate | undefined,
    scene: GameScene,
    hud: HudLayers,
    sections: FrameSections,
    progress: LoadingProgress,
  ): Promise<Game> {
    const celestialSystem = await Game.buildCelestialSystem(
      stageClass, startEpoch ?? stageClass.epoch, scene, progress,
    );
    const commands = new CommandQueue();
    const events = new RunEventLog();
    // 動的システム(エンティティ群)を先に構築する — 操作対象の選択・ステージの初期配置・視点は、構築済みのエンティティ群を参照する。
    const dynamicSystem = DynamicSystem.create(scene.scene, events, celestialSystem, sections);
    const simSpeedManager = SimSpeedManager.create(events);
    const controlSelection = ControlSelection.create(dynamicSystem);
    const stage = stageClass.create(hud, scene.scene, dynamicSystem, celestialSystem, controlSelection, commands);
    const planNodeRules = PlanNodeRules.create(events);
    const viewer = Viewer.create(controlSelection, events, celestialSystem);
    return new Game(
      celestialSystem, sections, commands, events, dynamicSystem, simSpeedManager, controlSelection, stage,
      planNodeRules, viewer,
    );
  }

  // 直列化したラン serialized を、stageClass のランとして復元する。元期は記録から採る — 記録の
  // simTime はその元期からの経過秒なので、別の元期で組むと全天体がずれる。scene・hud は create と同じ。
  public static async deserialize(
    serialized: SerializedGame,
    stageClass: StageClass,
    scene: GameScene,
    hud: HudLayers,
    sections: FrameSections,
    progress: LoadingProgress,
  ): Promise<Game> {
    const { progress: serializedProgress } = serialized;
    const celestialSystem = await Game.buildCelestialSystem(
      stageClass, createJulianDate('TDB', serializedProgress.ephemerisContext.epochJdTdb), scene, progress,
    );
    const commands = new CommandQueue();
    const events = new RunEventLog();
    // 動的システム(エンティティ群)を先に構築する — 操作対象の選択・ステージ・視点は、復元されたエンティティ群を参照する。
    const dynamicSystem = DynamicSystem.deserialize(
      serializedProgress.dynamicSystem, scene.scene, events, celestialSystem, sections,
    );
    const simSpeedManager = SimSpeedManager.deserialize(serializedProgress.simSpeedManager, events);
    const controlSelection = ControlSelection.deserialize(serializedProgress.controlSelection, dynamicSystem);
    const stage = stageClass.deserialize(
      // 記録にステージの内訳が無い・null なら、新しいランの初期値で補う(初期配置はしない)。
      serializedProgress.stage ?? null,
      hud, scene.scene, dynamicSystem, celestialSystem, controlSelection, commands,
    );
    const planNodeRules = PlanNodeRules.deserialize(serializedProgress.planNodeRules, events);
    const viewer = Viewer.deserialize(serialized.viewer, dynamicSystem, controlSelection, events, celestialSystem);
    return new Game(
      celestialSystem, sections, commands, events, dynamicSystem, simSpeedManager, controlSelection, stage,
      planNodeRules, viewer,
    );
  }

  // 元期 epoch の星系を組み、表示物を scene へ実体化する。
  private static async buildCelestialSystem(
    stageClass: StageClass, epoch: TdbJulianDate, scene: GameScene, progress: LoadingProgress,
  ): Promise<CelestialSystem> {
    await progress.enter('system');
    const celestialSystem = await stageClass.createCelestialSystem(
      epoch, (ratio) => progress.within(ratio), scene.renderer,
    );
    await progress.enter('bodies');
    celestialSystem.build(scene.scene, scene.pipeline);
    await progress.enter('run');
    return celestialSystem;
  }

  // このランを直列化した形へ畳む。
  public serialize(): SerializedGame {
    // 進行は Game 自身の値と所有者ごとの記録から、視点はそれと分けて畳む。
    return {
      progress: {
        stageId: this.activeStage.id,
        ephemerisContext: { ...ephemerisContextFor(this.celestialSystem.epoch) },
        dynamicSystem: this.dynamicSystem.serialize(),
        simSpeedManager: this.simSpeedManager.serialize(),
        controlSelection: this.controlSelection.serialize(),
        stage: this.activeStage.serialize(),
        planNodeRules: this.planNodeRules.serialize(),
      },
      viewer: this.viewer.serialize(),
    };
  }

  // このランのいまの要約。
  public runSummary(): RunSummary {
    return summarizeRun(
      this.simTime, this.activeStage.phase, this.activeControllable,
      this.celestialSystem, this.dynamicSystem.all(),
    );
  }

  // このランが scene・Hud へ足したものを取り除く。呼んだ後のこのインスタンスは使えない。
  public dispose(): void {
    this.activeStage.dispose();
    this.celestialSystem.dispose();
    this.dynamicSystem.dispose();
  }

  // ------------------------------------------------------------ 進行の位相

  // 出来事の記録を空にし、受け付けた命令を適用し、一時停止でなければ操作量 controls と dt [s] で
  // 1フレーム進め、視点を進行に合わせる。
  public advance(dt: number, controls: PilotControls, paused: boolean): void {
    // 一時停止中も命令は適用する(R8)。命令の適用そのものが出来事を積むので、記録を空にするのは
    // その前。
    this.events.beginStep();
    this.commands.applyAll();
    // 的面の通過をどの対象について記録するかの需要(R4)。命令を適用した後の選択から立てる。
    const boardTargetId = this.viewer.navTarget.id;
    // ポーズには「止まった瞬間」の知らせが無いので、止まっている間は毎フレーム連続指令を畳む。
    if (paused) this.dynamicSystem.pause();
    else this.advanceSimulation(dt, controls, boardTargetId);
    this.followProgress();
  }

  // 進行が今ステップに記録した出来事へ、航法ターゲットと予測パネルを合わせる。
  public followProgress(): void {
    this.viewer.followProgress(this.events.recent);
  }

  // 進行の結果から作った視点の追従の材料 samples へ、カメラ視点を合わせる。
  public followCamera(samples: CameraFrameSamples): void {
    this.viewer.followCameraProgress(this.events.recent, samples);
  }

  // 需要 demand が求める長さまで履歴を残し予測を伸ばしてから、計画ノードの規則を通す。一時停止中・
  // 決着後も毎フレーム呼ぶ。
  public extendPredictions(demand: TrajectoryDemand): void {
    const controlled = this.activeControllable;
    this.dynamicSystem.requestHistoryDuration(demand.historyDuration);
    this.sections.enter(SECTION.predict);
    this.predictor.update(
      this.dynamicSystem.simTime, this.dynamicSystem.lastSimDt, controlled?.motion ?? null, demand,
    );
    this.sections.exit(SECTION.predict);
    // ノードの期限切れ・達成はビューに依らない計画そのものの規則なので、毎フレーム通す。
    this.sections.enter(SECTION.plan);
    this.planNodeRules.update(controlled, this.dynamicSystem.simTime, this.celestialSystem.celestialMotions);
    this.sections.exit(SECTION.plan);
  }

  // ステージ・エンティティ群・操作対象の選択を、操作入力 controls と dt [s] で1フレーム進める。boardTargetId は
  // 的面の通過を記録する対象の id。
  private advanceSimulation(dt: number, controls: PilotControls, boardTargetId: string | null): void {
    // このフレームで使う倍率を最初に一度だけ確定する。燃料消費・操作ゲート・積分が
    // 自動ワープの段階変更を跨いで別の倍率を読むと、同じ区間を表さなくなる。
    this.simSpeedManager.update(this.dynamicSystem.simTime);
    const simDt = dt * this.simSpeedManager.simSpeed;
    const canShipAct = this.simSpeedManager.canShipAct;
    const canEngage = this.simSpeedManager.canEngage;
    const controlled = this.activeControllable;
    // ステージロジックが世界を更新してから、そのエンティティ構成で1フレーム進める。生成された個体もこのフレームの
    // 指令決定と積分に乗る。
    this.sections.enter(SECTION.stage);
    this.activeStage.update(dt, this.dynamicSystem.simTime, this.simSpeedManager);
    this.sections.exit(SECTION.stage);
    // 操縦の命令は、決着前かつ操作できる倍率のときだけ受け付ける。
    const acceptsCommands = this.activeStage.isPlaying && canShipAct;
    this.dynamicSystem.update(
      controlled, controls, canShipAct, acceptsCommands, this.activeStage.enemiesMayFire, dt, simDt,
      canEngage, this.activeStage, this.activeStage.stageRules,
    );

    recordTargetBoardPasses(controlled, boardTargetId, this.dynamicSystem, this.events);
    this.controlSelection.reclaimDead();
  }

}
