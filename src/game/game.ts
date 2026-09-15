// ゲーム全体のオーケストレーション: 各システムの生成・保持と、フレームごとの呼び出し順序の決定。
import * as THREE from 'three/webgpu';
import type { PerfCounts } from './perf-counts';
import { proteinMotionFrameSample, type ProteinMotionFrameSample } from './protein/protein-motion-metrics';
import { SECTION, type FrameSections } from './frame-sections';
import type { Controllable } from './dynamic/dynamic-entity/controllable';
import { CameraSystem } from './camera/camera-system';
import type { Stage, StageClass } from './stages/stage';
import type { MarkerDevice } from '../marker/marker-device';
import type { MarkerSink } from '../marker/marker-sink';
import type { MarkerDeclaration } from '../marker/marker-declaration';
import { MARKER_PRIORITY } from './marker/marker-priority';
import { PlayerMarkers } from './marker/player-markers';
import { isPlayer } from './player/player';
import { CelestialMarkers } from './marker/celestial-markers';
import { EquatorNodeManager } from './marker/equator-node-manager';
import { ControlSelection } from './control-selection';
import { Targeter } from './targeter';
import { PlanDisplay } from './plan/plan-display';
import { PlanGuide } from './plan/plan-guide';
import { DisplayWindowManager, timeLabelSettingOf } from './display-window-manager';
import { SimSpeedManager } from './dynamic/sim-speed-manager';
import { DynamicSystem } from './dynamic/dynamic-system';
import { FlashEffects } from './vfx/flash-effects';
import { FlashEffectsView } from '../render/vfx/flash-effects-view';
import { EntityLineManager } from './lines/entity-line-manager';
import { Predictor } from './dynamic/predictor';
import { Input } from '../input/input';
import { TouchControls } from './hud/touch-controls';
import type { Hud } from './hud/hud';
import type { PauseMenu } from '../hud/windows/pause-menu';
import { WorldSfx } from '../audio/sfx/world-sfx';
import { UiSfx } from '../audio/sfx/ui-sfx';
import type { AudioEngine } from '../audio/audio-engine';
import type { RenderPipeline } from '../render/pipeline/render-pipeline';
import type { GpuTimingSink } from '../render/gpu-timings';
import type { GraphicsSettingsData } from '../render/graphics-settings';
import type { RenderStyle } from '../render/render-style';
import type { Viewport } from '../render/viewport';
import { CameraView } from '../render/camera/camera-view';
import type { CameraFrame } from '../render/camera/camera-frame';
import type { CelestialSystem } from './celestial/celestial-system';
import { ViewManager } from './view/view-manager';
import { CombatView } from './view/combat-view';
import { MapView } from './view/map-view';
import { NavTarget } from './nav-target';
import { FrameAnchors } from './frame-anchors';
import { OrbitReferenceSelector } from './orbit-reference';
import { ObjectWindows } from './pickable/object-windows';
import { SAVE_VERSION, type GameSaveData } from './save/save-data';
import { ephemerisContextFor } from '../physics/ephemeris/ephemeris-context';
import type { LoadingProgress } from './loading-progress';
import type { GameHost } from './game-host';
import { createJulianDate, type TdbJulianDate } from '../physics/time';
import { KEY_MAPPING as K } from '../input/key-mapping';
import { frameRoleOf } from '../physics/frame';
import { ViewBadge } from './hud/view-badge';
import { FrameControls } from './hud/frame/frame-controls';
import { syncControlledLoopSfx } from './controlled-loop-sfx';
import { ViewOptionsControl } from './hud/panels/view-options-control';
import { MapVisibilityPolicy } from './map/visibility-policy';
import { savedOrbitGuideSettings } from './celestial/orbit-guide/orbit-guide-settings';
import type { ViewOptionsSettings } from './hud/panels/view-options-control';
import type { OrbitGuideSettings } from './celestial/orbit-guide/orbit-guide-settings';
import type { BurnManagementPanelHandlers } from './hud/panels/burn-management-panel';
import type { SettingValue } from '../settings/setting-value';
import type { ThemePalette } from '../theme';
import { len, sub } from '../math/vec3';
import { orbitInfo, relativeInfo } from './orbit-info';
import { isEnemy } from './dynamic/dynamic-entity/enemy';
import { isProteinEnemy } from './dynamic/dynamic-entity/protein-enemy';
import { isPlayerMotion } from './player/player-motion';
import { aliveCombatTarget } from './dynamic/dynamic-entity/combat-target';
import { focusTargetId } from './camera/focus-target';
import { frameRoleName } from './hud/frame/frame-labels';
import { summarizeRun, type RunSummary } from './run-summary';
import type { DynamicEntity } from './dynamic/dynamic-entity/dynamic-entity';
import type { OrbitReference } from './orbit-reference';
import type { HudPanelViewModels } from './hud/hud';
import type { ViewMode } from '../render/view-mode';
import type { ApproachTargetSource } from './hud/orbit/orbit-analysis-data';
import type { EnemyContact } from './hud/panels/enemies-panel';
import type { VesselPanelViewModel } from './hud/panels/vessel-panel';
import type { OrbitPanelViewModel } from './hud/orbit/orbit-panel';
import type { TargetPanelViewModel } from './hud/panels/target-panel';

