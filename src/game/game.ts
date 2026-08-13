// ゲーム全体のオーケストレーション: 各システムの生成・保持と、フレームごとの呼び出し順序の決定。
import * as THREE from 'three/webgpu';
import { FloatingOrigin } from './floating-origin';
import { v3 } from '../physics/vec3';
import type { PerfCounts } from '../perf-meter';
import { FrameSections, SECTION } from '../frame-sections';
import { Player } from './player/player';
import { CameraSystem } from './camera/camera-system';
import { Stage, StageClass } from './stages/stage';
import { MarkerManager } from './marker/marker-manager';
import { ActivePlayerController } from './active-player-controller';
import { UnlockManager } from './unlock-manager';
import { Targeter } from './targeter';
import { PlanEditor } from './plan/plan-editor';
import { DisplayWindowManager } from './display-window-manager';
import { PlanGuide } from './plan/plan-guide';
import { SimSpeedManager } from './sim-speed-manager';
import { EntityManager } from './simulation/entity-manager';
import { Simulator } from './simulation/simulator';
import { Predictor } from './simulation/predictor';
import { Input } from './input/input';
import { TouchControls } from './input/touch';
import { Hud } from './hud/hud';
import { SettingsPanel } from './hud/settings-panel';
import { Sfx } from '../audio/sfx';
import { GameScene } from '../render/scene';
import { EnvironmentScene } from './celestial/environment-scene';
import type { Ephemeris } from '../physics/ephemeris';
import { ViewManager } from './view-manager';
import { NanWatchdog } from './nan-watchdog';
import { NavTarget } from './nav-target';
import { MapPicker } from './map-picker';
import { Navball } from './navball/navball';
import { GameSaveData } from './save-data';
import { Docking } from './docking';
import { ViewBadge } from './hud/view-badge';
import { FrameControls } from './frame-controls';

export class Game {
  private readonly _scene: THREE.Scene;
  private readonly renderer: GameScene['renderer'];
  readonly input: Input;
  private readonly touchControls: TouchControls | null;
  private readonly _hud: Hud;
  private readonly _sfx: Sfx;
  private readonly settingsPanel: SettingsPanel;
  private readonly markerManager: MarkerManager;
  private readonly _ephemeris: Ephemeris;
  get ephemeris(): Ephemeris { return this._ephemeris; }
  readonly cameraSystem: CameraSystem;
  // 操作対象艦(0..n 隻のうちどれを操作するか)の切替を持つ。
  readonly activePlayers: ActivePlayerController;
  get player(): Player | null { return this.activePlayers.current; }
  readonly simSpeedManager: SimSpeedManager;

  private readonly editor: PlanEditor;
  // このフレームの表示座標系・表示時刻窓と、表示側の重力源窓。update で確定させ sync でも読む。
  private readonly displayWindowManager: DisplayWindowManager;
  private readonly guide: PlanGuide;
  readonly viewManager: ViewManager;
  private readonly mapPicker: MapPicker;

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
  readonly simulator: Simulator;
  private readonly predictor: Predictor;
  private readonly nanWatchdog: NanWatchdog;
  private readonly docking: Docking;
  private readonly viewBadge: ViewBadge;
  readonly frameControls: FrameControls;
  // 計測区間の境界を打つ先。集計と保持はこのオブジェクトが持つ。
  private readonly sections: FrameSections;

