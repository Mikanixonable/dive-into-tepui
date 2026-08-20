// ゲーム全体のオーケストレーション: 各システムの生成・保持と、フレームごとの呼び出し順序の決定。
import * as THREE from 'three/webgpu';
import { CommNetwork } from './comms/comm-network';
import { FloatingOrigin } from './floating-origin';
import { v3 } from '../physics/vec3';
import type { PerfCounts } from '../perf-meter';
import { FrameSections, SECTION } from '../frame-sections';
import { Vessel } from './vessel/vessel';
import { CameraSystem } from './camera/camera-system';
import { Stage, StageClass } from './stages/stage';
import { MarkerManager } from './marker/marker-manager';
import { ActiveVesselController } from './active-vessel-controller';
import { UnlockManager } from './unlock-manager';
import { Targeter } from './targeter';
import { PlanEditor } from './plan/plan-editor';
import { DisplayWindowManager } from './display-window-manager';
import { PlanGuide } from './plan/plan-guide';
import { SimSpeedManager } from './sim-speed-manager';
import { EntityManager } from './simulation/entity-manager';
import { FutureAttractors } from './simulation/future-attractors';
import { EntityLineManager } from './entity-line-manager';
import { Simulator } from './simulation/simulator';
import { Predictor } from './simulation/predictor';
import { Input } from './input/input';
import { TouchControls } from './input/touch';
import { Hud } from './hud/hud';
import { PauseMenu } from './hud/pause-menu';
import { WorldSfx } from '../audio/sfx/world-sfx';
import { UiSfx } from '../audio/sfx/ui-sfx';
import { GameScene } from '../render/scene';
import type { GraphicsSettings } from '../render/graphics-settings';
import type { RenderPipeline } from '../render/pipeline/render-pipeline';
import { EnvironmentScene } from './celestial/environment-scene';
import type { Ephemeris } from '../physics/ephemeris';
import { ViewManager } from './view-manager';
import { NanWatchdog } from './nan-watchdog';
import { NavTarget } from './nav-target';
import { MapPickables } from './map-pickables';
import { MapContextActions } from './map-context-actions';
import { Navball } from './navball/navball';
import { GameSaveData } from './save-data';
import { KEY_MAPPING as K } from './input/key-mapping';
import { Docking } from './docking';
import { ViewBadge } from './hud/view-badge';
import { FrameControls } from './hud/frame-controls';
import { OperationsHudController, MapHudController } from './hud/view-hud-controller';

export class Game {
  private readonly _scene: THREE.Scene;
  private readonly pipeline: RenderPipeline;
  readonly input: Input;
  private readonly touchControls: TouchControls | null;
  private readonly _hud: Hud;
  private readonly _worldSfx: WorldSfx;
  private readonly _uiSfx: UiSfx;
  private readonly pauseMenu: PauseMenu;
  private readonly markerManager: MarkerManager;
  private readonly _ephemeris: Ephemeris;
  get ephemeris(): Ephemeris { return this._ephemeris; }
  readonly cameraSystem: CameraSystem;
  // 操作対象艦(0..n 隻のうちどれを操作するか)の切替を持つ。
  readonly activeVessels: ActiveVesselController;
  get player(): Vessel | null { return this.activeVessels.current; }
  // 追従カメラが見る対象。操作対象が居なければ生存中の基地を代わりに見る。
  get followedVessel(): Vessel | null {
    return this.player ?? this.entities.baseVessels().find((b) => b.alive) ?? null;
  }
  readonly simSpeedManager: SimSpeedManager;

  private readonly editor: PlanEditor;
  // このフレームの表示座標系・表示時刻窓と、表示側の重力源窓。update で確定させ sync でも読む。
  private readonly displayWindowManager: DisplayWindowManager;
  private readonly guide: PlanGuide;
  readonly viewManager: ViewManager;
  private readonly mapPickables: MapPickables;
  private readonly mapActions: MapContextActions;

