// 1ランの表示の導出の根: 入力の解釈、表示窓・座標系の錨・カメラの導出、表示物と HUD への同期、
// 描画を所有する。モデル層の根 Game を読み、命令の列へ積み、進行の末尾へ渡す材料を組む。
import type { FrameSections } from './frame-sections';
import { CameraSystem } from './camera/camera-system';
import { controlSelectionCommands } from './control-selection-commands';
import { simSpeedCommands } from './dynamic/sim-speed-commands';
import { objectMenuCommands } from './pickable/object-menu-commands';
import { planCommands } from './plan/plan-commands';
import { PlayerMarkers } from './marker/player-markers';
import { isModularShip } from './ship/modular-ship';
import { CelestialMarkers } from './marker/celestial-markers';
import { EquatorNodeManager } from './marker/equator-node-manager';
import { Targeter } from './targeter';
import { PlanDisplay } from './plan/plan-display';
import { PlanGuide } from './plan/plan-guide';
import { DisplayWindowManager, timeLabelSettingOf } from './display-window-manager';
import { RunEventPresenter, worldSoundCues } from './run-event-presenter';
import { FlashPresenter } from './flash-presenter';
import { FlashEffectsView } from '../render/vfx/flash-effects-view';
import { EntityLineManager } from './lines/entity-line-manager';
import { Input } from '../input/input';
import { TouchControls } from './hud/touch-controls';
import { WorldSfx } from '../audio/sfx/world-sfx';
import { UiSfx } from '../audio/sfx/ui-sfx';
import { CameraView } from '../render/camera/camera-view';
import { ViewManager } from './view/view-manager';
import { CombatFrame } from './view/combat-frame';
import { MapFrame } from './view/map-frame';
import { PlanPath } from './plan/plan-path';
import { NavTargetPresenter } from './nav-target-presenter';
import { AnchorEntities, FrameAnchors } from './frame-anchors';
import { resolveOrbitReference } from './orbit-reference';
import { navTargetCommands } from './viewer/nav-target-commands';
import { viewCommands } from './viewer/view-commands';
import { orbitGuideCommands } from './viewer/orbit-guide-commands';
import { predictPanelCommands } from './viewer/predict-panel-commands';
import { cameraCommands } from './viewer/camera-commands';
import { entityDisplayCommands } from './viewer/entity-display-commands';
import { ObjectWindows } from './pickable/object-windows';
import { ObjectWindowActions } from './pickable/object-window-actions';
import { ModuleWindows } from './pickable/module-windows';
import { ShipConstruction } from './ship/ship-construction';
import { FrameControls } from './hud/frame/frame-controls';
import { HudPanelPresenter } from './hud/hud-panel-presenter';
import { ViewOptionsControl, type ViewOptionsSettings } from './hud/panels/view-options-control';
import { controlledLoopSfx } from './controlled-loop-sfx';
import { UiSoundQueue } from './ui-sound-queue';
import { GameInputPhase } from './runtime/game-input-phase';
import type { GameInputSource } from './input/game-input-ports';
import { DisplayPhase, type DisplayPhaseSource } from './runtime/display-phase';
import type { GameInputPort } from './input/game-input-router';
import { ConfirmationOverlay } from '../hud/windows/confirmation-overlay';
import type { Game } from './game';
import type { PageDevices } from '../run/page-devices';
import type { MarkerSink } from '../marker/marker-sink';
import type { MarkerDeclaration } from '../marker/marker-declaration';
import type { CameraFrame } from '../render/camera/camera-frame';
import type { GraphicsSettingsData } from '../render/graphics-settings';
import type { RenderStyle } from '../render/render-style';
import type { Viewport } from '../render/viewport';
import type { SettingValue } from '../settings/setting-value';
import type { ThemePalette } from '../theme';
import type { PilotControls } from './dynamic/dynamic-entity/pilot-controls';
import type { TrajectoryDemand } from './dynamic/trajectory-demand';
import type { Controllable } from './dynamic/dynamic-entity/controllable';
import type { CameraFrameSamples } from './viewer/camera-selection';
import type { DisplayWindow } from './display-window-manager';
import type { MapVisibilityPolicy } from './map/visibility-policy';
import type { OrbitReference } from './orbit-reference';
import type { ViewMode } from './view/view-mode';
import type { PerfCounts } from './perf-counts';
import type { LoadingProgress } from './loading-progress';

