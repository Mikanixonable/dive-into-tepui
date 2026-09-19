// 1ランの表示の導出の根: 入力の解釈、表示窓・座標系の錨・カメラの導出、表示物と HUD への同期、
// 描画を所有する。モデル層の根 Game を読み、命令の列へ積み、進行の末尾へ渡す材料を組む。
import { SECTION, type FrameSections } from './frame-sections';
import { CameraSystem } from './camera/camera-system';
import { controlSelectionCommands } from './control-selection-commands';
import { simSpeedCommands } from './dynamic/sim-speed-commands';
import { objectMenuCommands } from './pickable/object-menu-commands';
import { planCommands } from './plan/plan-commands';
import { PlayerMarkers } from './marker/player-markers';
import { isPlayer } from './player/player';
import { CelestialMarkers } from './marker/celestial-markers';
import { EquatorNodeManager } from './marker/equator-node-manager';
import { Targeter } from './targeter';
import { PlanDisplay } from './plan/plan-display';
import { PlanGuide } from './plan/plan-guide';
import { DisplayWindowManager, timeLabelSettingOf, trajectoryDemandOf } from './display-window-manager';
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
import { CombatView } from './view/combat-view';
import { MapView } from './view/map-view';
import { NavTargetPresenter } from './nav-target-presenter';
import { AnchorEntities, FrameAnchors } from './frame-anchors';
import { resolveOrbitReference } from './orbit-reference';
import { navTargetCommands } from './viewer/nav-target-commands';
import { orbitGuideCommands } from './viewer/orbit-guide-commands';
import { predictPanelCommands } from './viewer/predict-panel-commands';
import { cameraCommands } from './viewer/camera-commands';
import { entityDisplayCommands } from './viewer/entity-display-commands';
import { ObjectWindows } from './pickable/object-windows';
import { FrameControls } from './hud/frame/frame-controls';
import { HudPanelPresenter } from './hud/hud-panel-presenter';
import { ViewOptionsControl, type ViewOptionsSettings } from './hud/panels/view-options-control';
import { controlledLoopSfx } from './controlled-loop-sfx';
import { UiSoundQueue } from './ui-sound-queue';
import { GameInputRouter, type GameInputPort } from './input/game-input-router';
import { gameInputPorts, pilotInputPorts } from './input/game-input-ports';
import { rawGameInputAdapter } from './input/raw-game-input-adapter';
import { PilotInput } from './input/pilot-input';
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
import type { CameraFrameSamples } from './viewer/camera-selection';
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
  private readonly planDisplay: PlanDisplay;
  // 直近ノードの実行ガイドのマーカー。
  private readonly planGuide: PlanGuide;
  // このフレームの表示座標系と表示時刻窓。resolveFrame で確定させ、sync が読む。
  private readonly displayWindowManager: DisplayWindowManager;
  private readonly viewManager: ViewManager;
  private readonly objectWindows: ObjectWindows;
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
  private readonly inputRouter: GameInputRouter;
  // 生の入力を操作対象の操作量へ解釈する側と、その入力を受け取る口。
  private readonly pilotInput = new PilotInput();
  private readonly pilotPorts: readonly GameInputPort[];

  // ポーズ中か。時間倍率とは独立に時間を止める。
  public get isPaused(): boolean { return this.devices.hud.overlayManager.isGamePaused(); }
  // このフレームの入力の解釈が組んだ操作量。
  public get pilotControls(): PilotControls { return this.pilotInput.controls; }

  // 各表示物・入力の受け口を、互いの依存関係が満たせる順に組んで game へ繋ぐ。viewOptionSettings は
  // マップ・天球の表示設定と表示パネルのタブの選択、themePalette は選ばれている配色。
  public constructor(
    private readonly game: Game,
    private readonly devices: PageDevices,
    private readonly viewOptionSettings: ViewOptionsSettings,
    private readonly themePalette: SettingValue<ThemePalette>,
    private readonly sections: FrameSections,
  ) {
    const { scene, hud, markers, audioEngine, pauseMenu } = devices;
    const { commands, dynamicSystem, celestialSystem, controlSelection, viewer, activeStage } = game;
    this.worldSfx = new WorldSfx(audioEngine);
    this.uiSfx = new UiSfx(audioEngine);
    this.runEventPresenter = new RunEventPresenter(this.uiSounds, hud);
    this.frameMarkers = markers.createGroup();
    this.playerMarkers = new PlayerMarkers(markers.createGroup());
    this.flashEffectsView = new FlashEffectsView(scene.scene);
    this.equatorNodes = new EquatorNodeManager(dynamicSystem, markers.createGroup(), viewOptionSettings.mapDisplay);
    this.celestialMarkers = new CelestialMarkers(markers.createGroup(), celestialSystem);
    hud.beginRun(activeStage.id);
    const entityDisplayPort = entityDisplayCommands(commands, viewer.entityDisplay);
    const proteinDisplayControl = activeStage.proteinDisplayControl;
    if (proteinDisplayControl !== null) {
      proteinDisplayControl.onProteinDisplayChange = (display) => entityDisplayPort.setProteinDisplay(display);
    }
    this.entityLines = new EntityLineManager(dynamicSystem, viewer.entityDisplay);
    const cameraCommandPort = cameraCommands(commands, viewer.camera);
    const targetCommands = navTargetCommands(commands, viewer.navTarget);
    this.navTargetPresenter = new NavTargetPresenter(viewer.navTarget, markers.createGroup());
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
    // 表示パネル。左レールの並びはパネルを足した順で決まるので、同じレールへ足す座標系パネル
    // (FrameControls)より先に組む。
    this.viewOptions = new ViewOptionsControl(
      hud.mapRoot, hud.panelCollapse, viewOptionSettings,
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
    this.planDisplay = new PlanDisplay(
      scene.scene, markers.createGroup(), celestialSystem, this.displayWindowManager, controlSelection,
    );
    this.planGuide = new PlanGuide(markers.createGroup());
    this.input = new Input(scene.renderer.domElement);
    this.touchControls = new TouchControls(this.input);
    this.input.onPointerKindChange = (kind) => this.touchControls.setPointerKind(kind);

    // ビューの表示実装は ObjectWindows より後に組む。
    this.objectWindows = new ObjectWindows(
      hud, dynamicSystem, celestialSystem,
      viewer.navTarget, this.navTargetPresenter, targetCommands,
      viewer.entityDisplay, entityDisplayPort,
      viewer.camera, viewer.view, () => this.viewManager.activeView, pauseMenu,
      controlSelection, this.frameControls, cameraCommandPort.combat,
      activeStage, this.targeter, this.displayWindowManager,
      objectMenuCommands(commands, controlSelection),
    );
    const combatView = new CombatView(
      this.input, this.targeter, this.objectWindows, dynamicSystem,
      this.celestialMarkers, this.touchControls,
      controlSelection, this.planDisplay.path, this.planGuide,
    );
    const mapView = new MapView(
      this.input, this.cameraSystem, viewer.camera, this.objectWindows,
      dynamicSystem, this.equatorNodes, celestialSystem,
      this.celestialMarkers, markers, this.targeter.combatMarkers,
      this.displayWindowManager, this.frameControls,
      this.frameAnchors, controlSelection, controlSelectionCommands(commands, controlSelection),
      game.simSpeedManager, simSpeedCommands(commands, game.simSpeedManager), this.planDisplay, planCommands(commands),
      scene.scene, hud, this.uiSounds, this.navTargetPresenter, targetCommands,
      viewOptionSettings.mapDisplay,
    );
    this.viewManager = new ViewManager(viewer.view, this.touchControls, { combat: combatView, map: mapView });

    this.hudPanels = new HudPanelPresenter(
      hud, commands, celestialSystem, dynamicSystem, controlSelection, game.simSpeedManager,
      activeStage, viewer, this.input, this.targeter, this.objectWindows, this.cameraSystem,
    );
    this.inputRouter = new GameInputRouter(
      rawGameInputAdapter(this.input),
      gameInputPorts(game, hud, pauseMenu, this.cameraSystem, this.viewManager, this.targeter),
    );
    this.pilotPorts = pilotInputPorts(this.pilotInput, game, hud);
  }

  // このランが scene・Hud・マーカー装置・window/document/canvas へ足したものを残らず取り除く。
  // 呼んだ後のこのインスタンスは使えない。構築の逆順で辿る — 後から組んだものほど先に組んだものを
  // 参照する。
  public dispose(): void {
    // Hud はこのランより長生きするので、操作対象も操作の受け口も無い状態を1度宣言してから畳む。
    this.devices.hud.clearRunPanels();
    this.hudPanels.dispose();
    this.viewManager.dispose();
    this.objectWindows.dispose();
    this.worldSfx.dispose();
    this.touchControls.dispose();
    this.input.dispose();
    this.planDisplay.dispose();
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
    this.sections.enter(SECTION.input);
    this.input.update();
    this.handleInput(dt, nowMs, viewport);
    this.sections.exit(SECTION.input);
  }

  // 入力の担当を優先順に呼び、命令とこのフレームの操作量を組む。呼ぶ順序が優先順位になる。
  private handleInput(dt: number, nowMs: number, viewport: Viewport): void {
    const overlays = this.devices.hud.overlayManager;
    this.inputRouter.beginFrame();
    // 連打の判定には、直前の進行が確定させたワープ倍率で艦が動けるかを渡す(CONTROLS.md)。
    this.pilotInput.beginFrame(nowMs, this.game.simSpeedManager.canShipAct);
    this.inputRouter.route();
    // 同じフレームの route で開いたモーダルも、ここから先のビューの操作を止める。
    if (!overlays.isInputGated()) {
      // マップの Δv 編集は操作対象の解釈より先に押下中キーを確保する。
      this.viewManager.activeView.updateActions(dt);
    }
    this.inputRouter.routeAdditional(this.pilotPorts);
    this.cameraSystem.handleInput(this.input, dt, viewport, this.game.activeControllable);
    // ピックは直前の sync が確定したカメラと候補列で解く — 入力の解釈はこのフレームの導出より前に走る。
    if (!this.isPaused && !overlays.isInputGated() && this.cameraFrame !== null) {
      this.sections.switchTo(SECTION.input, SECTION.pointer);
      this.viewManager.activeView.handlePointer(this.game.simTime, this.cameraFrame);
      this.sections.switchTo(SECTION.pointer, SECTION.input);
    }
  }

  // フレームの残りの入力エッジを、ports の優先順へ配る。
  public routeInput(ports: readonly GameInputPort[]): void {
    this.inputRouter.routeAdditional(ports);
  }

  // ------------------------------------------------ 進行の材料と、進行の後の導出

  // 進行の直後に、ビューの切替とこのフレームの表示窓を確定させ、座標系の錨を表示時刻へ合わせる。
  // ポーズ中も決着後も通す — 決着後も積分は進むので、飛ばすと追従対象がカメラから流れ去る。
  public resolveFrame(): void {
    this.viewManager.sync();
    const displayWindow = this.displayWindowManager.resolve(
      this.game.simTime, this.game.activeControllable, this.viewManager.current !== 'map',
    );
    this.anchorFrameAt(displayWindow.displayTime);
  }

  // 座標系の錨が天体を引く時刻 time [s] を差し込む。以降の座標系の変換はすべてこの錨を通す。
  public anchorFrameAt(time: number): void {
    this.frameAnchors.update(time);
  }

  // 錨を合わせた時刻での、視点の追従の材料。
  public cameraSamples(): CameraFrameSamples {
    return this.cameraSystem.sampleProgress(this.frameAnchors.bodiesPivot, this.frameAnchors);
  }

  // 一時エフェクト・的通過マーク・計画表示を、進行が記録した出来事と計画から表示時刻で組み直す(R5)。
  public presentProgress(): void {
    const displayWindow = this.displayWindowManager.current;
    const events = this.game.events.recent;
    this.sections.enter(SECTION.effects);
    this.flashPresenter.present(events, displayWindow.displayTime);
    this.targeter.updateBoardMarks(events, this.game.activeControllable, displayWindow.displayTime);
    this.sections.exit(SECTION.effects);
    this.sections.enter(SECTION.plan);
    this.planDisplay.update(displayWindow, this.frameAnchors, this.viewManager.current);
    this.sections.exit(SECTION.plan);
  }

  // 予測と履歴をどこまで計算してほしいかの需要(R4)。
  public trajectoryDemand(): TrajectoryDemand {
    return trajectoryDemandOf(this.displayWindowManager.current, this.planDisplay.growableArcs());
  }

  // 予測を伸ばした後の導出: 赤道交点、カメラ、選択候補をこの順に同じ時刻の状態へ更新する。
  // nowMs [ms] はフレームの実時刻。
  public update(nowMs: number, viewport: Viewport): void {
    const displayWindow = this.displayWindowManager.current;
    // 交点は計画折れ線か予測の楕円の上に置くので、両方を組み終えた後に通す。
    this.sections.enter(SECTION.plan);
    this.equatorNodes.update({
      displayTime: displayWindow.displayTime,
      celestialBodies: this.game.celestialSystem,
      frameAnchors: this.frameAnchors,
      paths: this.planDisplay,
    }, this.game.activeControllable, this.game.viewer.navTarget.id, this.viewManager.current);
    this.sections.exit(SECTION.plan);
    this.sections.enter(SECTION.camera);
    this.cameraSystem.update(
      this.viewManager.activeView.pickables, this.game.activeControllable, viewport, nowMs,
    );
    this.sections.exit(SECTION.camera);
    // 候補列は遮蔽判定にカメラ位置を読むので、カメラの更新より後に組む。
    this.sections.enter(SECTION.mapPick);
    this.viewManager.activeView.update(displayWindow);
    this.sections.exit(SECTION.mapPick);
  }

  // ------------------------------------------------------------ 導出と同期・描画

  // 確定した表示窓とカメラを表示物へ写す。nowMs はフレームの先頭で1度だけ読んだ実時刻 [ms]。
  public sync(
    graphics: GraphicsSettingsData, style: RenderStyle, viewport: Viewport, nowMs: number,
  ): void {
    const { celestialSystem, dynamicSystem, activeStage, viewer } = this.game;
    const controlled = this.game.activeControllable;
    const palette = this.themePalette.current;
    const displayWindow = this.displayWindowManager.current;
    this.hudPanels.syncViewBadge(
      this.viewManager.current, this.viewManager.selectableViews(), this.viewManager.activeView.pickables, style,
    );

    // 表示時刻 = 未来ゴーストのスライダーぶん先取りした simTime。
    const { displayTime, simTime } = displayWindow;

    // 最初に行う: 後続の sync とマーカー投影がこのフレームのカメラ行列と描画原点を読む。
    const cs = this.cameraSystem;
    const camera = this.cameraView.sync(
      cs.activeViewpoint, cs.clipFovDeg, cs.clipDistance, viewport, this.viewManager.current,
      cs.zoomActive, cs.focusVelocity,
    );
    this.cameraFrame = camera;
    this.viewOptions.setVisible(this.viewManager.current === 'map');
    // 天体ラベルの間引きは、この後のマーカー同期が近接判定に読むので先に済ませる。
    this.viewManager.activeView.syncLabels(displayWindow, camera, nowMs);

    // 描く対象と選べる対象を同じ判定から出すため、ビューが確定させた可否を読む。
    const visibilityPolicy = this.viewManager.activeView.visibilityPolicy;
    // 3D 軌道線を軌道パネルと同じ基準で解く。
    const orbitRef = controlled
      ? resolveOrbitReference(
        viewer.orbitReference.mode, controlled.motion.state.r, celestialSystem.celestialMotions,
        this.navTargetPresenter, dynamicSystem, celestialSystem, controlled.motion.state.t,
      )
      : undefined;

    celestialSystem.sync(
      displayTime, nowMs, camera, viewer.camera.map, this.cameraSystem.mapResolvedFocus,
      graphics, style,
      this.viewOptionSettings.grid.current, viewer.orbitGuide.settings, visibilityPolicy,
    );
    // 本数の警告は、天体系がこのフレームに組んだ軌道ガイド線から出す。
    this.viewOptions.setOrbitGuideLineCount(celestialSystem.orbitGuide.lineCount);
    celestialSystem.bakeClouds(this.devices.scene.renderer, displayTime, this.devices.scene.gpu);

    // 通過時刻ラベルの設定は、赤道交点と航法ターゲットの両方が同じものを読む。
    const timeLabel = timeLabelSettingOf(displayWindow);
    dynamicSystem.sync(
      displayTime, controlled, camera, style, graphics, viewer.entityDisplay.proteinDisplay, orbitRef,
    );
    // 操作中の艦の軌道軸・ボアサイトは、機体の同期と同じフレームの状態から置く。
    this.playerMarkers.sync(
      controlled !== null && isPlayer(controlled) ? controlled : null, camera.mode, camera.project,
      orbitRef?.state ?? null, nowMs,
    );
    this.equatorNodes.sync(
      camera.project, camera.position, this.frameAnchors.bodies, this.frameAnchors.bodiesPivot,
      camera.mode === 'map', timeLabel, nowMs,
    );
    // このフレームの進行が記録した出来事を、通知と音の宣言へ写す。
    const events = this.game.events.recent;
    this.runEventPresenter.present(events);
    this.worldSfx.sync({
      loops: controlledLoopSfx(controlled, displayTime, !this.isPaused && activeStage.isPlaying),
      cues: worldSoundCues(events),
    });
    this.uiSfx.sync(this.uiSounds.cues);
    this.uiSounds.clear();
    // ビルボードはこのフレームのカメラ姿勢へ向けるので、cameraView.sync より後に通す。
    this.flashEffectsView.sync(this.flashPresenter.live, camera);

    this.targeter.sync(
      controlled, camera, displayTime, visibilityPolicy, this.celestialMarkers.activeLabels, nowMs, palette,
    );
    this.navTargetPresenter.sync(
      camera, this.frameAnchors.bodies, this.frameAnchors.bodiesPivot, timeLabel, nowMs,
    );

    // 戦闘中に開いたプロパティウィンドウも最新値を表示し続ける必要があるので、ビューに依らず呼ぶ。
    this.objectWindows.sync(simTime, displayTime);
    this.planDisplay.sync(camera, displayWindow, nowMs);

    this.entityLines.sync(
      controlled, this.targeter.aliveTarget, this.viewManager.current, displayWindow, visibilityPolicy, orbitRef,
      camera, this.frameAnchors, celestialSystem, palette,
    );
    // ビュー専用のパネル・表示物と軌道線の右クリック候補。軌道線が今フレーム焼いたサンプルを
    // 読むため、celestialSystem.sync/entityLines.sync の後に置く。
    this.viewManager.activeView.syncPanels(displayWindow, camera, nowMs);

    activeStage.sync(camera, displayTime);
    activeStage.proteinDisplayControl?.syncProteinDisplay(viewer.entityDisplay.proteinDisplay);

    this.hudPanels.sync(this.viewManager.current, displayWindow, orbitRef, palette, camera, nowMs);

    this.syncFrameMarkers(nowMs);
    // このフレームのマーカーが出揃った後でなければならないので最後に置く。
    this.devices.markers.resolveOverlaps(this.viewManager.current === 'map');
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