  readonly activeStage: Stage;
  // ポーズは Game 自身の状態として持つ。SIM_SPEED_LEVELS は離散段で 0 を表現できないうえ、
  // 「時間を止めるか」と「どの倍率まで相互作用を成立させるか」は別の関心事なので、
  // SimSpeedManager へは寄せない。
  private _isPaused = false;
  get isPaused(): boolean { return this._isPaused; }

  private readonly _environment: EnvironmentScene;
  get environment(): EnvironmentScene { return this._environment; }
  private readonly navball: Navball;

  private readonly unlockManager: UnlockManager;

  readonly targeter: Targeter;
  readonly navTarget: NavTarget;
  readonly entities: EntityManager;
  private readonly futureAttractors: FutureAttractors;
  private readonly entityLines: EntityLineManager;
  readonly simulator: Simulator;
  private readonly predictor: Predictor;
  // 通信網。無人機へ指令が届くかを決める(§13)。
  private readonly commNetwork: CommNetwork;
  private readonly nanWatchdog: NanWatchdog;
  private readonly docking: Docking;
  private readonly viewBadge: ViewBadge;
  readonly frameControls: FrameControls;
  private readonly operationsHud: OperationsHudController;
  private readonly mapHud: MapHudController;
  // 計測区間の境界を打つ先。集計と保持はこのオブジェクトが持つ。
  private readonly sections: FrameSections;