// 新規開始のブリーフィングを出しておく時間 [ms]。
const BRIEFING_TOAST_MS = 12000;

export class GamePresentation {
  private readonly input: Input;
  private readonly touchControls: TouchControls;
  private readonly worldSfx: WorldSfx;
  private readonly uiSfx: UiSfx;
  // 操作と出来事から出す UI の効果音を、同期まで溜める先。
  private readonly uiSounds = new UiSoundQueue();
  // 進行が記録した出来事を UI の効果音・通知へ写す読み手。
  private readonly runEventPresenter: RunEventPresenter;
  // 天体系・ステージ・長押しの宣言を1つにまとめて置くマーカー。
  private readonly frameMarkers: MarkerSink;
  private readonly frameDeclarations: MarkerDeclaration[] = [];
  private readonly playerMarkers: PlayerMarkers;
  private readonly celestialMarkers: CelestialMarkers;
  private readonly cameraSystem: CameraSystem;
  // 論理視点を表示値へ写す側。sync が確定させた1フレームぶんの値を cameraFrame が持つ。
  private readonly cameraView = new CameraView();
  private cameraFrame: CameraFrame | null = null;
  // 操作対象の計画折れ線。計画の表示と、マップの計画の編集・戦闘の噴射ガイドが読む。
  private readonly planPath: PlanPath;
  private readonly planDisplay: PlanDisplay;
  // 直近ノードの実行ガイドのマーカー。
  private readonly planGuide: PlanGuide;
  // このフレームの表示座標系と表示時刻窓。resolveFrame で確定させ、sync が読む。
  private readonly displayWindowManager: DisplayWindowManager;
  private readonly combatView: CombatFrame;
  private readonly mapView: MapFrame;
  private readonly viewManager: ViewManager;
  private readonly objectWindows: ObjectWindows;
  private readonly moduleWindows: ModuleWindows;
  private readonly shipConstruction: ShipConstruction;
  private readonly confirmation: ConfirmationOverlay;
  // 表示パネル(天体クラス表示トグル+天球グリッドトグル+軌道ガイドタブ)。
  private readonly viewOptions: ViewOptionsControl;
  private readonly targeter: Targeter;
  // 航法ターゲットの解決と、その相対交点・再接近点のマーカー。
  private readonly navTargetPresenter: NavTargetPresenter;
  private readonly frameAnchors: FrameAnchors;
  // 閃光・ガスパフなど、寿命だけで消えていく一過性の見た目。
  private readonly flashPresenter = new FlashPresenter();
  private readonly flashEffectsView: FlashEffectsView;
  private readonly entityLines: EntityLineManager;
  private readonly equatorNodes: EquatorNodeManager;
  private readonly frameControls: FrameControls;
  private readonly hudPanels: HudPanelPresenter;
  private readonly inputPhase: GameInputPhase;
  private readonly displayPhase: DisplayPhase;

  // ポーズ中か。時間倍率とは独立に時間を止める。
  public get isPaused(): boolean { return this.devices.hud.overlayManager.isGamePaused(); }
  // このフレームの入力の解釈が組んだ操作量。
  public get pilotControls(): PilotControls { return this.inputPhase.pilotControls; }