  // 各サブシステムを、互いの依存関係が満たせる順に生成して配線する。
  constructor(
    gs: GameScene,
    stageClass: StageClass,
    hud: Hud,
    sfx: Sfx,
    settingsPanel: SettingsPanel,
    unlockManager: UnlockManager,
    sections: FrameSections,
    ephemeris: Ephemeris,
    earthSpinPhase0: number,
    initialSave?: GameSaveData,
  ) {
    this.sections = sections;
    this._scene = gs.scene;
    this.renderer = gs.renderer;
    this._hud = hud;
    this._sfx = sfx;
    this.settingsPanel = settingsPanel;
    this.unlockManager = unlockManager;

    this._ephemeris = ephemeris;

    this.markerManager = new MarkerManager(this._hud.layers.marker, this._hud.svgOverlay);

    this.entities = new EntityManager(this._scene, this._hud, this._sfx, this.markerManager, initialSave);
    this.displayWindowManager = new DisplayWindowManager(this._hud.layers.panel, this.ephemeris, this.entities);

    this.cameraSystem = new CameraSystem(
      this._hud,
      this.markerManager,
      this.ephemeris,
      initialSave?.camera,
    );
    this.simSpeedManager = new SimSpeedManager(this._hud, this._sfx);
    this.frameControls = new FrameControls(
      this._hud.layers.panel, this._hud.layers.popup, this.ephemeris, this.cameraSystem.overviewCamera,
      this.displayWindowManager,
    );

    this.targeter = new Targeter(this._hud, this._sfx, this.markerManager, this._scene, this.settingsPanel);
    this.navTarget = new NavTarget(this._hud, this.markerManager);
    this.navball = new Navball(this._hud.layers.panel);
    this._environment = new EnvironmentScene(this._scene, this.ephemeris, earthSpinPhase0);
    this.activePlayers = new ActivePlayerController(
      initialSave?.activePlayerId, this.entities, this.cameraSystem, this.targeter, this.navTarget, this._sfx,
    );
    this.editor = new PlanEditor(
      this._hud,
      this._sfx,
      this.simSpeedManager,
      this.ephemeris,
      this.entities,
      this._scene,
      this.markerManager,
      this.activePlayers,
      this.displayWindowManager,
      this.frameControls,
    );
    this.guide = new PlanGuide(this._hud, this._sfx, this.markerManager);

    this.input = new Input(gs.renderer.domElement);
    this.input.onFirstGesture = () => this._sfx.unlock();
    // 空実装で置き換えないのは、TouchControls のコンストラクタが仮想パッドを document.body へ
    // 足す副作用を持ち、無害な空実装がインターフェースの新設なしには作れないため。
    this.touchControls = TouchControls.isTouchDevice() ? new TouchControls(this.input) : null;

    this.simulator = new Simulator(this.entities, this.ephemeris, sections, initialSave?.simTime ?? 0);
    this.predictor = new Predictor(this.entities, this.ephemeris);

    this.activeStage = new stageClass(
      initialSave?.stage, this._hud, this._sfx, this._scene, this.entities, this.unlockManager,
      this.entities.effects, this.markerManager, this.ephemeris, this.simulator, this.activePlayers,
    );
    this.mapPicker = new MapPicker(
      this._hud, this.entities, this.ephemeris, this.navTarget,
      this.cameraSystem, this.editor, this.simSpeedManager, this.settingsPanel,
      this.activePlayers, this.frameControls, this.activeStage,
    );

    // 初期ビューは世界が組み上がった後にしか決まらない — 攻略ステージの自機は Stage の初期配置で
    // 置かれるので、戦闘ビューへ入れるかどうかはその後でなければ判定できない。
    this.viewManager = new ViewManager(
      this._hud, this.editor, this.cameraSystem, this.displayWindowManager, this.mapPicker,
      this.activePlayers, this.touchControls,
      initialSave?.camera?.view,
    );

    this.nanWatchdog = new NanWatchdog(this._hud);
    this.docking = new Docking(
      () => this.pause(), () => this.resume(),
      this._hud, this._sfx, this._scene, this.entities.effects, this.markerManager,
      this.entities, this.mapPicker, this.cameraSystem, this.viewManager,
      this.activePlayers, this.activeStage,
    );
    this.mapPicker.setDocking(this.docking);
    this.viewBadge = new ViewBadge(this._hud.layers.notify, this._hud.layers.popup, this.viewManager);
  }

  // ------------------------------------------------------------------ lifecycle

  pause(): void {
    this.simulator.lastSimDt = 0;
    this._sfx.setThrust(false);
    // ポーズ中は behave が走らないので、全自機の連続指令はここで畳む。
    this.entities.clearTransientCommands();
    this._isPaused = true;
  }

  resume(): void { this._isPaused = false; }

  get simTime(): number { return this.simulator.simTime; }

  // ------------------------------------------------------------ update

  update(dtRaw: number): void {
    this.sections.enter(SECTION.input);
    this.input.update();
    const dt = Math.min(dtRaw, 0.1);
    // ポーズ中も Esc・ヘルプなどは効かせるので、入力配分はポーズ判定より前に置く。
    this.handleInput(dt);
    this.sections.exit(SECTION.input);

    if (!this._isPaused) this.advanceSimulation(dt);
    // ポーズ中も決着後も飛ばせない。決着は積分を止めないので、飛ばすと描画原点になるカメラ位置
    // だけが絶対 ECI に取り残され、追従対象もフォーカス天体も軌道速度で流れて即フレームアウトする。
    // ポーズ中は積分が止まるが、カメラの旋回・ズーム・パンの入力をここで消化している。
    const displayWindow = this.displayWindowManager.resolve(this.simulator.simTime, this.player);
    const overviewMode = this.cameraSystem.overviewMode;
    // 計画表示、選択候補、カメラはこの順序で同じ時刻の状態へ更新する。
    this._environment.update(displayWindow.displayTime, overviewMode);
    this.sections.enter(SECTION.plan);
    this.editor.update(displayWindow);
    this.targeter.updateEquatorNodes(overviewMode, displayWindow, this.ephemeris);
    this.entities.updateBaseEquatorNodes(overviewMode, displayWindow, this.ephemeris);
    this.sections.exit(SECTION.plan);
    this.sections.enter(SECTION.mapPick);
    this.mapPicker.refresh(displayWindow);
    this.sections.exit(SECTION.mapPick);
    this.sections.enter(SECTION.camera);
    this.cameraSystem.update(
      this.player, this.simulator.simTime, this.input, dt, this.mapPicker.pickables,
      this.displayWindowManager.attractorsAt(this.simulator.simTime),
    );
    this.sections.exit(SECTION.camera);
    this.sections.enter(SECTION.pointer);
    this.handlePointerInput();
    this.sections.exit(SECTION.pointer);
  }