  // 各サブシステムを、互いの依存関係が満たせる順に生成して配線する。
  constructor(
    gs: GameScene,
    stageClass: StageClass,
    hud: Hud,
    worldSfx: WorldSfx,
    uiSfx: UiSfx,
    pauseMenu: PauseMenu,
    unlockManager: UnlockManager,
    sections: FrameSections,
    ephemeris: Ephemeris,
    graphics: GraphicsSettings,
    pipeline: RenderPipeline,
    earthSpinPhase0: number,
    initialSave?: GameSaveData,
  ) {
    this.sections = sections;
    this._scene = gs.scene;
    this.pipeline = pipeline;
    this._hud = hud;
    this._worldSfx = worldSfx;
    this._uiSfx = uiSfx;
    this.pauseMenu = pauseMenu;
    this.unlockManager = unlockManager;

    this._ephemeris = ephemeris;

    this.markerManager = new MarkerManager(this._hud.layers.marker, this._hud.svgOverlay);

    this.entities = new EntityManager(this._scene, this._hud, this._worldSfx, this.markerManager, graphics, initialSave);
    this.futureAttractors = new FutureAttractors(this.ephemeris, this.entities);
    this.entityLines = new EntityLineManager(this.entities);
    this.displayWindowManager = new DisplayWindowManager(this._hud.mapRoot, this.ephemeris, this.entities);

    this.cameraSystem = new CameraSystem(
      this._hud,
      this.markerManager,
      this.ephemeris,
      initialSave?.camera,
    );
    this.simSpeedManager = new SimSpeedManager(this._hud, this._uiSfx);
    this.frameControls = new FrameControls(
      this._hud.mapRoot, this._hud.layers.popup, this.ephemeris, this.cameraSystem.mapCamera,
      this.displayWindowManager, this._hud.overlayManager,
    );

    this.targeter = new Targeter(this._hud, this.markerManager);
    this.navTarget = new NavTarget(this._hud, this.markerManager);
    this.navball = new Navball(this.cameraSystem.viewOptionsPanel);
    this._environment = new EnvironmentScene(this._scene, this.ephemeris, graphics, pipeline.sunLight, earthSpinPhase0);
    this.activeVessels = new ActiveVesselController(
      initialSave?.activePlayerId, this.entities, this.cameraSystem, this.targeter, this.navTarget, this._worldSfx, this._hud,
    );
    this.editor = new PlanEditor(
      this._hud,
      this._uiSfx,
      this.simSpeedManager,
      this.ephemeris,
      this.futureAttractors,
      this._scene,
      this.markerManager,
      this.activeVessels,
      this.displayWindowManager,
      this.frameControls,
    );
    this.guide = new PlanGuide(this._hud, this._uiSfx, this.markerManager);

    this.input = new Input(gs.renderer.domElement);
    this.touchControls = new TouchControls(this.input);
    this.input.onPointerKindChange = (kind) => this.touchControls?.setPointerKind(kind);
    this.input.onLongPressFeedback = (point) => {
      if (point) this.markerManager.set('longpress', 'mk-longpress', '', point.x, point.y, true);
      else this.markerManager.hide('longpress');
    };
    this._hud.vesselPanel.setInput(this.input);
    this.operationsHud = new OperationsHudController(this._hud);
    this.mapHud = new MapHudController(this._hud);

    this.simulator = new Simulator(this.entities, this.ephemeris, sections, initialSave?.simTime ?? 0);
    this.predictor = new Predictor(this.entities, this.ephemeris, this.futureAttractors);
    this.commNetwork = new CommNetwork();

    this.activeStage = new stageClass(
      initialSave?.stage, this._hud, this._worldSfx, this._uiSfx, this._scene, this.entities, this.unlockManager,
      this.entities.effects, this.markerManager, this.ephemeris, this.simulator, this.activeVessels,
      this.commNetwork, graphics,
    );
    this._hud.root.classList.toggle('creative-mode', this.activeStage.id === 'creative');
    // activeStage(authoring/executesPlans を読む)を要るので、その直後に生成する。
    this.mapPickables = new MapPickables(
      this.activeVessels, this.entities, this.ephemeris, this.navTarget, this.cameraSystem, this.editor, this.markerManager,
    );
    this.mapActions = new MapContextActions(
      this._hud, this.entities, this.ephemeris, this.navTarget,
      this.cameraSystem, this.editor, this.simSpeedManager, this.pauseMenu, this.mapPickables,
      this.activeVessels, this.frameControls, this.activeStage, this.targeter,
    );

    // 初期ビューは世界が組み上がった後にしか決まらない — 攻略ステージの自機は Stage の初期配置で
    // 置かれるので、戦闘ビューへ入れるかどうかはその後でなければ判定できない。
    this.viewManager = new ViewManager(
      this._hud, this.editor, this.cameraSystem, this.displayWindowManager, this.mapActions,
      this.activeVessels, this.touchControls,
      initialSave?.camera?.view,
    );

    this.nanWatchdog = new NanWatchdog(this._hud);
    this.docking = new Docking(
      () => this.pause(), () => this.resume(),
      this._hud, this._worldSfx, this._scene, this.entities.effects, this.markerManager, graphics,
      this.entities, this.mapActions, this.cameraSystem, this.viewManager,
      this.activeVessels,
    );
    this.mapActions.setDocking(this.docking);
    this.viewManager.setControlledBaseProvider(() => this.player);
    this.viewBadge = new ViewBadge(this._hud.layers.notify, this._hud.layers.notify, this.viewManager, this._hud.overlayManager);
  }

  // ------------------------------------------------------------------ lifecycle

  pause(): void {
    this.simulator.lastSimDt = 0;
    this._worldSfx.setThrust(false);
    // 一時停止へ入る際に、全自機の連続指令を畳む。
    this.entities.clearTransientCommands();
    this._isPaused = true;
  }

  resume(): void { this._isPaused = false; }

  // このゲームが scene・Hud・window/document/canvas へ足したものを残らず取り除く。呼んだ後の
  // このインスタンスは使えない。構築の逆順で辿るのは、後から組んだものほど先に組んだものを
  // 参照しているため。マーカープールを最後に空にするのは、各エンティティ・各表示物が自分の
  // dispose の中で自分のキーを外していくのを先に済ませるため。
  dispose(): void {
    this.viewBadge.dispose();
    this.docking.dispose();
    this.viewManager.dispose();
    this.mapActions.dispose();
    this.activeStage.dispose();
    // Hud・効果音はこのゲームより長生きするので、書き換えたクラス・差し込んだ参照・鳴らしている
    // 継続音を元へ戻す。BGM は周回の外側が決めるものなので触らない。
    this._hud.root.classList.remove('creative-mode');
    this._hud.vesselPanel.setInput(null);
    this._worldSfx.setThrust(false);
    this._worldSfx.setRcs(false);
    this.touchControls?.dispose();
    this.input.dispose();
    this.editor.dispose();
    this._environment.dispose();
    this.navTarget.dispose();
    this.frameControls.dispose();
    this.cameraSystem.dispose();
    this.displayWindowManager.dispose();
    this.entities.dispose();
    this.markerManager.dispose();
  }