  // 各表示物・入力の受け口を、互いの依存関係が満たせる順に組んで game へ繋ぐ。viewOptionsSettings は
  // マップ・天球の表示設定と表示パネルのタブの選択、themePalette は選ばれている配色。
  public constructor(
    private readonly game: Game,
    private readonly devices: PageDevices,
    private readonly viewOptionsSettings: ViewOptionsSettings,
    private readonly themePalette: SettingValue<ThemePalette>,
    sections: FrameSections,
  ) {
    const { scene, hud, markers, audioEngine, pauseMenu } = devices;
    const { commands, dynamicSystem, celestialSystem, controlSelection, viewer, activeStage } = game;
    this.worldSfx = new WorldSfx(audioEngine);
    this.uiSfx = new UiSfx(audioEngine);
    this.runEventPresenter = new RunEventPresenter(this.uiSounds, hud);
    this.frameMarkers = markers.createGroup();
    this.playerMarkers = new PlayerMarkers(markers);
    this.flashEffectsView = new FlashEffectsView(scene.scene);
    this.equatorNodes = new EquatorNodeManager(dynamicSystem, markers, viewOptionsSettings.mapDisplay);
    this.celestialMarkers = new CelestialMarkers(markers, celestialSystem);
    hud.beginRun(activeStage.id);
    const entityDisplayPort = entityDisplayCommands(commands, viewer.entityDisplay);
    const proteinDisplayControl = activeStage.proteinDisplayControl;
    if (proteinDisplayControl !== null) {
      proteinDisplayControl.onProteinDisplayChange = (display) => entityDisplayPort.setProteinDisplay(display);
    }
    this.entityLines = new EntityLineManager(dynamicSystem, viewer.entityDisplay);
    const cameraCommandPort = cameraCommands(commands, viewer.camera);
    const targetCommands = navTargetCommands(commands, viewer.navTarget);
    this.navTargetPresenter = new NavTargetPresenter(viewer.navTarget, markers);
    const anchorEntities = new AnchorEntities(
      dynamicSystem, controlSelection, this.navTargetPresenter, celestialSystem,
    );
    this.cameraSystem = new CameraSystem(
      hud, celestialSystem, viewer.camera, cameraCommandPort, viewer.view, anchorEntities, scene.viewport,
    );
    const predictCommands = predictPanelCommands(commands, viewer.predictPanel);
    this.displayWindowManager = new DisplayWindowManager(
      hud.mapRoot, hud.panelCollapse, celestialSystem, viewer.predictPanel, predictCommands,
    );
    this.confirmation = new ConfirmationOverlay(hud.layers.system, hud.overlayManager);
    this.shipConstruction = new ShipConstruction(
      scene.scene, hud.shipConstructionPanel, hud.overlayManager, this.displayWindowManager,
      hud, hud.constructionConfirm,
      (ship) => this.cameraSystem.focusConstruction(ship.id, ship.motion.radius),
    );
    const viewSelectionCommands = viewCommands(commands, viewer.view);
    this.moduleWindows = new ModuleWindows(
      hud, controlSelection, dynamicSystem, this.shipConstruction,
      this.confirmation,
      () => {
        if (!viewer.view.canSelect('combat')) return false;
        viewSelectionCommands.select('combat');
        return true;
      },
      () => this.objectWindows.close(),
    );
    // 表示パネル。左レールの並びはパネルを足した順で決まるので、同じレールへ足す座標系パネル
    // (FrameControls)より先に組む。
    this.viewOptions = new ViewOptionsControl(
      hud.mapRoot, hud.panelCollapse, viewOptionsSettings,
      viewer.orbitGuide, orbitGuideCommands(commands, viewer.orbitGuide),
    );
    // 参照フレームの基準・回転対象が機体・役割トークンを指すときの解決役。
    this.frameAnchors = new FrameAnchors(celestialSystem, anchorEntities);
    this.frameControls = new FrameControls(
      hud.mapRoot, hud.combatRoot, hud.layers.popup,
      celestialSystem, viewer.camera.map, viewer.camera.combat,
      cameraCommandPort.map, cameraCommandPort.combat, this.cameraSystem,
      viewer.predictPanel, predictCommands, hud.overlayManager, this.frameAnchors,
    );
    this.targeter = new Targeter(
      markers, viewer.navTarget, targetCommands, dynamicSystem, celestialSystem.celestialMotions,
    );
    this.planPath = new PlanPath(scene.scene, celestialSystem, this.displayWindowManager);
    this.planDisplay = new PlanDisplay(this.planPath, markers, celestialSystem, controlSelection);
    this.planGuide = new PlanGuide(markers);
    this.input = new Input(scene.renderer.domElement);
    this.touchControls = new TouchControls(this.input);
    this.input.onPointerKindChange = (kind) => this.touchControls.setPointerKind(kind);

    const objectWindowActions = new ObjectWindowActions(
      dynamicSystem, celestialSystem,
      viewer.navTarget, this.navTargetPresenter, targetCommands,
      viewer.entityDisplay, entityDisplayPort,
      viewer.camera, viewer.view, () => this.viewManager.activeView, pauseMenu,
      controlSelection, this.frameControls, cameraCommandPort.combat,
      activeStage, this.targeter, this.moduleWindows,
      objectMenuCommands(commands, controlSelection),
      (message) => hud.hint(message),
    );
    // ビューの表示実装は ObjectWindows より後に組む。
    this.objectWindows = new ObjectWindows(
      hud, celestialSystem, viewer.camera, controlSelection,
      this.displayWindowManager, objectWindowActions,
    );
    this.combatView = new CombatFrame(
      this.input, this.targeter, this.objectWindows, dynamicSystem,
      this.celestialMarkers, this.touchControls,
      controlSelection, this.planPath, this.planGuide,
    );
    this.mapView = new MapFrame(
      this.input, this.cameraSystem, viewer.camera, this.objectWindows,
      dynamicSystem, this.equatorNodes, celestialSystem,
      this.celestialMarkers, markers, this.targeter,
      this.displayWindowManager, this.frameControls,
      this.frameAnchors, controlSelection, controlSelectionCommands(commands, controlSelection),
      game.simSpeedManager, simSpeedCommands(commands, game.simSpeedManager),
      this.planDisplay, this.planPath, planCommands(commands),
      scene.scene, hud, this.uiSounds, this.navTargetPresenter, targetCommands,
      viewOptionsSettings.mapDisplay,
    );
    this.viewManager = new ViewManager(
      viewer.view, this.touchControls, { combat: this.combatView, map: this.mapView },
    );

    this.hudPanels = new HudPanelPresenter(
      hud, commands, celestialSystem, dynamicSystem, controlSelection, game.simSpeedManager,
      activeStage, viewer, this.input, this.targeter, this.objectWindows, this.cameraSystem,
    );
    const inputSource: GameInputSource = {
      commands: game.commands,
      simSpeedManager: game.simSpeedManager,
      view: game.viewer.view,
      get activeControllable() { return game.activeControllable; },
      get stageIsPlaying() { return game.activeStage.isPlaying; },
    };
    const displaySource: DisplayPhaseSource = {
      get simTime() { return game.simTime; },
      get activeControllable() { return game.activeControllable; },
      get recentEvents() { return game.events.recent; },
      celestialSystem: game.celestialSystem,
      get navTargetId() { return game.viewer.navTarget.id; },
    };
    this.inputPhase = new GameInputPhase(
      inputSource, hud, pauseMenu, this.cameraSystem, this.viewManager, this.targeter,
      this.shipConstruction, this.input, () => this.cameraFrame, sections,
    );
    this.displayPhase = new DisplayPhase(
      displaySource, this.displayWindowManager, this.viewManager, this.frameAnchors, this.cameraSystem,
      this.flashPresenter, this.targeter, this.planDisplay, this.equatorNodes, sections,
    );
  }