  // 自機の行動 → ステージ → 積分 → 予測 → エフェクトの順に1フレーム進める
  // (残骸・弾の epoch はどの状況でも進め続ける)。
  private advanceSimulation(dt: number): void {
    this.sections.enter(SECTION.player);
    this.nanWatchdog.checkPlayer('frameStart', this.player, this.simulator.simTime, dt, this.simulator.lastSimDt);
    this.entities.updatePlayers(
      this.player, this.input, this.simSpeedManager, dt, this.activeStage, this.ephemeris,
    );
    this.nanWatchdog.checkPlayer('player.behave', this.player, this.simulator.simTime, dt, this.simulator.lastSimDt);
    this.sections.exit(SECTION.player);

    this.sections.enter(SECTION.stage);
    this.activeStage.update(dt, this.player, this.entities, this.simulator.simTime, this.simSpeedManager);
    this.sections.exit(SECTION.stage);
    this.nanWatchdog.checkPlayer('activeStage.update', this.player, this.simulator.simTime, dt, this.simulator.lastSimDt);
    this.simSpeedManager.update(this.simulator.simTime);

    const simDt = dt * this.simSpeedManager.simSpeed;
    this.sections.enter(SECTION.integrate);
    this.simulator.advance(dt, simDt, this.player, this.activeStage, this.simSpeedManager, this.nanWatchdog);
    this.sections.exit(SECTION.integrate);
    // 積分後の状態でこのフレームの表示窓を確定させ、以降の消費者へ共有する。
    this.displayWindowManager.resolve(this.simulator.simTime, this.player);
    // 薬莢や破片が先に壊れて接触経由で自機へ伝播することがあるので、ここは全エンティティを見る。
    this.nanWatchdog.checkAll('simulator.advance', this.player, this.entities, this.simulator.simTime, dt, simDt);

    this.targeter.updateBoardMarks(dt, this.player, this.entities);
    this.activePlayers.reclaimDead();
    this.docking.checkProximity();

    // Simulator 内の substep cleanup 後に呼ぶ: 死んだ個体を予測せず、積分後の実状態と突き合わせる。
    this.sections.enter(SECTION.predict);
    this.predictor.update(
      this.simulator.simTime, this.player, this.displayWindowManager.current.duration,
      this.cameraSystem.overviewMode ? 'map' : 'combat',
    );
    this.sections.exit(SECTION.predict);

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

  // ポインタ入力を優先順位順(=呼ぶ順)に配る。各受け手はいまがマップ視点か・編集モードかを
  // 自分で見るので、ここで決めるのは順序だけ。このフレームの cameraSystem.update が終わって
  // 初めて投影がこのフレームの値になるので、update の末尾に置く。ポーズ中は
  // ESC メニュー等が開いていないときだけ配る(背景の誤操作を防ぐ)。
  private handlePointerInput(): void {
    if (this._isPaused && this._hud.modalController.isOpen) return;
    const simTime = this.simulator.simTime;
    this.mapPicker.handleRightClick(this.input, simTime);
    this.mapPicker.handleLeftClick(this.input);
    this.mapPicker.handleDoubleClick(this.input);
    this.editor.handleMapPointer(this.input);
    this.mapPicker.handleEmptySpaceRightClick(this.input, simTime);
    // ドック表示中など、ポーズ中は背後の 3D 世界が見えないまま当たり判定だけが生きてしまう
    // ので、戦闘ビュー側はポーズ中には配らない。
    if (this._isPaused) return;
    const project = this.cameraSystem.activeCameraProjection;
    const overviewMode = this.cameraSystem.overviewMode;
    this.navTarget.updateCombatBasePicking(this.entities, this.input, project, overviewMode);
    this.targeter.updateCombatTargeting(
      this.player, this.entities.getCombatTargets(this.player), this.input, project, overviewMode,
    );
  }

  // --------------------------------------------------------------- input

  // 入力エッジを担当モジュールへ先着順で配る。決めるのは優先順位 = 呼ぶ順序だけで、
  // どのキー/クリックが何をするかは各モジュールが持つ。ここで配るのは、決着後・ポーズ中も
  // 効くべき操作(設定・ヘルプ・再出撃・ワープ・マップ開閉・計画破棄・計画のΔv編集)。
  private handleInput(dt: number): void {
    // 上から下へ優先順位順に呼ぶ。
    this.docking.handleInput(this.input);
    this.settingsPanel.handleInput(this.input);
    this._hud.handleInput(this.input);
    this.simSpeedManager.handleInput(this.input);
    this.viewManager.handleInput(this.input);
    this.editor.handleInput(this.input, dt);
  }

  // ------------------------------------------------------------------ sync

  sync(): void {
    const player = this.player;
    // 積分が終わった状態でこのフレームの表示窓を確定させ、sync 全体で共有する。
    const displayWindow = this.displayWindowManager.resolve(this.simulator.simTime, player);
    this.viewBadge.sync(this.activeStage.stageClass.selectLabel);
    // 原点(位置)はアクティブカメラの ECI 位置 — cameraSystem.update() は update フェーズの
    // 毎フレーム呼ばれるので、この sync の時点で activeCameraPos は確定済み。
    // 速度基準は自機のまま(弾の相対速度描画・再突入エフェクトが前提とする値で、原点とは別concern)。
    const fo = new FloatingOrigin(this.cameraSystem.activeCameraPos, player?.state.v ?? v3());

    // 表示時刻 = 未来ゴーストのスライダーぶん先取りした simTime。
    const { displayTime, simTime } = displayWindow;
    // 表示側は重力を持つ生存中の GameEntity(小惑星)も中心天体解決・遮蔽判定へ合流させる —
    // EntityManager.cleanup へ渡す表面到達判定用の配列(解析天体のみ)とは別物。
    const attractors = this.displayWindowManager.attractorsAt(simTime);

    // 最初に行う: 後続の sync とマーカー投影がこのフレームのカメラ行列を読む。
    this.cameraSystem.sync(fo);

    const project = this.cameraSystem.activeCameraProjection;
    const overviewMode = this.cameraSystem.overviewMode;
    // 表示・選択可否はこのフレームの update フェーズで MapPicker が確定させたものを読む
    // (選べる対象と描かれる対象が同じ判定から出るようにする)。
    const visibilityPolicy = this.mapPicker.visibilityPolicy;
    const combatTargets = this.entities.getCombatTargets(player);

    this._environment.sync(
      player?.state.r ?? null, fo, displayTime,
      this.cameraSystem, this.navball.gridVisibility, visibilityPolicy,
    );

    this.entities.syncPlayers(
      player, fo, this.cameraSystem, displayTime, this.ephemeris, attractors, visibilityPolicy,
    );
    this.entities.sync(fo, displayTime);
    this.entities.applyVisibility(
      visibilityPolicy, player, overviewMode, fo, this.cameraSystem.activeCamera, attractors,
    );
    this.entities.syncMarkers(this.cameraSystem, displayTime, player?.state.r ?? null, visibilityPolicy);

    this.entities.effects.sync(fo, this.cameraSystem.activeCamera, this.cameraSystem.zoomActive);

    this.targeter.sync(fo, player, combatTargets, this.cameraSystem, attractors, visibilityPolicy);
    this.targeter.syncTargetMarkers(
      player, combatTargets, displayTime, simTime, this.cameraSystem, visibilityPolicy,
    );
    this.navTarget.sync(this.cameraSystem);
    this.entities.syncEquatorNodes(this.cameraSystem);

    this.displayWindowManager.sync(player);
    this.editor.sync(this.cameraSystem, simTime, fo);
    this.mapPicker.sync(simTime, attractors, player);
    this.frameControls.sync(
      this.mapPicker.pickables, this.cameraSystem.activeCameraPos, attractors, simTime, overviewMode,
    );

    // 計画軌道の折れ線と同じ座標系で描かないと、同一画面上で並べたときに比較にならない。
    this.entities.syncPlayerTrajectoryLines(
      player, displayWindow, overviewMode, this.ephemeris, fo,
      this.cameraSystem.activeCamera, attractors,
    );

    if (player) {
      this.touchControls?.syncModeButtons(player.rcsDamp, player.fineAttitude, player.progradeHold);
    }
    this.activeStage.sync(player, fo, this.cameraSystem, displayTime, visibilityPolicy);

    this._hud.panels.sync(this, attractors);
    this._hud.tick();

    this.guide.sync(player, simTime, this.editor.editMode, project);

    // このフレームのマーカーが出揃った後でなければならないので最後に置く。
    this.markerManager.resolveCollisions();
  }

  // ------------------------------------------------------------------ render

  render(): void {
    if (!this.viewManager.rendersWorld) return;
    this.renderer.render(this._scene, this.cameraSystem.activeCamera);
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
      ...this.mapPicker.perfCounts(),
      displayDurationSec: this.displayWindowManager.current.duration,
      warp: this.simSpeedManager.simSpeed,
    };
  }
}
