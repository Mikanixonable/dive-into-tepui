// 1ランのモデル層の根: 進行と視点を所有し、直列化と進行の位相を持つ。
import type { GameScene } from '../render/scene';
import { SECTION, type FrameSections } from './frame-sections';
import type { Controllable } from './dynamic/dynamic-entity/controllable';
import type { SerializedStage, Stage, StageClass, StageDeps } from './stages/stage';
import type { HudLayers } from './hud/hud-layers';
import { CommandQueue } from './command-queue';
import { ControlSelection } from './control-selection';
import { PlanNodeRules } from './plan/plan-node-rules';
import { SimSpeedManager } from './dynamic/sim-speed-manager';
import { DynamicSystem } from './dynamic/dynamic-system';
import { RunEventLog } from './run-events';
import { Predictor } from './dynamic/predictor';
import { recordTargetBoardPasses } from './dynamic/target-board-passes';
import type { CelestialSystem } from './celestial/celestial-system';
import { Viewer, type SerializedViewer } from './viewer/viewer';
import { ephemerisContextFor, type EphemerisContext } from '../physics/ephemeris/ephemeris-context';
import { createJulianDate, type TdbJulianDate } from '../physics/time';
import { summarizeRun, type RunSummary } from './run-summary';
import type { SerializedDynamicEntity } from './dynamic/dynamic-entity/entity-dictionary';
import type { LoadingProgress } from './loading-progress';
import type { PilotControls } from './dynamic/dynamic-entity/pilot-controls';
import type { TrajectoryDemand } from './dynamic/trajectory-demand';
import type { CameraFrameSamples } from './viewer/camera-selection';

// SerializedGame の形式バージョン。上げるのは構造が変わって互換を切るときで、上げた時点で
// それ以前に書かれた記録は読めなくなる。項目を増やすだけなら版は据え置き、省略可能にして
// 読み込み側で基底値を補う(SAVE.md「形式の版」)。
export const SERIALIZATION_VERSION = 3;

// 1ランの直列化した形。視点の分は SerializedViewer の項目がそのまま並ぶ。
export interface SerializedGame extends SerializedViewer {
  readonly version: number;
  readonly stageId: string;
  readonly simTime: number;
  /**
   * そのランの元期と、それが選ぶ暦データの識別。元期は読み込み側が継承する値で、照合するのは
   * 暦データの識別。
   */
  readonly ephemerisContext: EphemerisContext;
  // 顔ぶれ。種別は各要素の kind が持つ。
  readonly entities: SerializedDynamicEntity[];
  readonly activeControlledId: string | null;
  readonly stage: SerializedStage;
}

export class Game {
  // モデル層の外から届いた書き換えを溜める列。進行の位相の先頭で適用する。
  public readonly commands = new CommandQueue();
  // 直近の進行で起きた一回きりの出来事の記録。
  public readonly events = new RunEventLog();
  public readonly celestialSystem: CelestialSystem;
  public readonly dynamicSystem: DynamicSystem;
  public readonly simSpeedManager: SimSpeedManager;
  // 操作対象(艦 0..n 隻と基地のうちどれを操作するか)の切替を持つ。
  public readonly controlSelection: ControlSelection;
  public readonly activeStage: Stage;
  // 遊ぶ人の選択のうち、セーブごとに持つもの。
  public readonly viewer: Viewer;
  // 顔ぶれの予測軌道。需要が求める長さまで伸ばす。
  public readonly predictor: Predictor;
  // 直近ノードの消化と、接近・達成の記録。
  private readonly planNodeRules: PlanNodeRules;
  // 計測区間の境界を打つ先。
  private readonly sections: FrameSections;

  // いま操作している対象。操作しているものが無ければ null。
  public get activeControllable(): Controllable | null { return this.controlSelection.current; }
  public get simTime(): number { return this.dynamicSystem.simTime; }

  // 星系を組んでから、このランのモデル層を組む。段の切れ目で描画を明け渡すので、組み立て中の
  // Game は誰にも観測されないまま数フレームをまたぐ。scene は天体系と実体の表示物の置き場、
  // hud はステージのパネルの置き場。
  public static async create(
    stageClass: StageClass,
    initialSave: SerializedGame | undefined,
    startEpoch: TdbJulianDate | undefined,
    scene: GameScene,
    hud: HudLayers,
    sections: FrameSections,
    progress: LoadingProgress,
  ): Promise<Game> {
    await progress.enter('system');
    // このランの元期。セーブの元期、開始日時の指定、ステージの宣言の順に採る — 保存された simTime
    // はセーブの元期からの経過秒なので、別の元期で組むと全天体がずれる。
    const savedJdTdb = initialSave?.ephemerisContext.epochJdTdb;
    const epoch = savedJdTdb !== undefined ? createJulianDate('TDB', savedJdTdb) : startEpoch ?? stageClass.epoch;
    const celestialSystem = await stageClass.createCelestialSystem(
      epoch, (ratio) => progress.within(ratio), scene.renderer,
    );
    await progress.enter('bodies');
    celestialSystem.build(scene.scene, scene.pipeline);
    await progress.enter('run');
    return new Game(stageClass, celestialSystem, scene, hud, sections, initialSave);
  }