  // このランが scene・Hud・マーカー装置・window/document/canvas へ足したものを残らず取り除く。
  // 呼んだ後のこのインスタンスは使えない。構築の逆順で辿る — 後から組んだものほど先に組んだものを
  // 参照する。
  public dispose(): void {
    // Hud はこのランより長生きするので、操作対象も操作の受け口も無い状態を1度宣言してから畳む。
    this.devices.hud.clearRunPanels();
    this.hudPanels.dispose();
    this.mapView.dispose();
    this.combatView.dispose();
    this.moduleWindows.close();
    this.shipConstruction.dispose();
    this.confirmation.dispose();
    this.objectWindows.dispose();
    this.worldSfx.dispose();
    this.touchControls.dispose();
    this.input.dispose();
    this.planDisplay.dispose();
    this.planPath.dispose();
    this.planGuide.dispose();
    this.frameControls.dispose();
    this.cameraSystem.dispose();
    this.viewOptions.dispose();
    this.displayWindowManager.dispose();
    this.equatorNodes.dispose();
    this.flashEffectsView.dispose();
    this.targeter.dispose();
    this.navTargetPresenter.dispose();
    this.celestialMarkers.dispose();
    this.playerMarkers.dispose();
    this.frameMarkers.dispose();
  }

  // ランの開始を表示する: 組み立ての間に記録された出来事を音・通知へ写し、新規開始のブリーフィングを出す。
  public presentRunStart(): void {
    this.runEventPresenter.present(this.game.events.recent);
    const briefing = this.game.activeStage.briefing;
    if (briefing !== null) this.devices.hud.toast(briefing, BRIEFING_TOAST_MS);
  }