  get simTime(): number { return this.simulator.simTime; }

  // ------------------------------------------------------------ update

  update(dtRaw: number): void {
    this.sections.enter(SECTION.input);
    this.input.update();
    const dt = Math.min(dtRaw, 0.1);
    // ポーズ中も Esc・ヘルプなどは効かせるので、入力配分はポーズ判定より前に置く。
    this.handleInput(dt);
    this.sections.exit(SECTION.input);

    if (!this._isPaused && this.activeStage.isPlaying) this.advanceSimulation(dt);
    // ポーズ中も決着後も飛ばせない。決着は積分を止めないので、飛ばすと描画原点になるカメラ位置
    // だけが絶対 ECI に取り残され、追従対象もフォーカス天体も軌道速度で流れて即フレームアウトする。
    // ポーズ中は積分が止まるが、カメラの旋回・ズーム・パンの入力をここで消化している。
    const activeControllable = this.followedVessel;
    const displayWindow = this.displayWindowManager.resolve(this.simulator.simTime, activeControllable);
    const overviewMode = this.cameraSystem.overviewMode;
    const canDisplayFuture = !this.displayWindowManager.forceCurrent;
    // 計画表示、予測伸長、選択候補、カメラはこの順序で同じ時刻の状態へ更新する。
    this._environment.update(displayWindow.displayTime, overviewMode);
    this.sections.enter(SECTION.plan);
    this.editor.update(displayWindow);
    this.sections.exit(SECTION.plan);
    // ポーズ中・決着後も無条件に呼ぶ: simTime が止まっている間は乖離が起きないので、
    // 予測は伸び切ったところで止まるだけで害はない。
    this.sections.enter(SECTION.predict);
    this.predictor.update(
      this.simulator.simTime, this.player, displayWindow.duration,
      canDisplayFuture, this.editor.growableArcs(),
    );
    this.sections.exit(SECTION.predict);
    this.sections.enter(SECTION.plan);
    this.targeter.updateEquatorNodes(overviewMode, displayWindow, this.ephemeris);
    this.entities.updateBaseEquatorNodes(overviewMode, displayWindow, this.ephemeris);
    this.sections.exit(SECTION.plan);
    this.sections.enter(SECTION.camera);
    this.cameraSystem.update(
      activeControllable, displayWindow.displayTime, this.input, dt, this.mapPickables.pickables,
      this.displayWindowManager.attractorsAt(displayWindow.displayTime),
    );
    this.sections.exit(SECTION.camera);
    // カメラ更新の後に置く: 候補集合と表示可否はカメラ位置から出るので、先に組むと
    // このフレームの sync が1フレーム古いカメラ位置基準の判定を読むことになる。
    this.sections.enter(SECTION.mapPick);
    this.mapPickables.refresh(displayWindow);
    this.sections.exit(SECTION.mapPick);
    this.sections.enter(SECTION.pointer);
    this.handlePointerInput();
    // カメラ行列がこのフレームの値になった後でなければ、掴んでいる部品の落とし先が1フレーム
    // 古いカメラ基準で決まる。
    this.docking.updateAssembly(this.input);
    this.sections.exit(SECTION.pointer);

    // 表示可否・ターゲット・操作艦・ビューがこのフレームの確定値になった後に判断する。
    this.entityLines.update(
      this.player, this.targeter.aliveTarget, this.targeter.aliveSecondaryTarget,
      overviewMode, displayWindow, this.mapPickables.visibilityPolicy,
    );
  }