export class Game {
  private readonly _scene: THREE.Scene;
  private readonly renderer: THREE.WebGPURenderer;
  private readonly pipeline: RenderPipeline;
  private readonly gpu: GpuTimingSink;
  public readonly input: Input;
  private readonly touchControls: TouchControls | null;
  private readonly _hud: Hud;
  private readonly _worldSfx: WorldSfx;
  private readonly pauseMenu: PauseMenu;
  private readonly markers: MarkerDevice;
  // 天体系・ステージ・長押しのように、このランの組み立てだけが持ち主になるマーカー。
  private readonly frameMarkers: MarkerSink;
  private readonly frameDeclarations: MarkerDeclaration[] = [];
  private readonly playerMarkers: PlayerMarkers;
  private readonly celestialMarkers: CelestialMarkers;
  public readonly cameraSystem: CameraSystem;
  // 論理視点を表示値へ写す側。sync が確定させた1フレームぶんの値を cameraFrame が持つ。
  private readonly cameraView = new CameraView();
  private cameraFrame: CameraFrame | null = null;
  // 操作対象(艦 0..n 隻と基地のうちどれを操作するか)の切替を持つ。
  private readonly controlSelection: ControlSelection;
  // いま操作している対象。操作しているものが無ければ null。
  public get activeControllable(): Controllable | null { return this.controlSelection.current; }
  public readonly simSpeedManager: SimSpeedManager;

  private readonly planDisplay: PlanDisplay;
  // 直近ノードの消化・達成通知と、その実行ガイドのマーカー。
  private readonly planGuide: PlanGuide;
  // このフレームの表示座標系と表示時刻窓。update で確定させ、sync が読む。
  public readonly displayWindowManager: DisplayWindowManager;
  private readonly viewManager: ViewManager;
  private readonly objectWindows: ObjectWindows;

  public readonly activeStage: Stage;
  // ポーズ中か。時間倍率とは独立に時間を止める。決着は止めない — 結果画面の裏でも
  // 弾・敵・補給タイマーは通常どおり進む(GAME.md §2.1)。
  public get isPaused(): boolean { return this._hud.overlayManager.isGamePaused(); }

  private readonly _celestialSystem: CelestialSystem;
  public get celestialSystem(): CelestialSystem { return this._celestialSystem; }
  // 表示パネル(天体クラス表示トグル+天球グリッドトグル+軌道ガイドタブ)。
  private readonly viewOptions: ViewOptionsControl;
  // マップ・天球の表示設定と、表示パネルのタブの選択。
  private readonly viewOptionSettings: ViewOptionsSettings;
  // このランで選んでいる軌道ガイド。セーブへ残る選択の正本。
  private orbitGuideSettings: OrbitGuideSettings;
  // 選ばれている配色。
  private readonly themePalette: SettingValue<ThemePalette>;
  // ブースターの取り付け・点火・切り離しの口。
  private readonly boosterHandlers: BurnManagementPanelHandlers;

  public readonly targeter: Targeter;
  public readonly navTarget: NavTarget;
  private readonly frameAnchors: FrameAnchors;
  public readonly orbitReference = new OrbitReferenceSelector();
  public readonly dynamicSystem: DynamicSystem;
  // 閃光・ガスパフなど、寿命だけで消えていく一過性の見た目。
  private readonly flashEffects: FlashEffects;
  private readonly flashEffectsView: FlashEffectsView;
  private readonly entityLines: EntityLineManager;
  private readonly equatorNodes: EquatorNodeManager;
  private readonly predictor: Predictor;
  private readonly viewBadge: ViewBadge;
  private readonly frameControls: FrameControls;
  // 計測区間の境界を打つ先。
  private readonly sections: FrameSections;

  // 星系を組んでから、このランを組み立てる。段の切れ目で描画を明け渡すので、
  // 組み立て中の Game は誰にも観測されないまま数フレームをまたぐ。
  public static async create(
    host: GameHost,
    stageClass: StageClass,
    audioEngine: AudioEngine,
    pauseMenu: PauseMenu,
    initialSave: GameSaveData | undefined,
    startEpoch: TdbJulianDate | undefined,
    graphics: GraphicsSettingsData,
    renderStyle: RenderStyle,
    progress: LoadingProgress,
  ): Promise<Game> {
    const { scene: gs } = host;
    await progress.enter('system');
    // このランの元期。セーブの元期、開始日時の指定、ステージの宣言の順に採る — 保存された simTime
    // はセーブの元期からの経過秒なので、別の元期で組むと全天体がずれる。
    const savedJdTdb = initialSave?.ephemerisContext.epochJdTdb;
    const epoch = savedJdTdb !== undefined ? createJulianDate('TDB', savedJdTdb) : startEpoch ?? stageClass.epoch;
    const celestialSystem = await stageClass.createCelestialSystem(
      epoch, (ratio) => progress.within(ratio), gs.renderer,
    );
    await progress.enter('bodies');
    celestialSystem.build(gs.scene, gs.pipeline);
    await progress.enter('run');
    const game = new Game(host, stageClass, audioEngine, pauseMenu, celestialSystem, initialSave);
    // シェーダを組む前に、最初に描かれるフレームと同じ表示状態を時間の進まない1フレームで作る —
    // 天体表面の分割段のように update/sync が決めるまで現れない表示物が、事前コンパイルから漏れる。
    game.update(0, gs.viewport);
    game.sync(graphics, renderStyle, gs.viewport, 0);
    await progress.enter('shaders');
    // カメラは直前の sync が確定させたものを使う — 捨てる1フレームと同じ行列で組ませる。
    await gs.pipeline.compile(
      gs.scene,
      game.cameraFrame!.camera,
      renderStyle,
      (name, done, total) => progress.within(done / total, `シェーダを準備中: ${name}`),
    );
    // 出力段の階調変換は three が実際に描いたときにしか組まないので、捨てる 1 フレームで組ませる。
    game.render(renderStyle);
    return game;
  }