  // 各所有者を、互いの依存関係が満たせる順に組む。星系は実体化済みで渡る。
  private constructor(
    stageClass: StageClass,
    celestialSystem: CelestialSystem,
    scene: GameScene,
    hud: HudLayers,
    sections: FrameSections,
    initialSave?: SerializedGame,
  ) {
    this.celestialSystem = celestialSystem;
    this.sections = sections;
    // 顔ぶれを先に組む — 操作対象の選択・ステージの初期配置・視点は、組み上がった顔ぶれを読む。
    this.dynamicSystem = new DynamicSystem(
      scene.scene, this.events, celestialSystem, sections, initialSave?.simTime ?? 0, initialSave);
    this.simSpeedManager = new SimSpeedManager(this.events);
    this.controlSelection = new ControlSelection(initialSave?.activeControlledId, this.dynamicSystem);
    const stageDeps: StageDeps = [
      hud, scene.scene, this.dynamicSystem, celestialSystem, this.controlSelection, this.commands,
    ];
    this.activeStage = initialSave === undefined
      ? stageClass.create(...stageDeps)
      : stageClass.deserialize(initialSave.stage, ...stageDeps);
    this.viewer = initialSave === undefined
      ? Viewer.create(this.controlSelection, this.events, celestialSystem)
      : Viewer.deserialize(initialSave, this.dynamicSystem, this.controlSelection, this.events, celestialSystem);
    // 進行の末尾で通す、予測と計画の規則。
    this.planNodeRules = new PlanNodeRules(this.events);
    this.predictor = new Predictor(this.dynamicSystem, celestialSystem);
  }

  // このランを直列化した形へ畳む。
  public serialize(): SerializedGame {
    return {
      version: SERIALIZATION_VERSION,
      stageId: this.activeStage.id,
      simTime: this.simTime,
      ephemerisContext: { ...ephemerisContextFor(this.celestialSystem.epoch) },
      entities: this.dynamicSystem.serialize(
        (id) => this.viewer.entityDisplay.showsTrajectoryLine(id), this.viewer.entityDisplay.proteinDisplay,
      ),
      activeControlledId: this.activeControllable?.id ?? null,
      stage: this.activeStage.serialize(),
      // 遊ぶ人の選択。
      ...this.viewer.serialize(),
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
    // ポーズは開いているオーバーレイからの導出値で「止まった瞬間」が無いので、止まっている
    // 間は毎フレーム連続指令を畳む。
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
  // 決着後も毎フレーム呼ぶ。simTime が止まっていれば予測は伸び切ったところで止まる。
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

  // ステージ → 指令決定 → 積分 → エフェクトの順に1フレーム進める
  // (残骸・弾の先端時刻はどの状況でも進め続ける)。boardTargetId は的面の通過を記録する対象の id。
  private advanceSimulation(dt: number, controls: PilotControls, boardTargetId: string | null): void {
    // このフレームで使う倍率を最初に一度だけ確定する。燃料消費・操作ゲート・積分が
    // 自動ワープの段階変更を跨いで別の倍率を読むと、同じ区間を表さなくなる。
    this.simSpeedManager.update(this.dynamicSystem.simTime);
    const simDt = dt * this.simSpeedManager.simSpeed;
    const canShipAct = this.simSpeedManager.canShipAct;
    const canEngage = this.simSpeedManager.canEngage;
    const controlled = this.activeControllable;
    // 台本が世界を編集してから、その顔ぶれで1フレーム進める。湧いた個体もこのフレームの
    // 指令決定と積分に乗る。
    this.sections.enter(SECTION.stage);
    this.activeStage.update(dt, this.dynamicSystem.simTime, this.simSpeedManager);
    this.sections.exit(SECTION.stage);
    this.dynamicSystem.update(
      controlled, controls, canShipAct, dt, simDt, canEngage, this.activeStage, this.activeStage.stageRules,
      () => this.applyPilotCommands(controls),
    );

    recordTargetBoardPasses(controlled, boardTargetId, this.dynamicSystem, this.events);
    this.controlSelection.reclaimDead();
  }

  // ステージ更新と自律推力の更新が終わった後、このフレームに受け付けた命令を操作対象へ適用する。
  private applyPilotCommands(controls: PilotControls): void {
    if (!this.activeStage.isPlaying || !this.simSpeedManager.canShipAct) return;
    if (this.activeControllable === null) return;
    for (const command of controls.commands) {
      this.activeControllable?.handleCommand(command, this.dynamicSystem);
    }
  }
}