  // 自機の行動 → ステージ → 積分 → エフェクトの順に1フレーム進める
  // (残骸・弾の epoch はどの状況でも進め続ける)。
  private advanceSimulation(dt: number): void {
    // 過去表示に要る履歴の長さを、積分がサンプルを積む前に要求しておく。表示窓は前フレームの
    // 確定値でよい — 保持窓が1フレーム遅れても描ける区間は変わらない。
    this.entities.requestHistoryDuration(this.displayWindowManager.current.pastDuration);
    this.sections.enter(SECTION.player);
    this.nanWatchdog.checkPlayer('frameStart', this.player, this.simulator.simTime, dt, this.simulator.lastSimDt);
    this.entities.updateVessels(
      this.player, this.input, this.simSpeedManager, dt, this.activeStage, this.ephemeris,
    );
    this.nanWatchdog.checkPlayer(
      'entities.updateVessels',
      this.player,
      this.simulator.simTime,
      dt,
      this.simulator.lastSimDt,
    );
    this.sections.exit(SECTION.player);

    // ステージが無人機の計画を進める前に、この時点の通信網を確定させる。
    this.commNetwork.update(
      this.simulator.simTime, this.ephemeris, this.entities.vessels,
      this.ephemeris.attractorsAt(this.simulator.simTime),
    );

    this.sections.enter(SECTION.stage);
    this.activeStage.update(dt, this.player, this.entities, this.simulator.simTime, this.simSpeedManager);
    this.sections.exit(SECTION.stage);
    this.nanWatchdog.checkPlayer('activeStage.update', this.player, this.simulator.simTime, dt, this.simulator.lastSimDt);
    this.simSpeedManager.update(this.simulator.simTime);

    const simDt = dt * this.simSpeedManager.simSpeed;
    this.sections.enter(SECTION.integrate);
    this.simulator.advance(dt, simDt, this.player, this.activeStage, this.simSpeedManager, this.nanWatchdog);
    this.sections.exit(SECTION.integrate);
    this.docking.updateDockedPhysics();
    // 積分後の状態でこのフレームの表示窓を確定させ、以降の消費者へ共有する。
    this.displayWindowManager.resolve(this.simulator.simTime, this.followedVessel);
    // 薬莢や破片が先に壊れて接触経由で自機へ伝播することがあるので、ここは全エンティティを見る。
    this.nanWatchdog.checkAll('simulator.advance', this.player, this.entities, this.simulator.simTime, dt, simDt);

    this.targeter.updateBoardMarks(dt, this.player, this.entities);
    this.activeVessels.reclaimDead();
    this.docking.checkProximity();

    this.sections.enter(SECTION.effects);
    this.entities.effects.update(dt, this.simulator.simTime);
    this.sections.exit(SECTION.effects);

    this.sections.enter(SECTION.plan);
    this.guide.update(
      this.player, this.simulator.simTime, this.editor.editMode,
      this.ephemeris.attractorsAt(this.simulator.simTime),
    );
    this.sections.exit(SECTION.plan);
  }

  // ポインタ入力をビューに応じて配分する。各受け手はいまがマップ視点か・操作艦の有無かを
  // 自分で見るので、ここで決めるのは順序だけ。このフレームの cameraSystem.update が終わって
  // 初めて投影がこのフレームの値になるので、update の末尾に置く。ポーズ中、または入力を
  // ゲートするオーバーレイ(セーブブラウザ・基地画面等)が開いている間は配らない(背景の誤操作を防ぐ)。
  private handlePointerInput(): void {
    if (this._isPaused || this._hud.overlayManager.isInputGated()) return;
    const simTime = this.simulator.simTime;
    if (this.viewManager.isMapView) {
      this.handleMapPointerInput(simTime);
    } else {
      this.handleCombatPointerInput(simTime);
    }
  }