  // このランを1件ぶんのセーブ本体へ畳む。
  public serialize(): GameSaveData {
    return {
      version: SAVE_VERSION,
      stageId: this.activeStage.id,
      simTime: this.simTime,
      ephemerisContext: { ...ephemerisContextFor(this._celestialSystem.epoch) },
      entities: this.dynamicSystem.serialize(),
      activeControlledId: this.activeControllable?.id ?? null,
      stage: this.activeStage.serialize(),
      // 遊ぶ人の選択。
      camera: { view: this.viewManager.current, ...this.cameraSystem.serialize() },
      navTarget: this.navTarget.id !== null ? { id: this.navTarget.id, name: this.navTarget.name! } : null,
      orbitGuide: this.orbitGuideSettings,
    };
  }

  // 各サブシステムを、互いの依存関係が満たせる順に生成して配線する。星系は実体化済みで渡る。
  private constructor(
    host: GameHost,
    stageClass: StageClass,
    audioEngine: AudioEngine,
    pauseMenu: PauseMenu,
    celestialSystem: CelestialSystem,
    initialSave?: GameSaveData,
  ) {
    this.sections = host.sections;
    this._scene = host.scene.scene;
    this.renderer = host.scene.renderer;
    this.pipeline = host.scene.pipeline;
    this.gpu = host.scene.gpu;
    this._celestialSystem = celestialSystem;
    this._hud = host.hud;
    this.viewOptionSettings = host.viewOptions;
    this.themePalette = host.themePalette;
    this._worldSfx = new WorldSfx(audioEngine);
    const uiSfx = new UiSfx(audioEngine);
    this.pauseMenu = pauseMenu;

    this.markers = host.markers;
    this.frameMarkers = this.markers.createGroup();
    this.playerMarkers = new PlayerMarkers(this.markers.createGroup());

    this.flashEffects = new FlashEffects();
    this.flashEffectsView = new FlashEffectsView(this._scene);
    this.dynamicSystem = new DynamicSystem(
      this._scene, this._hud, this._worldSfx, this.flashEffects, celestialSystem,
      this.sections, initialSave?.simTime ?? 0, initialSave);
    this.entityLines = new EntityLineManager(this.dynamicSystem);
    this.equatorNodes = new EquatorNodeManager(this.dynamicSystem, this.markers.createGroup());
    this.displayWindowManager = new DisplayWindowManager(
      this._hud.mapRoot, this._hud.panelCollapse, celestialSystem,
    );

    // 表示パネル。左レールの並びはパネルを足した順で決まるので、同じレールへ足す座標系パネル
    // (FrameControls)より先に組む。
    this.orbitGuideSettings = savedOrbitGuideSettings(initialSave?.orbitGuide);
    this.viewOptions = new ViewOptionsControl(
      this._hud.mapRoot, this._hud.panelCollapse, host.viewOptions, this.orbitGuideSettings,
      (next) => { this.orbitGuideSettings = next; },
    );

    // ビューの正本(ViewManager)はカメラより後に組み上がるため、遅延評価で渡す。
    // 姿勢は現在値しか持たないため、解決はフォーカス id → 生存エンティティの現在姿勢。
    this.cameraSystem = new CameraSystem(
      this._hud, celestialSystem, () => this.viewManager.current,
      (id, t) => {
        const role = frameRoleOf(id);
        const entity = role === 'controlled' ? this.activeControllable
          : role === 'navTarget'
            ? this.navTarget.resolveState(this.dynamicSystem, celestialSystem, celestialSystem.celestialMotions, t)?.entity ?? null
            : this.dynamicSystem.all().find((e) => e.id === id) ?? null;
        return entity?.motion.alive ? entity.motion.att.q : null;
      },
      initialSave?.camera, host.scene.viewport,
    );
    this.celestialMarkers = new CelestialMarkers(this.markers.createGroup(), celestialSystem);
    this.simSpeedManager = new SimSpeedManager(this._hud, uiSfx);
    this.navTarget = new NavTarget(this._hud, this.markers.createGroup());
    this.navTarget.restore(initialSave?.navTarget, this.dynamicSystem);
    // 参照フレームの基準・回転対象が機体・役割トークンを指すときの解決役。update()/sync() の
    // 先頭で毎フレーム表示時刻を差し込み、以降のフレーム変換の呼び出しはこれを渡す。
    this.frameAnchors = new FrameAnchors(celestialSystem, {
      entityState: (id, t) => this.dynamicSystem.all()
        .find((e) => e.id === id && e.motion.alive)
        ?.motion.stateAt(t, celestialSystem) ?? null,
      controlledState: (t) => this.activeControllable?.motion.stateAt(t, celestialSystem) ?? null,
      navTargetState: (bodies, t) => this.navTarget.resolveState(this.dynamicSystem, celestialSystem, bodies, t)?.state ?? null,
    });
    this.frameControls = new FrameControls(
      this._hud.mapRoot, this._hud.combatRoot, this._hud.layers.popup,
      celestialSystem, this.cameraSystem.mapCamera, this.cameraSystem.combatCamera,
      this.displayWindowManager, this._hud.overlayManager, this.frameAnchors,
    );
    this.targeter = new Targeter(
      this.markers, this.navTarget, this.dynamicSystem, celestialSystem.celestialMotions,
    );
    this.controlSelection = new ControlSelection(
      initialSave?.activeControlledId, this.dynamicSystem, this.cameraSystem, this.navTarget, this._hud,
    );
    this.boosterHandlers = {
      onAttach: () => { this.activeControllable?.boosters?.attach(); },
      onToggleIgnition: () => { this.activeControllable?.boosters?.toggleIgnition(); },
      onDecouple: () => { this.activeControllable?.boosters?.decouple(this.dynamicSystem); },
    };
    this.planDisplay = new PlanDisplay(
      this._scene, this.markers.createGroup(), celestialSystem, this.displayWindowManager, this.controlSelection,
    );
    this.planGuide = new PlanGuide(this._hud, uiSfx, this.markers.createGroup());
    this.input = new Input(host.scene.renderer.domElement);
    this.touchControls = new TouchControls(this.input);
    this.input.onPointerKindChange = (kind) => this.touchControls?.setPointerKind(kind);

    this.predictor = new Predictor(this.dynamicSystem, celestialSystem);

    this.activeStage = new stageClass(
      initialSave?.stage, this._hud, this._worldSfx, uiSfx, this._scene, this.dynamicSystem,
      this.flashEffects, celestialSystem, this.controlSelection,
    );
    this._hud.root.classList.toggle('creative-mode', this.activeStage.id === 'creative');
    // activeStage を読むのでその後に組む。ビューより先に組み上がるので、現在のビューは遅延評価で渡す。
    this.objectWindows = new ObjectWindows(
      this._hud, this.dynamicSystem, celestialSystem, this.navTarget,
      this.cameraSystem, () => this.viewManager.activeView, this.pauseMenu,
      this.controlSelection, this.frameControls, this.activeStage, this.targeter, this.displayWindowManager,
    );

    const combatView = new CombatView(
      this.input, this.cameraSystem, this.targeter, this.objectWindows, this.dynamicSystem,
      this.celestialMarkers, this.touchControls,
      this.controlSelection, this.planDisplay.path, this.planGuide,
    );
    const mapView = new MapView(
      this.input, this.cameraSystem, this.objectWindows,
      this.dynamicSystem, this.equatorNodes, celestialSystem,
      this.celestialMarkers, this.markers, this.targeter.combatMarkers,
      this.displayWindowManager, this.frameControls,
      this.frameAnchors, this.controlSelection, this.simSpeedManager, this.planDisplay,
      this._scene, this._hud, uiSfx, this.navTarget, this.viewOptionSettings.mapDisplay,
    );
    // 初期ビューは世界が組み上がった後にしか決まらない — 攻略ステージの自機は Stage の初期配置で
    // 置かれるので、戦闘ビューへ入れるかどうかはその後でなければ判定できない。
    this.viewManager = new ViewManager(
      this._hud, this.touchControls, this.controlSelection,
      { combat: combatView, map: mapView },
      initialSave?.camera?.view,
    );

    this.viewBadge = new ViewBadge(
      this._hud.viewBadgeRow, this._hud.layers.notify, this._hud.overlayManager, this.viewManager,
    );
    this.viewBadge.onRenderStyleChange = (style) => this._hud.setRenderStyle(style);

    // 復元した focus を、軌道表示の基準系へも通しておく。
    this.frameControls.setFocus(this.cameraSystem.mapCamera.focus);
  }