  // ------------------------------------------------------------ 入力の解釈

  // 生の入力を担当モジュールへ先着順で配り、命令とこのフレームの操作量を組む。dt [s] は進行へ渡す
  // 刻み、nowMs [ms] はフレームの先頭で1度だけ読んだ実時刻。ポーズ中も Esc・ヘルプなどは効かせる。
  public interpretInput(dt: number, nowMs: number, viewport: Viewport): void {
    this.inputPhase.interpret(dt, nowMs, viewport);
  }

  // フレームの残りの入力イベントを、ports の優先度順にディスパッチする。
  public routeInput(ports: readonly GameInputPort[]): void { this.inputPhase.routeInput(ports); }

  // ------------------------------------------------ 進行の材料と、進行の後の導出

  // 進行の直後に、ビューの切替とこのフレームの表示窓を確定させ、座標系の錨を表示時刻へ合わせる。
  // ポーズ中も決着後も通す — 決着後も積分は進むので、飛ばすと追従対象がカメラから流れ去る。
  public resolveFrame(): void { this.displayPhase.resolveFrame(); }

  // 座標系の錨が天体を引く時刻 time [s] を差し込む。以降の座標系の変換はすべてこの錨を通す。
  public anchorFrameAt(time: number): void { this.displayPhase.anchorFrameAt(time); }

  // 錨を合わせた時刻での、視点の追従の材料。
  public cameraSamples(): CameraFrameSamples {
    return this.displayPhase.cameraSamples();
  }

  // 一時エフェクト・的通過マーク・計画表示を、進行が記録した出来事と計画から表示時刻で組み直す(R5)。
  public presentProgress(): void { this.displayPhase.presentProgress(); }

  // 予測と履歴をどこまで計算してほしいかの需要(R4)。
  public trajectoryDemand(): TrajectoryDemand { return this.displayPhase.trajectoryDemand(); }

  // 予測を伸ばした後の導出: 赤道交点、カメラ、選択候補をこの順に同じ時刻の状態へ更新する。
  // nowMs [ms] はフレームの実時刻。
  public update(nowMs: number, viewport: Viewport): void {
    this.displayPhase.update(nowMs, viewport);
  }

  // ------------------------------------------------------------ 導出と同期・描画

  // 確定した表示窓とカメラを表示物へ写す。nowMs はフレームの先頭で1度だけ読んだ実時刻 [ms]。
  public sync(
    graphics: GraphicsSettingsData, style: RenderStyle, viewport: Viewport, nowMs: number,
  ): void {
    const { celestialSystem, dynamicSystem, viewer } = this.game;
    const controlled = this.game.activeControllable;
    const palette = this.themePalette.current;
    const displayWindow = this.displayWindowManager.current;
    this.devices.hud.setConstructionMode(this.shipConstruction.active);
    this.hudPanels.syncViewBadge(
      this.viewManager.current, this.viewManager.selectableViews(), this.viewManager.activeView.pickables, style,
    );

    // 表示時刻 = 未来ゴーストのスライダーぶん先取りした simTime。
    const { displayTime } = displayWindow;
    const view = this.viewManager.current;
    // 最初にカメラを確定し、後続の同期とマーカー投影が読む行列を揃える。
    const camera = this.syncCamera(displayWindow, view, viewport, nowMs);
    // 描く対象と選べる対象を同じ判定から出すため、ビューが確定させた可否を読む。
    const visibilityPolicy = this.viewManager.activeView.visibilityPolicy;
    // 3D 軌道線を軌道パネルと同一の基準系で算出する。
    const orbitRef = controlled
      ? resolveOrbitReference(
        viewer.orbitReference.mode, controlled.motion.state.r, celestialSystem.celestialMotions,
        this.navTargetPresenter, dynamicSystem, celestialSystem, controlled.motion.state.t,
      )
      : undefined;
    // 通過時刻ラベルの設定は、赤道交点と航法ターゲットの両方が同じものを読む。
    const timeLabel = timeLabelSettingOf(displayWindow);
    this.syncWorld(
      graphics, style, nowMs, displayTime, view, controlled, orbitRef ?? null, visibilityPolicy, timeLabel, camera,
    );
    this.syncEffectsAndTargets(
      nowMs, displayTime, view, controlled, visibilityPolicy, timeLabel, palette, camera,
    );
    this.syncPanelsAndMarkers(
      nowMs, displayWindow, displayTime, view, controlled, orbitRef ?? null, visibilityPolicy, palette, camera,
    );
  }

