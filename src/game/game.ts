// ゲーム全体のオーケストレーション: 各システムの生成・保持と、フレームごとの呼び出し順序の決定。
import * as THREE from 'three/webgpu';
import type { PerfCounts } from './perf-counts';
import { proteinMotionFrameSample, type ProteinMotionFrameSample } from './protein/protein-motion-metrics';
import { SECTION, type FrameSections } from './frame-sections';
import type { Controllable } from './dynamic/dynamic-entity/controllable';
import { CameraSystem } from './camera/camera-system';
import type { Stage, StageClass } from './stages/stage';
import { MarkerManager } from './marker/marker-manager';
import { CelestialMarkers } from './marker/celestial-markers';
import { EquatorNodeManager } from './marker/equator-node-manager';
import { ControlSelection } from './control-selection';
import { Targeter } from './targeter';
import { PlanDisplay } from './plan/plan-display';
import { DisplayWindowManager } from './display-window-manager';
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
import { ViewOptionsControl } from './hud/panels/view-options-control';
import type { MapDisplayToggles } from './map/display-toggles';
import type { RunSetting } from './run-setting';
import type { OrbitGuideSettings } from './celestial/orbit-guide/orbit-guide-settings';
import type { CelestialGridVisibility } from '../render/celestial-grid';
import { GameInputRouter, type GameInputPort } from './input/game-input-router';
import { gameCommand } from './input/game-commands';
import { rawGameInputAdapter } from './input/raw-game-input-adapter';
import { GameInputPhase } from './runtime/game-input-phase';
import { SimulationPhase } from './runtime/simulation-phase';
import { DisplayPhase } from './runtime/display-phase';
import { PresentationPhase } from './runtime/presentation-phase';

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
  private readonly markerManager: MarkerManager;
  private readonly celestialMarkers: CelestialMarkers;
  public readonly cameraSystem: CameraSystem;
  // 論理視点を表示値へ写す側。sync が確定させた1フレームぶんの値を cameraFrame が持つ。
  private readonly cameraView = new CameraView();
  // 操作対象(艦 0..n 隻と基地のうちどれを操作するか)の切替を持つ。
  private readonly controlSelection: ControlSelection;
  // いま操作している対象。操作しているものが無ければ null。
  public get activeControllable(): Controllable | null { return this.controlSelection.current; }
  public readonly simSpeedManager: SimSpeedManager;

  private readonly planDisplay: PlanDisplay;
  // このフレームの表示座標系・表示時刻窓と、表示側の重力源窓。update で確定させ、sync が読む。
  public readonly displayWindowManager: DisplayWindowManager;
  private readonly viewManager: ViewManager;
  private readonly objectWindows: ObjectWindows;

  public readonly activeStage: Stage;
  // ポーズ中か。時間倍率とは独立に時間を止める。
  private _isPaused = false;
  public get isPaused(): boolean { return this._isPaused; }

  private readonly _celestialSystem: CelestialSystem;
  public get celestialSystem(): CelestialSystem { return this._celestialSystem; }
  // 表示パネル(天体クラス表示トグル+天球グリッドトグル+軌道ガイドタブ)。
  private readonly viewOptions: ViewOptionsControl;
  // マップの表示トグル。
  private readonly mapDisplay: RunSetting<MapDisplayToggles>;
  // 天球グリッドの表示。
  private readonly grid: RunSetting<CelestialGridVisibility>;
  // 軌道ガイドの設定。
  private readonly orbitGuide: RunSetting<OrbitGuideSettings>;

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
  private readonly inputRouter: GameInputRouter;
  private readonly inputPhase: GameInputPhase;
  private readonly simulationPhase: SimulationPhase;
  private readonly displayPhase: DisplayPhase;
  private readonly presentationPhase: PresentationPhase;

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
    const savedJdTdb = initialSave?.ephemerisContext?.epochJdTdb;
    const epoch = savedJdTdb !== undefined ? createJulianDate('TDB', savedJdTdb) : startEpoch ?? stageClass.epoch;
    // 地球の自転初期位相。起動ごとに無作為だが、下位を決定的に保つため乱数はここでだけ引く。
    const earthSpinPhase0 = initialSave?.earthSpinPhase0 ?? Math.random() * 2 * Math.PI;
    const celestialSystem = await stageClass.createCelestialSystem(
      initialSave?.phaseOffsets ?? {}, earthSpinPhase0, epoch, (ratio) => progress.within(ratio), gs.renderer,
    );
    await progress.enter('bodies');
    celestialSystem.build(gs.scene, gs.pipeline);
    await progress.enter('run');
    const game = new Game(host, stageClass, audioEngine, pauseMenu, celestialSystem, renderStyle, initialSave);
    // シェーダを組む前に、最初に描かれるフレームと同じ表示状態を時間の進まない1フレームで作る —
    // 天体表面の分割段のように update/sync が決めるまで現れない表示物が、事前コンパイルから漏れる。
    game.update(0, gs.viewport);
    game.sync(graphics, renderStyle, gs.viewport);
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
    const { phaseOffsets, earthSpinPhase0 } = this._celestialSystem.serialize();
    // 元期・星系の位相と、実体・操作対象・ステージ・カメラ・航法ターゲット。
    return {
      version: SAVE_VERSION,
      stageId: this.activeStage.id,
      simTime: this.simTime,
      ephemerisContext: { ...ephemerisContextFor(this._celestialSystem.epoch) },
      phaseOffsets,
      earthSpinPhase0,
      entities: this.dynamicSystem.serialize(),
      activeControlledId: this.activeControllable?.id ?? null,
      stage: this.activeStage.serialize(),
      camera: { view: this.viewManager.current, ...this.cameraSystem.serialize() },
      navTarget: this.navTarget.id !== null ? { id: this.navTarget.id, name: this.navTarget.name! } : null,
    };
  }

  // 各サブシステムを、互いの依存関係が満たせる順に生成して配線する。星系は実体化済みで渡る。
  private constructor(
    host: GameHost,
    stageClass: StageClass,
    audioEngine: AudioEngine,
    pauseMenu: PauseMenu,
    celestialSystem: CelestialSystem,
    renderStyle: RenderStyle,
    initialSave?: GameSaveData,
  ) {
    this.sections = host.sections;
    this._scene = host.scene.scene;
    this.renderer = host.scene.renderer;
    this.pipeline = host.scene.pipeline;
    this.gpu = host.scene.gpu;
    this._celestialSystem = celestialSystem;
    this._hud = host.hud;
    this.mapDisplay = host.mapDisplay;
    this.grid = host.grid;
    this.orbitGuide = host.orbitGuide;
    this._worldSfx = new WorldSfx(audioEngine);
    const uiSfx = new UiSfx(audioEngine);
    this.pauseMenu = pauseMenu;

    this.markerManager = new MarkerManager(this._hud.layers.marker, this._hud.svgOverlay);

    this.flashEffects = new FlashEffects();
    this.flashEffectsView = new FlashEffectsView(this._scene);
    this.dynamicSystem = new DynamicSystem(
      this._scene, this._hud, this._worldSfx, this.flashEffects, this.markerManager, celestialSystem,
      this.sections, initialSave?.simTime ?? 0, initialSave);
    this.entityLines = new EntityLineManager(this.dynamicSystem);
    this.equatorNodes = new EquatorNodeManager(this.dynamicSystem, this.markerManager);
    this.displayWindowManager = new DisplayWindowManager(this._hud.mapRoot, celestialSystem);

    // 表示パネル。左レールの並びはパネルを足した順で決まるので、同じレールへ足す座標系パネル
    // (FrameControls)より先に組む。
    this.viewOptions = new ViewOptionsControl(this._hud.mapRoot, host.mapDisplay, host.grid, host.orbitGuide);

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
    this.celestialMarkers = new CelestialMarkers(this.markerManager, celestialSystem);
    this.simSpeedManager = new SimSpeedManager(this._hud, uiSfx);
    this.navTarget = new NavTarget(this._hud, this.markerManager);
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
      this.markerManager, this.navTarget, this.dynamicSystem, celestialSystem.celestialMotions,
    );
    this.controlSelection = new ControlSelection(
      initialSave?.activeControlledId, this.dynamicSystem, this.cameraSystem, this.navTarget, this._worldSfx, this._hud,
    );
    this._hud.burnManagementPanel.setHandlers({
      onAttach: () => { this.activeControllable?.boosters?.attach(); },
      onToggleIgnition: () => { this.activeControllable?.boosters?.toggleIgnition(); },
      onDecouple: () => { this.activeControllable?.boosters?.decouple(this.dynamicSystem); },
    });
    this.planDisplay = new PlanDisplay(
      this._scene, this.markerManager, celestialSystem, this.displayWindowManager, this.controlSelection,
    );
    this.input = new Input(host.scene.renderer.domElement);
    this.touchControls = new TouchControls(this.input);
    this.input.onPointerKindChange = (kind) => this.touchControls?.setPointerKind(kind);
    this.input.onLongPressFeedback = (point) => {
      if (point) this.markerManager.set('longpress', 'mk-longpress', '', point.x, point.y, true);
      else this.markerManager.hide('longpress');
    };
    this._hud.vesselPanel.setInput(this.input);

    this.predictor = new Predictor(this.dynamicSystem, celestialSystem);

    this.activeStage = new stageClass(
      initialSave?.stage, this._hud, this._worldSfx, uiSfx, this._scene, this.dynamicSystem,
      this.flashEffects, this.markerManager, celestialSystem, this.controlSelection,
    );
    this._hud.root.classList.toggle('creative-mode', this.activeStage.id === 'creative');
    // activeStage を読むのでその後に組む。ビューより先に組み上がるので、現在のビューは遅延評価で渡す。
    this.objectWindows = new ObjectWindows(
      this._hud, this.dynamicSystem, celestialSystem, this.navTarget,
      this.cameraSystem, () => this.viewManager.activeView, this.pauseMenu,
      this.controlSelection, this.frameControls, this.activeStage, this.targeter,
    );

    const combatView = new CombatView(
      this.input, this.cameraSystem, this.targeter, this.objectWindows, this.dynamicSystem,
      this.celestialMarkers, this.touchControls,
      this.controlSelection, this.planDisplay.path, celestialSystem.celestialMotions,
      this.simSpeedManager, this._hud, uiSfx, this.markerManager,
    );
    const mapView = new MapView(
      this.input, this.cameraSystem, this.objectWindows,
      this.dynamicSystem, this.equatorNodes, celestialSystem,
      this.celestialMarkers, this.markerManager, this.displayWindowManager, this.frameControls,
      this.frameAnchors, this.controlSelection, this.simSpeedManager, this.planDisplay,
      this._scene, this._hud, uiSfx, this.navTarget, this.mapDisplay,
    );
    // 初期ビューは世界が組み上がった後にしか決まらない — 攻略ステージの自機は Stage の初期配置で
    // 置かれるので、戦闘ビューへ入れるかどうかはその後でなければ判定できない。
    this.viewManager = new ViewManager(
      this._hud, this.touchControls, this.displayWindowManager, this.controlSelection,
      { combat: combatView, map: mapView },
      initialSave?.camera?.view,
    );

    this.viewBadge = new ViewBadge(
      this._hud.viewBadgeRow, this._hud.layers.notify, this.viewManager, this._hud.overlayManager,
      renderStyle, this.dynamicSystem, celestialSystem,
    );
    this.viewBadge.onRenderStyleChange = (style) => this._hud.setRenderStyle(style);

    // 復元した focus を、軌道表示の基準系へも通しておく。
    this.frameControls.setFocus(this.cameraSystem.mapCamera.focus);

    this.inputRouter = new GameInputRouter(rawGameInputAdapter(this.input), [
      {
        feature: 'pause',
        commands: [gameCommand(K.pauseMenu.code, K.pauseMenu)],
        handleCommand: () => {
          if (!this._hud.overlayManager.closeTopmostOnEscape()) this.pauseMenu.toggle(true);
        },
      },
      {
        feature: 'overlay-shortcut',
        handlePressed: code => this._hud.overlayManager.dispatchShortcut(code),
      },
      {
        feature: 'hud',
        commands: [gameCommand(K.help.code, K.help)],
        handleCommand: command => this._hud.handleCommand(command.id),
      },
      {
        feature: 'camera-command',
        commands: [gameCommand(K.followAttitudeToggle.code, K.followAttitudeToggle)],
        handleCommand: command => this.cameraSystem.handleCommand(command.id),
      },
      {
        feature: 'target-command',
        isEnabled: () => !this._isPaused
          && !this._hud.overlayManager.isInputGated()
          && this.viewManager.current === 'combat'
          && this.activeControllable !== null,
        commands: [gameCommand(K.targetSelect.code, K.targetSelect)],
        handleCommand: () => this.targeter.requestTargetSelect(),
      },
      {
        feature: 'game-speed',
        isEnabled: () => !this._hud.overlayManager.isInputGated(),
        commands: [
          gameCommand(K.warpSlower.code, K.warpSlower),
          gameCommand(K.warpFaster.code, K.warpFaster),
        ],
        handleCommand: command => this.simSpeedManager.handleCommand(command.id),
      },
      {
        feature: 'view',
        isEnabled: () => !this._hud.overlayManager.isInputGated(),
        commands: [gameCommand(K.toggleMapMode.code, K.toggleMapMode)],
        handleCommand: command => this.viewManager.handleCommand(command.id),
      },
      {
        feature: 'active-view',
        isEnabled: () => !this._hud.overlayManager.isInputGated(),
        commands: [
          gameCommand(K.deleteNode.code, K.deleteNode),
          gameCommand(K.autoWarpToNode.code, K.autoWarpToNode),
        ],
        handleCommand: command => this.viewManager.activeView.handleCommand(
          command.id, this.dynamicSystem.simTime,
        ),
      },
    ]);
    this.inputPhase = new GameInputPhase(this.input, this.inputRouter, this._hud, this.viewManager);
    this.simulationPhase = new SimulationPhase(
      this.input, this.sections, this.activeStage, this.simSpeedManager, this.dynamicSystem,
      this.targeter, this.controlSelection, this.flashEffects,
      (active, registry, operable) => this.inputPhase.routeControllableInput(active, registry, operable),
    );
    this.displayPhase = new DisplayPhase(
      this.input, this.sections, this._hud, this.displayWindowManager, this.dynamicSystem,
      this._celestialSystem, this.frameAnchors, this.planDisplay, this.predictor, this.equatorNodes,
      this.cameraSystem, this.viewManager, this.targeter, this.entityLines, this.navTarget,
      this.mapDisplay, () => this._isPaused,
    );
    this.presentationPhase = new PresentationPhase(
      this.renderer, this.gpu, this.cameraView, this._hud, this.activeStage,
      this._celestialSystem, this.dynamicSystem, this.cameraSystem, this.viewManager, this.viewOptions,
      this.mapDisplay, this.grid, this.orbitGuide, this.orbitReference, this.equatorNodes,
      this.frameAnchors, this._worldSfx, this.flashEffectsView, this.targeter, this.navTarget,
      this.objectWindows, this.planDisplay, this.entityLines, this.displayWindowManager,
      this.simSpeedManager, this.markerManager, this.viewBadge, this.flashEffects,
      this.celestialMarkers, () => this.activeControllable, () => this._isPaused,
    );
  }

  // ------------------------------------------------------------------ lifecycle

  // 時間を止め、連続指令を畳む。
  public pause(): void {
    this._worldSfx.setThrust(false);
    this._worldSfx.setRcs(false);
    this.dynamicSystem.pause();
    this._isPaused = true;
  }

  public resume(): void { this._isPaused = false; }

  // このゲームが scene・Hud・window/document/canvas へ足したものを残らず取り除く。呼んだ後の
  // このインスタンスは使えない。構築の逆順で辿る — 後から組んだものほど先に組んだものを参照する。
  // マーカープールは最後 — 各表示物が自分の dispose で自分のキーを外していくため。
  public dispose(): void {
    this.viewBadge.dispose();
    this.viewManager.dispose();
    this.objectWindows.dispose();
    this.activeStage.dispose();
    // Hud はこのゲームより長生きするので、書き換えたクラスと差し込んだ参照を元へ戻す。
    this._hud.root.classList.remove('creative-mode');
    this._hud.vesselPanel.setInput(null);
    this._hud.burnManagementPanel.setHandlers({});
    this._hud.burnManagementPanel.sync(null);
    this._worldSfx.dispose();
    this.touchControls?.dispose();
    this.input.dispose();
    this.planDisplay.dispose();
    this._celestialSystem.dispose();
    this.frameControls.dispose();
    this.cameraSystem.dispose();
    this.viewOptions.dispose();
    this.displayWindowManager.dispose();
    this.equatorNodes.dispose();
    this.dynamicSystem.dispose();
    this.flashEffectsView.dispose();
    this.markerManager.dispose();
  }

  public get simTime(): number { return this.dynamicSystem.simTime; }
  public get cameraFrame(): CameraFrame | null { return this.presentationPhase.currentCameraFrame; }

  // ------------------------------------------------------------ update

  // 1フレームぶんの update フェーズ。dtRaw [s] は実時間の経過。ポーズ中・決着後もシミュレーション
  // 以外の更新は通す。
  public update(dtRaw: number, viewport: Viewport): void {
    const dt = Math.min(dtRaw, 0.1);
    this.sections.enter(SECTION.input);
    this.inputPhase.update(dt);
    this.sections.exit(SECTION.input);

    if (!this._isPaused && this.activeStage.isPlaying) {
      this.simulationPhase.update(dt, this.activeControllable);
    }
    this.displayPhase.update(this.activeControllable, dt, viewport);
  }

  // Game 更新後、Launcher と snapshot の入力を同じ raw edge router へ追加する。
  public routeInput(ports: readonly GameInputPort[]): void {
    this.inputPhase.routeAdditional(ports);
  }

  // ------------------------------------------------------------------ sync

  // 1フレームぶんの sync フェーズ。update が確定させた表示窓とカメラを表示物へ写す。
  public sync(graphics: GraphicsSettingsData, style: RenderStyle, viewport: Viewport): void {
    this.presentationPhase.sync(graphics, style, viewport);
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