  // ------------------------------------------------------------------ lifecycle

  // このゲームが scene・Hud・マーカー装置・window/document/canvas へ足したものを残らず
  // 取り除く。呼んだ後のこのインスタンスは使えない。構築の逆順で辿る — 後から組んだものほど
  // 先に組んだものを参照する。
  public dispose(): void {
    // Hud はこのゲームより長生きするので、書き換えたクラスを戻し、操作対象も操作の受け口も
    // 無い状態を1度宣言してから畳む。
    this._hud.root.classList.remove('creative-mode');
    this._hud.clearRunPanels();
    this.viewBadge.dispose();
    this.viewManager.dispose();
    this.objectWindows.dispose();
    this.activeStage.dispose();
    this._worldSfx.dispose();
    this.touchControls?.dispose();
    this.input.dispose();
    this.planDisplay.dispose();
    this.planGuide.dispose();
    this._celestialSystem.dispose();
    this.frameControls.dispose();
    this.cameraSystem.dispose();
    this.viewOptions.dispose();
    this.displayWindowManager.dispose();
    this.equatorNodes.dispose();
    this.dynamicSystem.dispose();
    this.flashEffectsView.dispose();
    this.targeter.dispose();
    this.navTarget.dispose();
    this.celestialMarkers.dispose();
    this.playerMarkers.dispose();
    this.frameMarkers.dispose();
  }

  public get simTime(): number { return this.dynamicSystem.simTime; }

  // ------------------------------------------------------------ update