  private handleCombatPointerInput(simTime: number): void {
    if (!this.player) return;
    const project = this.cameraSystem.activeCameraProjection;
    const overviewMode = this.cameraSystem.overviewMode;
    const combatTargets = this.entities.getCombatTargets(this.player);
    this.targeter.handleTargetSelectKey(this.input, combatTargets, project, overviewMode);
    this.mapActions.handleCombatRightClick(this.input, simTime, overviewMode);
  }

  private handleMapPointerInput(simTime: number): void {
    this.mapActions.handleMapRightClick(this.input, simTime);
    this.mapActions.handleLeftClick(this.input);
    this.mapActions.handleDoubleClick(this.input);
    this.editor.handleMapPointer(this.input);
    this.mapActions.handleEmptySpaceRightClick(this.input, simTime);
  }

  // --------------------------------------------------------------- input

  // 入力エッジを担当モジュールへ先着順で配る。決めるのは優先順位 = 呼ぶ順序だけで、
  // どのキー/クリックが何をするかは各モジュールが持つ。ここで配るのは、決着後・ポーズ中も
  // 効くべき操作(設定・ヘルプ・再出撃・ワープ・マップ開閉・計画破棄・計画のΔv編集)。
  private handleInput(dt: number): void {
    // ESC の持ち主はここ一箇所だけ: 開いているオーバーレイがあれば最前面を閉じ、
    // 何も無ければ一時停止メニューを開く。個々のオーバーレイの開閉判断は持たない。
    if (this.input.takeKey(K.pauseMenu)) {
      if (!this._hud.overlayManager.closeTopmostOnEscape()) this.pauseMenu.toggle(true);
    }
    // オーバーレイの項目ショートカット([F]等)も同じ優先度で最前面へ配送する。
    this.input.takeKeys((code) => this._hud.overlayManager.dispatchShortcut(code));
    // 上から下へ優先順位順に呼ぶ。
    this._hud.handleInput(this.input);
    this.simSpeedManager.handleInput(this.input);
    this.viewManager.handleInput(this.input);
    if (this.viewManager.isMapView) this.editor.handleInput(this.input, dt);
  }

  // ------------------------------------------------------------------ sync