  // 最初に行う: 後続の sync とマーカー投影がこのフレームのカメラ行列と描画原点を読む。
  private syncCamera(
    displayWindow: DisplayWindow, view: ViewMode, viewport: Viewport, nowMs: number,
  ): CameraFrame {
    const cs = this.cameraSystem;
    const camera = this.cameraView.sync(
      cs.activeViewpoint, cs.clipFovDeg, cs.clipDistance, viewport, cs.zoomActive, cs.focusVelocity,
    );
    this.cameraFrame = camera;
    this.viewOptions.setVisible(view === 'map');
    // 天体ラベルの間引きは、この後のマーカー同期が近接判定に読むので先に済ませる。
    this.viewManager.activeView.syncLabels(displayWindow, camera, nowMs);
    return camera;
  }

  // 天体系・動的物体・建造表示・天体由来のマーカーを、同じ表示時刻の状態へ同期する。
  private syncWorld(
    graphics: GraphicsSettingsData, style: RenderStyle, nowMs: number, displayTime: number, view: ViewMode,
    controlled: Controllable | null, orbitRef: OrbitReference | null, visibilityPolicy: MapVisibilityPolicy | null,
    timeLabel: ReturnType<typeof timeLabelSettingOf>, camera: CameraFrame,
  ): void {
    const { celestialSystem, dynamicSystem, viewer } = this.game;
    celestialSystem.sync(
      displayTime, nowMs, camera, view, viewer.camera.map, this.cameraSystem.mapResolvedFocus,
      graphics, style,
      this.viewOptionsSettings.grid.current, viewer.orbitGuide.settings, visibilityPolicy,
    );
    // 本数の警告は、天体系がこのフレームに組んだ軌道ガイド線から出す。
    this.viewOptions.setOrbitGuideLineCount(celestialSystem.orbitGuide.lineCount);
    celestialSystem.bakeClouds(this.devices.scene.renderer, displayTime, this.devices.scene.gpu);
    dynamicSystem.sync(
      displayTime, controlled, camera, style, graphics, viewer.entityDisplay.proteinDisplay, orbitRef ?? undefined,
    );
    this.shipConstruction.sync(camera);
    // 操作中の艦の軌道軸・ボアサイトは、機体の同期と同じフレームの状態から置く。
    this.playerMarkers.sync(
      controlled !== null && isModularShip(controlled) ? controlled : null, view, camera.project,
      orbitRef?.state ?? null, nowMs,
    );
    this.equatorNodes.sync(
      camera.project, camera.position, this.frameAnchors.bodies, this.frameAnchors.bodiesPivot,
      view === 'map', timeLabel, nowMs,
    );
  }