  // 1フレームぶんの update フェーズ。dtRaw [s] は実時間の経過。ポーズ中もシミュレーション
  // 以外の更新は通す。
  public update(dtRaw: number, viewport: Viewport): void {
    this.sections.enter(SECTION.input);
    this.input.update();
    const dt = Math.min(dtRaw, 0.1);
    // ポーズ中も Esc・ヘルプなどは効かせるので、入力配分はポーズ判定より前に置く。
    this.handleInput(dt);
    this.sections.exit(SECTION.input);

    // ポーズは開いているオーバーレイからの導出値で「止まった瞬間」が無いので、止まっている
    // 間は毎フレーム連続指令を畳む。
    if (this.isPaused) this.dynamicSystem.pause();
    else this.advanceSimulation(dt);
    // ここから先はポーズ中も決着後も通す。決着は積分を止めないので、飛ばすと描画原点になる
    // カメラ位置だけが絶対 ECI に取り残され、追従対象が軌道速度で流れて即フレームアウトする。
    const activeControllable = this.activeControllable;
    const view = this.viewManager.current;
    const displayWindow = this.displayWindowManager.resolve(
      this.dynamicSystem.simTime, activeControllable, view !== 'map',
    );
    // 過去表示に要る履歴の長さを要求する。次の積分がサンプルを積むまでに立っていればよいので、
    // 窓が確定したこの場で渡す。
    this.dynamicSystem.requestHistoryDuration(displayWindow.pastDuration);
    // このフレームが天体を引く表示時刻を差し込む: 以降の frameTransformAt 呼び出しは
    // すべてこの frameAnchors を通す。
    this.frameAnchors.update(displayWindow.displayTime);
    // 計画表示、予測伸長、選択候補、カメラはこの順序で同じ時刻の状態へ更新する。
    this.sections.enter(SECTION.plan);
    this.planDisplay.update(displayWindow, this.frameAnchors, view);
    this.sections.exit(SECTION.plan);
    // ポーズ中・決着後も呼ぶ。simTime が止まっていれば予測は伸び切ったところで止まる。
    this.sections.enter(SECTION.predict);
    this.predictor.update(
      this.dynamicSystem.simTime, this.dynamicSystem.lastSimDt,
      activeControllable?.motion ?? null, displayWindow.duration, this.planDisplay.growableArcs(),
    );
    this.sections.exit(SECTION.predict);
    // 交点を置く先は計画折れ線か解析軌道楕円のどちらかなので、折れ線を組み終えた計画表示と、
    // 楕円が引く予測列を伸ばした後に通す。
    this.sections.enter(SECTION.plan);
    const equatorVisibility = this.cameraSystem.view === 'map'
      ? new MapVisibilityPolicy(
        this._celestialSystem, this.viewOptionSettings.mapDisplay.current,
      )
      : null;
    this.equatorNodes.update({
      displayTime: displayWindow.displayTime,
      celestialBodies: this._celestialSystem,
      frameAnchors: this.frameAnchors,
      paths: this.planDisplay,
    }, activeControllable, this.navTarget.id, equatorVisibility);
    // ノードの期限切れ・達成はビューに依らない計画そのものの規則なので、折れ線を組み終えた
    // 後に毎フレーム通す。
    this.planGuide.update(
      activeControllable, this.dynamicSystem.simTime, this._celestialSystem.celestialMotions);
    this.sections.exit(SECTION.plan);
    this.sections.enter(SECTION.camera);
    this.cameraSystem.update(
      displayWindow.displayTime, this.input, dt, this.viewManager.activeView.pickables,
      this.frameAnchors, activeControllable, viewport,
    );
    this.sections.exit(SECTION.camera);
    // カメラ更新の後に置く — 候補列の組み直しは遮蔽判定などにカメラ位置を読むので、先に組むと
    // このフレームの sync が1フレーム古いカメラ位置での判定を読む。
    this.sections.enter(SECTION.mapPick);
    this.viewManager.activeView.update(displayWindow);
    this.sections.exit(SECTION.mapPick);
    this.sections.enter(SECTION.pointer);
    this.handlePointerInput(viewport);
    this.sections.exit(SECTION.pointer);
  }

  // ステージ → 指令決定 → 積分 → エフェクトの順に1フレーム進める
  // (残骸・弾の先端時刻はどの状況でも進め続ける)。
  private advanceSimulation(dt: number): void {
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
      controlled, this.input, canShipAct, dt, simDt, canEngage, this.activeStage);

    this.targeter.updateBoardMarks(dt, controlled);
    this.controlSelection.reclaimDead();