  sync(): void {
    const activeControllable = this.followedVessel;
    const player = this.player;
    // 積分が終わった状態でこのフレームの表示窓を確定させ、sync 全体で共有する。
    const displayWindow = this.displayWindowManager.resolve(this.simulator.simTime, activeControllable);
    this.viewBadge.sync(this.activeStage.stageClass.selectLabel);
    // 原点(位置)はアクティブカメラの ECI 位置 — cameraSystem.update() は update フェーズの
    // 毎フレーム呼ばれるので、この sync の時点で activeCameraPos は確定済み。
    // 速度基準は自機のまま(弾の相対速度描画・再突入エフェクトが前提とする値で、原点とは別concern)。
    const fo = new FloatingOrigin(this.cameraSystem.activeCameraPos, activeControllable?.state.v ?? v3());

    // 表示時刻 = 未来ゴーストのスライダーぶん先取りした simTime。
    const { displayTime, simTime } = displayWindow;
    // 表示側は重力を持つ生存中の GameEntity(小惑星)も中心天体解決・遮蔽判定へ合流させる —
    // EntityManager.cleanup へ渡す表面到達判定用の配列(解析天体のみ)とは別物。
    // 現在時刻の配列は「いまの状態」を数値で読ませる HUD・プロパティ行が使い、表示時刻の配列は
    // 画面に描く幾何(軌道線・折れ線・天体位置)が使う — 天体メッシュは displayTime に置かれるので、
    // 楕円の中心天体位置や折れ線の un-bake を simTime で取ると同一画面上でずれる。
    const attractors = this.displayWindowManager.attractorsAt(simTime);
    const displayAttractors = this.displayWindowManager.attractorsAt(displayTime);

    // 最初に行う: 後続の sync とマーカー投影がこのフレームのカメラ行列を読む。
    this.cameraSystem.sync(fo);

    const project = this.cameraSystem.activeCameraProjection;
    const overviewMode = this.cameraSystem.overviewMode;
    // 表示・選択可否はこのフレームの update フェーズで MapPickables が確定させたものを読む
    // (選べる対象と描かれる対象が同じ判定から出るようにする)。
    const visibilityPolicy = this.mapPickables.visibilityPolicy;
    const combatTargets = this.entities.getCombatTargets(player);

    this._environment.sync(
      player?.state.r ?? null, fo, displayTime,
      this.cameraSystem, this.navball.gridVisibility, visibilityPolicy,
      this.markerManager,
    );

    this.entities.syncVessels(
      player, fo, this.cameraSystem, displayTime, this.ephemeris, displayAttractors, visibilityPolicy, displayWindow,
    );
    this.entities.sync(fo, displayTime);
    this.entities.applyVisibility(visibilityPolicy, player);
    this.entities.syncMarkers(this.cameraSystem, displayTime, player?.state.r ?? null, displayAttractors, visibilityPolicy, player);

    this.entities.effects.sync(fo, this.cameraSystem.activeCamera, this.cameraSystem.zoomActive);

    this.targeter.sync(player, this.cameraSystem);
    this.targeter.syncTargetMarkers(
      player, combatTargets, displayTime, simTime, this.cameraSystem, visibilityPolicy,
      this.ephemeris.registry, displayAttractors,
    );
    this.cameraSystem.focusMarkers.syncSubLabels(
      this.markerManager.combatMarkers, this.ephemeris.registry, displayAttractors,
      overviewMode, project, this.cameraSystem.activeCameraPos,
    );
    this.navTarget.sync(this.cameraSystem);
    this.entities.syncEquatorNodes(this.cameraSystem);
    this.mapPickables.syncVisibility();

    if (this.viewManager.isMapView) {
      this.displayWindowManager.sync(player);
      this.frameControls.sync(
        this.mapPickables.pickables, this.cameraSystem.activeCameraPos, attractors, simTime, overviewMode,
      );
    }
    // マップの常設一覧はマップ時だけ更新するが、戦闘中に開いたプロパティウィンドウは
    // 最新値を表示し続ける必要がある。MapContextActions 側で窓が無ければ即時 return する。
    this.mapActions.sync(simTime, attractors, player);
    this.editor.sync(this.cameraSystem, simTime, fo);
    this.docking.syncAssembly(fo);

    // 計画軌道の折れ線と同じ座標系で描かないと、同一画面上で並べたときに比較にならない。
    this.entityLines.sync(displayWindow, fo, this.cameraSystem.activeCamera, displayAttractors, this.ephemeris);

    if (player) {
      this.touchControls?.syncModeButtons(
        player.rcsDamp, player.fineAttitude, player.progradeHold,
        (key) => player.throttle.isThrustLatched(key),
      );
    }
    this.activeStage.sync(player, fo, this.cameraSystem, displayTime, visibilityPolicy);

    if (this.viewManager.isMapView) this.mapHud.sync(this);
    else this.operationsHud.sync(this, attractors);
    this._hud.tick();

    this.guide.sync(player, simTime, this.editor.editMode, project, this.editor.planDisplay.path);

    // このフレームのマーカーが出揃った後でなければならないので最後に置く。
    this.markerManager.resolveCollisions(this.cameraSystem.overviewMode);
  }

  // ------------------------------------------------------------------ render

  render(): void {
    if (!this.viewManager.rendersWorld) return;
    this.pipeline.render(this._scene, this.cameraSystem.activeCamera);
  }

  // ------------------------------------------------------------------ debug

  // 負荷確認ウィンドウが読む値。各数値はそれを持つモジュールが答え、ここは合流させるだけ。
  perfCounts(): PerfCounts {
    return {
      ...this.entities.perfCounts(),
      ...this.predictor.perfCounts(),
      ...this.simulator.perfCounts(),
      ...this.editor.perfCounts(),
      ...this._ephemeris.perfCounts(),
      ...this.mapPickables.perfCounts(),
      displayDurationSec: this.displayWindowManager.current.duration,
      warp: this.simSpeedManager.simSpeed,
    };
  }
}