  // このフレームの出来事を通知・音・閃光・対象・航法ターゲットの宣言へ写す。
  private syncEffectsAndTargets(
    nowMs: number, displayTime: number, view: ViewMode, controlled: Controllable | null,
    visibilityPolicy: MapVisibilityPolicy | null, timeLabel: ReturnType<typeof timeLabelSettingOf>,
    palette: ThemePalette, camera: CameraFrame,
  ): void {
    const events = this.game.events.recent;
    this.runEventPresenter.present(events);
    this.worldSfx.sync({
      loops: controlledLoopSfx(controlled, displayTime, !this.isPaused && this.game.activeStage.isPlaying),
      cues: worldSoundCues(events),
    });
    this.uiSfx.sync(this.uiSounds.cues);
    this.uiSounds.clear();
    // ビルボードはこのフレームのカメラ姿勢へ向けるので、cameraView.sync より後に通す。
    this.flashEffectsView.sync(this.flashPresenter.live, camera);
    this.targeter.sync(
      controlled, camera, view, displayTime, visibilityPolicy, this.celestialMarkers.activeLabels, nowMs, palette,
    );
    this.navTargetPresenter.sync(
      camera, view, this.frameAnchors.bodies, this.frameAnchors.bodiesPivot, timeLabel, nowMs,
    );
  }

  // プロパティ・計画・軌道線・ビュー・HUDを同期し、最後にマーカーの重なりを解決する。
  private syncPanelsAndMarkers(
    nowMs: number, displayWindow: DisplayWindow, displayTime: number, view: ViewMode,
    controlled: Controllable | null, orbitRef: OrbitReference | null,
    visibilityPolicy: MapVisibilityPolicy | null, palette: ThemePalette, camera: CameraFrame,
  ): void {
    const { celestialSystem, activeStage, viewer } = this.game;
    // 戦闘中に開いたプロパティウィンドウも最新値を表示し続ける必要があるので、ビューに依らず呼ぶ。
    this.objectWindows.sync();
    this.moduleWindows.sync();
    this.planDisplay.sync(camera, view, displayWindow, nowMs);
    this.entityLines.sync(
      controlled, this.targeter.aliveTarget, view, displayWindow, visibilityPolicy, orbitRef ?? undefined,
      camera, this.frameAnchors, celestialSystem, palette,
    );
    // ビュー専用のパネル・表示物と軌道線の右クリック候補。軌道線が今フレーム焼いたサンプルを
    // 読むため、celestialSystem.sync/entityLines.sync の後に置く。
    this.viewManager.activeView.syncPanels(displayWindow, camera, nowMs);
    activeStage.sync(camera, view, displayTime);
    activeStage.proteinDisplayControl?.syncProteinDisplay(viewer.entityDisplay.proteinDisplay);
    this.hudPanels.sync(view, displayWindow, orbitRef ?? undefined, palette, camera, nowMs);
    this.syncFrameMarkers(nowMs);
    // このフレームのマーカーが出揃った後でなければならないので最後に通す。
    this.devices.markers.resolveOverlaps(view === 'map');
  }

  // 天体系・ステージが組んだ宣言と、長押しのフィードバックを1つの群へまとめて置く。
  private syncFrameMarkers(nowMs: number): void {
    const declarations = this.frameDeclarations;
    declarations.length = 0;
    declarations.push(...this.game.celestialSystem.markerDeclarations);
    declarations.push(...this.game.activeStage.markerDeclarations);
    declarations.push(this.touchControls.longPressDeclaration());
    this.frameMarkers.sync(declarations, nowMs);
  }

  // 直前の sync が確定させたカメラでシェーダを組む。sync を1度も通す前に呼ぶと例外になる。
  public async compile(style: RenderStyle, progress: LoadingProgress): Promise<void> {
    if (this.cameraFrame === null) throw new Error('GamePresentation.compile: sync has not run yet');
    const { scene } = this.devices;
    await scene.pipeline.compile(
      scene.scene,
      this.cameraFrame.camera,
      style,
      (name, done, total) => progress.within(done / total, `シェーダを準備中: ${name}`),
    );
  }

  // このフレームの sync が確定させたカメラで描く。まだ1度も sync していなければ何も描かない。
  public render(style: RenderStyle): void {
    if (this.cameraFrame === null) return;
    this.devices.scene.pipeline.render(this.devices.scene.scene, this.cameraFrame.camera, style);
  }

  // 表示の導出が答える計測値。
  public perfCounts(): Pick<PerfCounts, 'planArcs' | 'mapMode' | 'mapItems' | 'mapLabels' | 'displayDurationSec'> {
    return {
      ...this.planDisplay.perfCounts(),
      ...this.viewManager.activeView.perfCounts(),
      displayDurationSec: this.displayWindowManager.current.duration,
    };
  }
}