    this.sections.enter(SECTION.effects);
    this.flashEffects.update(dt, this.dynamicSystem.simTime);
    this.sections.exit(SECTION.effects);
  }

  // ポインタ入力を現在のビューへ配る。このフレームの cameraSystem.update が終わって初めて投影が
  // このフレームの値になるので、update の末尾に置く。ポーズ中と入力ゲート中はそのまま戻る。
  private handlePointerInput(viewport: Viewport): void {
    if (this.isPaused || this._hud.overlayManager.isInputGated()) return;
    this.viewManager.activeView.handlePointer(this.dynamicSystem.simTime, viewport);
  }

  // --------------------------------------------------------------- input

  // 入力エッジを担当モジュールへ先着順で配る。決めるのは優先順位 = 呼ぶ順序だけで、
  // どのキー/クリックが何をするかは各モジュールが持つ。
  private handleInput(dt: number): void {
    // ESC: 開いているオーバーレイがあれば最前面を閉じ、何も無ければ一時停止メニューを開く。
    if (this.input.takeKey(K.pauseMenu)) {
      if (!this._hud.overlayManager.closeTopmostOnEscape()) this.pauseMenu.toggle(true);
    }
    // オーバーレイの項目ショートカット([F]等)も同じ優先度で最前面へ配送する。
    this.input.takeKeys((code) => this._hud.overlayManager.dispatchShortcut(code));
    this._hud.handleInput(this.input);
    // ヘルプや設定など、背景入力をゲートするモーダルが開いた後は、同じフレームの
    // ワープ/ビュー切り替え/計画編集へキーを漏らさない。
    if (this._hud.overlayManager.isInputGated()) return;
    this.simSpeedManager.handleInput(this.input);
    this.viewManager.handleInput(this.input);
    // ビュー固有のキー(マップ=計画の編集)は現在のビューが持つ。
    this.viewManager.activeView.handleInput(this.input, dt, this.dynamicSystem.simTime);
  }

  // ------------------------------------------------------------------ sync

  // 1フレームぶんの sync フェーズ。update が確定させた表示窓とカメラを表示物へ写す。
  // nowMs はフレームの先頭で1度だけ読んだ実時刻 [ms]。
  public sync(
    graphics: GraphicsSettingsData, style: RenderStyle, viewport: Viewport, nowMs: number,
  ): void {
    const controlled = this.activeControllable;
    const palette = this.themePalette.current;
    // update() が確定させた、このフレームの表示窓。
    const displayWindow = this.displayWindowManager.current;
    this.viewBadge.sync({
      modeLabel: this.activeStage.stageClass.selectLabel,
      view: this.viewManager.current,
      selectableViews: this.viewManager.selectableViews(),
      focusName: this.focusName(),
      controlName: controlled?.name ?? null,
      targetName: this.navTarget.name,
      renderStyle: style,
    });

    // 表示時刻 = 未来ゴーストのスライダーぶん先取りした simTime。
    const { displayTime, simTime } = displayWindow;
    const celestialBodies = this._celestialSystem.celestialMotions;

    // 最初に行う: 後続の sync とマーカー投影がこのフレームのカメラ行列と描画原点を読む。
    const cs = this.cameraSystem;
    const camera = this.cameraView.sync(
      cs.activeViewpoint, cs.clipFovDeg, cs.clipDistance, viewport, cs.view, cs.zoomActive, cs.focusVelocity,
    );
    this.cameraFrame = camera;
    this.viewOptions.setVisible(this.viewManager.current === 'map');
    // 天体ラベルの間引きは、この後のマーカー同期が近接判定に読むので先に済ませる。
    this.viewManager.activeView.syncLabels(displayWindow, camera, nowMs);

    // 表示・選択可否はこのフレームの update フェーズで現在のビューが確定させたものを読む
    // (選べる対象と描かれる対象が同じ判定から出るようにする)。
    const visibilityPolicy = this.viewManager.activeView.visibilityPolicy;
    // 3D 軌道線を軌道パネルと同じ基準で解く。
    const orbitRef = controlled
      ? this.orbitReference.resolve(
        controlled.motion.state.r, celestialBodies, this.navTarget,
        this.dynamicSystem, this._celestialSystem, controlled.motion.state.t,
      )
      : undefined;

    this._celestialSystem.sync(
      displayTime, nowMs, camera, this.cameraSystem, graphics, style,
      this.viewOptionSettings.mapDisplay.current, this.viewOptionSettings.grid.current,
      this.orbitGuideSettings, visibilityPolicy,
    );
    // 本数の警告は、天体系がこのフレームに組んだ軌道ガイド線から出す。
    this.viewOptions.setOrbitGuideLineCount(this._celestialSystem.orbitGuide.lineCount);
    this._celestialSystem.bakeClouds(this.renderer, displayTime, this.gpu);

    // 通過時刻ラベルの設定は、赤道交点と航法ターゲットの両方が同じものを読む。
    const timeLabel = timeLabelSettingOf(displayWindow);
    this.dynamicSystem.sync(
      displayTime, controlled, visibilityPolicy, camera, style, graphics,
      orbitRef,
    );
    // 操作中の艦の軌道軸・ボアサイトは、機体の同期と同じフレームの状態から置く。
    this.playerMarkers.sync(
      controlled !== null && isPlayer(controlled) ? controlled : null, camera.mode, camera.project,
      orbitRef?.state ?? null, nowMs,
    );
    this.equatorNodes.sync(
      camera.project,
      camera.position,
      this.frameAnchors.bodies,
      this.frameAnchors.bodiesPivot,
      camera.mode === 'map',
      timeLabel,
      nowMs,
    );
    syncControlledLoopSfx(
      this._worldSfx, controlled, displayTime, !this.isPaused && this.activeStage.isPlaying);
    // ビルボードはこのフレームのカメラ姿勢へ向けるので、cameraView.sync より後に通す。
    this.flashEffectsView.sync(this.flashEffects.live, camera);

    this.targeter.sync(
      controlled, camera, displayTime, visibilityPolicy, this.celestialMarkers.activeLabels, nowMs, palette);
    this.navTarget.sync(
      camera, this.frameAnchors.bodies, this.frameAnchors.bodiesPivot, timeLabel, nowMs);

    // 戦闘中に開いたプロパティウィンドウも最新値を表示し続ける必要があるので、ビューに依らず呼ぶ。
    this.objectWindows.sync(simTime, displayTime);
    this.planDisplay.sync(camera, displayWindow, nowMs);

    // 計画軌道の折れ線と同じ座標系で描かないと、同一画面上で並べたときに比較にならない。
    this.entityLines.sync(
      controlled, this.targeter.aliveTarget, this.viewManager.current, displayWindow, visibilityPolicy, orbitRef,
      camera, this.frameAnchors, this._celestialSystem, palette);
    // ビュー専用のパネル・表示物と軌道線の右クリック候補。軌道線が今フレーム焼いたサンプルを
    // 読むため、celestialSystem.sync/entityLines.sync の後に置く。
    this.viewManager.activeView.syncPanels(displayWindow, camera, nowMs);

    this.activeStage.sync(camera, displayTime);

    const view = this.viewManager.current;
    this._hud.syncPanels(view, this.hudPanelViewModels(view, orbitRef, palette), camera, nowMs);

    this.syncFrameMarkers(nowMs);
    // このフレームのマーカーが出揃った後でなければならないので最後に置く。
    this.markers.resolveOverlaps(this.viewManager.current === 'map');
  }

  // 天体系・ステージが組んだ宣言と、長押しのフィードバックを1つの群へまとめて置く。
  private syncFrameMarkers(nowMs: number): void {
    const declarations = this.frameDeclarations;
    declarations.length = 0;
    declarations.push(...this._celestialSystem.markerDeclarations);
    declarations.push(...this.activeStage.markerDeclarations);
    const longPress = this.input.longPressPoint;
    declarations.push({
      id: 'longpress', cls: 'mk-longpress', sym: '',
      x: longPress?.x ?? 0, y: longPress?.y ?? 0, front: longPress !== null,
      priority: MARKER_PRIORITY.NONE,
    });
    this.frameMarkers.sync(declarations, nowMs);
  }

  // ------------------------------------------------------- HUD へ渡す値
  // 値を束ねる場所は、ここが持ち物を全部知っている間の暫定(暫定 — 段 7 で Game を分解する)。

  // 常設パネルの値をこのランの状態から束ねる。view は表に出ているビューで、
  // そこに出るパネルのぶんだけを組む。
  private hudPanelViewModels(
    view: ViewMode, orbitRef: OrbitReference | undefined, palette: ThemePalette,
  ): HudPanelViewModels {
    const controlled = this.activeControllable;
    // 戦闘ビューにしか出ないパネルは、マップでは値を組まない。
    const combatControlled = view === 'map' ? null : controlled;
    const displayWindow = this.displayWindowManager.current;
    const { simTime } = displayWindow;
    const scoreCounter = this.activeStage.scoreCounter;
    // 操作対象が要るパネルは、対象が無い間 null で畳む。
    return {
      topBar: {
        epochUnixSec: displayWindow.epochUnixSec,
        simTime,
        simSpeed: this.simSpeedManager.simSpeed,
        isPaused: this.isPaused,
        autoWarpRealRemainSec: this.simSpeedManager.estimatedRealSecondsToWarpEnd(simTime),
        autoWarpSimRemainSec: this.simSpeedManager.remainingSimulationSeconds(simTime),
        setSimSpeed: (speed) => this.simSpeedManager.setSpeed(speed),
      },
      vessel: combatControlled === null ? null : this.vesselViewModel(combatControlled),
      orbit: controlled === null || orbitRef === undefined
        ? null
        : this.orbitViewModel(controlled, orbitRef),
      target: this.targetViewModel(combatControlled),
      enemies: combatControlled === null ? null : {
        remainingCount: scoreCounter.totalEnemiesSpawned - scoreCounter.kills,
        totalCount: scoreCounter.totalEnemiesSpawned,
        contacts: this.enemyContacts(combatControlled),
        onSelectRight: (id, x, y) => this.objectWindows.openEnemy(id, x, y),
      },
      burnManagement: controlled?.boosters?.managementViewModel() ?? null,
      burnHandlers: this.boosterHandlers,
      mapFocus: this.cameraSystem.mapCamera.resolvedFocus,
      analysisSource: {
        celestialSystem: this._celestialSystem,
        windowDurationSec: displayWindow.duration,
        palette,
      },
      analysisSubject: controlled === null || orbitRef === undefined
        ? null
        : { entity: controlled, reference: orbitRef, target: this.approachTarget() },
    };
  }

  // 操作対象の装備・燃料・姿勢の状態と、代替操作の口。
  private vesselViewModel(controlled: Controllable): VesselPanelViewModel {
    const motion = controlled.motion;
    const player = isPlayerMotion(motion) ? motion : null;
    const power = player?.power ?? null;
    const radiator = player?.radiator ?? null;
    const fire = controlled.fire;
    // 積んでいない装備は null で答える。
    return {
      rcsDamp: controlled.throttle.rcsDamp,
      throttleIdx: controlled.throttle.throttleIdx,
      dynamicPressurePa: player?.aero?.qdyn ?? null,
      fineAttitude: controlled.fineAttitude,
      cameraFollowsAttitude: this.cameraSystem.combatCamera.rotationFollow?.kind === 'attitude',
      progradeHold: controlled.throttle.progradeHold,
      totalFuel: controlled.totalFuel,
      totalMaxFuel: controlled.totalMaxFuel,
      ammo: fire === null ? null : { rounds: fire.rounds, mags: fire.mags, cooldown: fire.cooldown },
      solar: power === null ? null : {
        up: { deploy: power.deployOf('up'), wear: 0 },
        down: { deploy: power.deployOf('down'), wear: 0 },
      },
      radiator: radiator === null ? null : {
        up: { deploy: radiator.deployOf('up'), wear: radiator.wearOf('up') },
        down: { deploy: radiator.deployOf('down'), wear: radiator.wearOf('down') },
      },
      tapKey: (key) => this.input.tapKey(key),
      toggleSolar: (side) => power?.toggle(side),
      toggleRadiator: (side) => radiator?.toggle(side),
    };
  }

  // 操作対象の軌道要素と、基準切替の口。航法ターゲット基準で対象が重力天体でない(艦・基地・
  // ラグランジュ点)場合は、天体名の生 ID フォールバックより航法ターゲットの表示名を優先する。
  private orbitViewModel(controlled: Controllable, reference: OrbitReference): OrbitPanelViewModel {
    const info = orbitInfo(
      controlled, reference, controlled.motion.state.t, (id: string) => this._celestialSystem.nameOf(id),
    );
    const motion = controlled.motion;
    // 軌道の数値は基準に対して解き、警告と切替の状態は操作対象から直に引く。
    return {
      selectedMode: this.orbitReference.selectedMode,
      centerId: info.centerId,
      centerName: !reference.attractor && this.navTarget.name ? this.navTarget.name : info.centerName,
      altitudeM: info.alt,
      descendWarned: controlled.altitudeAlarm?.descendWarned ?? false,
      speedMps: info.spd,
      apAltitudeM: info.apAlt,
      peAltitudeM: info.peAlt,
      inclinationDeg: info.incDeg,
      periodSec: info.period,
      dynamicPressurePa: isPlayerMotion(motion) ? motion.aero?.qdyn ?? null : null,
      temperatureK: motion.temperature,
      setReferenceMode: (mode) => this.orbitReference.setMode(mode),
    };
  }

  // 固定中のターゲットの読み値。操作対象かターゲットが無ければ null。
  private targetViewModel(controlled: Controllable | null): TargetPanelViewModel | null {
    const target = controlled === null ? null : this.targeter.aliveTarget;
    if (controlled === null || target === null) return null;
    const relative = relativeInfo(
      controlled, target, this._celestialSystem.celestialMotions, controlled.motion.state.t,
    );
    // 距離・接近速度は、両者の基準天体に依らない相対量として解く。
    return {
      name: target.name,
      distanceM: relative.dist,
      closingMps: relative.closing,
      relativeSpeedMps: relative.relSpeed,
      hp: target.hp,
      maxHp: target.maxHp,
      protein: isProteinEnemy(target) ? target.combatReadout : null,
      onSelectRight: (x, y) => this.objectWindows.openTarget(x, y),
    };
  }

  // 生存している敵に、操作対象からの距離と固定の有無を添えて一覧の形へ写す。
  private enemyContacts(controlled: Controllable): readonly EnemyContact[] {
    const viewerPos = controlled.motion.state.r;
    const primaryTarget = this.targeter.aliveTarget;
    return this.dynamicSystem.all()
      .filter(isEnemy)
      .filter((enemy) => enemy.motion.alive)
      .map((enemy) => ({
        id: enemy.id,
        name: enemy.name,
        distanceM: len(sub(enemy.motion.state.r, viewerPos)),
        waveId: enemy.waveId,
        targeted: enemy === primaryTarget,
      }));
  }

  // 現在の航法ターゲットを、接近・投影タブが扱える形(天体 or 個体)へ解決する。
  // 質量を持たない対象(ラグランジュ点など)と、ターゲット未選択のときは null。
  private approachTarget(): ApproachTargetSource | null {
    const id = this.navTarget.id;
    if (id === null) return null;
    const body = this._celestialSystem.find(id)?.motion;
    if (body !== undefined) return { kind: 'celestialBody', body };
    const entity = aliveCombatTarget(this.dynamicSystem.all(), id);
    return entity ? { kind: 'entity', entity } : null;
  }

  // 注視対象の表示名。アプシス/交点などの一時マーカーも指しうるので、座標系の役割・被選択物
  // 候補・実体・天体名(未登録なら id)の順に引く。
  private focusName(): string {
    const id = focusTargetId(this.cameraSystem.activeFocus);
    if (id === undefined) return '固定点';
    const role = frameRoleOf(id);
    if (role !== null) return frameRoleName(role);
    const pickable = this.viewManager.activeView.pickables.find((item) => item.id === id);
    if (pickable) return pickable.name;
    const entity: DynamicEntity | undefined = this.dynamicSystem.all().find((item) => item.id === id);
    if (entity) return entity.name;
    return this._celestialSystem.nameOf(id);
  }

  // このランのいまの要約。
  public runSummary(): RunSummary {
    return summarizeRun(
      this.simTime, this.activeStage.phase, this.activeControllable,
      this._celestialSystem, this.dynamicSystem.all(),
    );
  }

  // ------------------------------------------------------------------ render

  // このフレームの sync が確定させたカメラで描く。まだ1度も sync していなければ何も描かない。
  public render(style: RenderStyle): void {
    if (this.cameraFrame === null) return;
    this.pipeline.render(this._scene, this.cameraFrame.camera, style);
  }

  // ------------------------------------------------------------------ debug

  // 各モジュールが答えた計測値を1つに合流させる。
  public perfCounts(): PerfCounts {
    return {
      ...this.dynamicSystem.perfCounts(),
      ...this.predictor.perfCounts(
        this.dynamicSystem.simTime, this.displayWindowManager.current.duration,
        this.activeControllable?.motion ?? null,
      ),
      ...this.planDisplay.perfCounts(),
      ...this._celestialSystem.perfCounts(),
      ...this.viewManager.activeView.perfCounts(),
      // ここから下は Game 自身が答える値。
      displayDurationSec: this.displayWindowManager.current.duration,
      warp: this.simSpeedManager.simSpeed,
    };
  }

  // タンパク質敵モーションの集計値。
  public proteinMotionFrameSample(): ProteinMotionFrameSample {
    return proteinMotionFrameSample(this.dynamicSystem.all());
  }
}
