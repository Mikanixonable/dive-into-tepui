// ゲーム全体のオーケストレーション: 各システムの生成・保持と、フレームごとの呼び出し順序の決定。
import * as THREE from 'three/webgpu';
import type { PerfCounts } from './perf-counts';
import { proteinMotionFrameSample, type ProteinMotionFrameSample } from './protein/protein-motion-metrics';
import { SECTION } from './frame-sections';
import type { FrameSections } from './frame-sections';
import type { Controllable } from './dynamic/dynamic-entity/controllable';
import { CameraSystem } from './camera/camera-system';
import { StageClass } from './stages/stage';
import type { Stage } from './stages/stage';
import { MarkerManager } from './marker/marker-manager';
import { CelestialMarkers } from './marker/celestial-markers';
import { ControlSelection } from './control-selection';
import { Targeter } from './targeter';
import { PlanEditor } from './plan/plan-editor';
import { PlanDisplay } from './plan/plan-display';
import { DisplayWindowManager } from './display-window-manager';
import { SimSpeedManager } from './dynamic/sim-speed-manager';
import { DynamicSystem } from './dynamic/dynamic-system';
import { FlashEffects } from './vfx/flash-effects';
import { isEnemy } from './dynamic/dynamic-entity/enemy';
import { isBase } from './dynamic/dynamic-entity/base';
import { isPlayer } from './player/player';
import { EntityLineManager } from './lines/entity-line-manager';
import { Predictor } from './dynamic/predictor';
import { Input } from '../input/input';
import { TouchControls } from './hud/touch-controls';
import type { Hud } from './hud/hud';
import type { PauseMenu } from '../hud/windows/pause-menu';
import { WorldSfx } from '../audio/sfx/world-sfx';
import { UiSfx } from '../audio/sfx/ui-sfx';
import type { AudioEngine } from '../audio/audio-engine';
import type { GameScene } from '../render/scene';
import type { RenderPipeline } from '../render/pipeline/render-pipeline';
import type { GraphicsSettingsData } from '../render/graphics-settings';
import type { RenderStyle } from '../render/render-style';
import type { CelestialSystem } from './celestial/celestial-system';
import { ViewManager } from './view/view-manager';
import { CombatView } from './view/combat-view';
import { MapView } from './view/map-view';
import { NavTarget } from './nav-target';
import { FrameAnchors } from './frame-anchors';
import { autoOrbitReference, OrbitReferenceSelector } from './orbit-reference';
import { ObjectPickables } from './pickable/object-pickables';
import { LinePickables } from './pickable/line-pickables';
import { ObjectWindows } from './pickable/object-windows';
import { Navball } from './navball/navball';
import { SAVE_VERSION } from './save/save-data';
import type { GameSaveData } from './save/save-data';
import { ephemerisContextFor } from '../physics/ephemeris/ephemeris-context';
import type { RunSummary } from './run-summary';
import { orbitInfo } from './orbit-info';
import type { LoadingProgress } from './loading-progress';
import { createJulianDate, type TdbJulianDate } from '../physics/time';
import { frameRoleOf } from '../physics/frame';
import { ViewBadge } from './hud/view-badge';
import { FrameControls } from './hud/frame/frame-controls';
import type { OrbitAnalysisSource } from './hud/orbit/orbit-analysis-source';
import { InputCoordinator } from './input-coordinator';
import { SimulationCoordinator } from './simulation-coordinator';
import { PresentationCoordinator } from './presentation-coordinator';

export class Game {
  private readonly _scene: THREE.Scene;
  private readonly renderer: THREE.WebGPURenderer;
  private readonly pipeline: RenderPipeline;
  readonly input: Input;
  private readonly touchControls: TouchControls | null;
  private readonly _hud: Hud;
  private readonly _worldSfx: WorldSfx;
  private readonly pauseMenu: PauseMenu;
  private readonly markerManager: MarkerManager;
  private readonly celestialMarkers: CelestialMarkers;
  readonly cameraSystem: CameraSystem;
  // 操作対象(艦 0..n 隻と基地のうちどれを操作するか)の切替を持つ。
  private readonly controlSelection: ControlSelection;
  // いま操作している対象。操作しているものが無ければ null。
  get activeControllable(): Controllable | null { return this.controlSelection.current; }
  readonly simSpeedManager: SimSpeedManager;

  private readonly planDisplay: PlanDisplay;
  // このフレームの表示座標系・表示時刻窓と、表示側の重力源窓。update で確定させ、sync が読む。
  readonly displayWindowManager: DisplayWindowManager;
  readonly viewManager: ViewManager;
  private readonly objectWindows: ObjectWindows;

  readonly activeStage: Stage;
  // ポーズは Game 自身の状態として持つ。「時間を止めるか」と「どの倍率まで相互作用を成立させるか」
  // は別の関心事。
  private _isPaused = false;
  get isPaused(): boolean { return this._isPaused; }

  private readonly _celestialSystem: CelestialSystem;
  get celestialSystem(): CelestialSystem { return this._celestialSystem; }
  private readonly navball: Navball;

  readonly targeter: Targeter;
  readonly navTarget: NavTarget;
  private readonly frameAnchors: FrameAnchors;
  readonly orbitReference = new OrbitReferenceSelector();
  readonly dynamicSystem: DynamicSystem;
  // 閃光・ガスパフなど、寿命だけで消えていく一過性の見た目。
  private readonly flashEffects: FlashEffects;
  private readonly entityLines: EntityLineManager;
  private readonly predictor: Predictor;
  private readonly viewBadge: ViewBadge;
  private readonly frameControls: FrameControls;
  private readonly inputCoordinator: InputCoordinator;
  private readonly simulationCoordinator: SimulationCoordinator;
  private readonly presentationCoordinator: PresentationCoordinator;
  // 計測区間の境界を打つ先。
  private readonly sections: FrameSections;

  // 星系を組んでから、このランを組み立てる。段の切れ目で描画を明け渡すので、
  // 組み立て中の Game は誰にも観測されないまま数フレームをまたぐ。
  static async create(
    gs: GameScene,
    stageClass: StageClass,
    hud: Hud,
    audioEngine: AudioEngine,
    pauseMenu: PauseMenu,
    sections: FrameSections,
    initialSave: GameSaveData | undefined,
    startEpoch: TdbJulianDate | undefined,
    graphics: GraphicsSettingsData,
    progress: LoadingProgress,
  ): Promise<Game> {
    await progress.enter('system');
    // このランの元期。スナップショットを読むならその元期をそのまま継ぐ — 保存されている simTime
    // はその元期からの経過秒なので、別の元期で組むと全天体がずれる。次に開始日時の指定、最後に
    // ステージの宣言。星系を組む前に決まっていなければならない。
    const savedJdTdb = initialSave?.ephemerisContext?.epochJdTdb;
    const epoch = savedJdTdb !== undefined ? createJulianDate('TDB', savedJdTdb) : startEpoch ?? stageClass.epoch;
    // 地球の自転初期位相。起動ごとに無作為だが、下位を決定的に保つため乱数はここでだけ引く。
    const earthSpinPhase0 = initialSave?.earthSpinPhase0 ?? Math.random() * 2 * Math.PI;
    const celestialSystem = await stageClass.createCelestialSystem(
      initialSave?.phaseOffsets ?? {}, earthSpinPhase0, epoch, (ratio) => progress.within(ratio),
    );
    await progress.enter('bodies');
    celestialSystem.build(
      gs.scene, gs.pipeline.sunLight, gs.pipeline.exposure,
      gs.pipeline.bodyShadow, gs.pipeline.ringShadow, gs.pipeline.cumulusShadow,
      gs.pipeline.planetLight, gs.pipeline.ambient, gs.pipeline.atmosphere,
    );
    await progress.enter('run');
    const game = new Game(gs, stageClass, hud, audioEngine, pauseMenu, sections, celestialSystem, initialSave);
    // シェーダを組む前に、最初に描かれるフレームと同じ表示状態を時間の進まない1フレームで作る —
    // 天体表面の分割段のように update/sync が決めるまで現れない表示物が、事前コンパイルから漏れる。
    const style = hud.renderStyle.current;
    game.update(0);
    game.sync(graphics, style);
    await progress.enter('shaders');
    await gs.pipeline.compile(
      gs.scene,
      game.cameraSystem.activeCamera,
      style,
      (name, done, total) => progress.within(done / total, `シェーダを準備中: ${name}`),
    );
    // 出力段の階調変換は three が実際に描いたときにしか組まないので、捨てる 1 フレームで組ませる。
    game.render(style);
    return game;
  }

  // このランを1件ぶんのセーブ本体へ畳む。
  serialize(): GameSaveData {
    const { phaseOffsets, earthSpinPhase0 } = this._celestialSystem.serialize();
    return {
      version: SAVE_VERSION,
      stageId: this.activeStage.id,
      simTime: this.simTime,
      ephemerisContext: { ...ephemerisContextFor(this._celestialSystem.epoch) },
      phaseOffsets,
      earthSpinPhase0,
      // 顔ぶれは個体自身へ畳ませる。
      entities: this.dynamicSystem.serialize(),
      activeControlledId: this.activeControllable?.id ?? null,
      stage: this.activeStage.serialize(),
      camera: { view: this.viewManager.current, ...this.cameraSystem.serialize() },
      navTarget: this.navTarget.id !== null ? { id: this.navTarget.id, name: this.navTarget.name! } : null,
    };
  }

  // ランの外側が一覧へ描くための要約。自機が居ない周回でも値が欠けないよう、
  // 軌道の項は星系の原点へ寄せる。
  runSummary(): RunSummary {
    // 操作対象が居る周回なら、軌道の項もそこから解く。
    const controlled = this.activeControllable;
    const celestial = this._celestialSystem;
    const info = controlled === null ? null : orbitInfo(
      controlled,
      autoOrbitReference(controlled.state.r, celestial.celestialMotions, controlled.state.t),
      controlled.state.t, (id: string) => celestial.nameOf(id),
    );
    const entities = this.dynamicSystem.all();
    return {
      simTime: this.simTime,
      phase: this.activeStage.phase,
      centerBodyId: info ? info.centerId : celestial.origin.id,
      centerBodyName: info ? info.centerName : celestial.nameOf(celestial.origin.id),
      altitude: info ? info.alt : 0,
      speed: info ? info.spd : 0,
      hpRatio: controlled !== null && controlled.hp !== null && controlled.maxHp !== null && controlled.maxHp > 0
        ? Math.max(0, controlled.hp) / controlled.maxHp
        : 0,
      maxHp: controlled?.maxHp ?? 0,
      magazines: controlled?.fire?.mags ?? 0,
      money: entities.filter(isBase).reduce((sum, b) => sum + b.baseState.money, 0),
      playerCount: entities.filter(isPlayer).length,
      enemyAliveCount: entities.filter(isEnemy).filter((e) => e.alive).length,
    };
  }

  // 各サブシステムを、互いの依存関係が満たせる順に生成して配線する。星系は実体化済みで渡る。
  private constructor(
    gs: GameScene,
    stageClass: StageClass,
    hud: Hud,
    audioEngine: AudioEngine,
    pauseMenu: PauseMenu,
    sections: FrameSections,
    celestialSystem: CelestialSystem,
    initialSave?: GameSaveData,
  ) {
    this.sections = sections;
    this._scene = gs.scene;
    this.renderer = gs.renderer;
    this.pipeline = gs.pipeline;
    this._celestialSystem = celestialSystem;
    this._hud = hud;
    this._worldSfx = new WorldSfx(audioEngine);
    const uiSfx = new UiSfx(audioEngine);
    this.pauseMenu = pauseMenu;

    this.markerManager = new MarkerManager(this._hud.layers.marker, this._hud.svgOverlay);

    this.flashEffects = new FlashEffects(this._scene);
    this.dynamicSystem = new DynamicSystem(
      this._scene, this._hud, this._worldSfx, this.flashEffects, this.markerManager, celestialSystem,
      sections, initialSave?.simTime ?? 0, initialSave);
    this.entityLines = new EntityLineManager(this.dynamicSystem);
    this.displayWindowManager = new DisplayWindowManager(this._hud.mapRoot, celestialSystem);

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
        return entity?.alive ? entity.att.q : null;
      },
      initialSave?.camera,
    );
    this.celestialMarkers = new CelestialMarkers(this.markerManager, celestialSystem);
    this.simSpeedManager = new SimSpeedManager(this._hud, uiSfx);
    this.navTarget = new NavTarget(this._hud, this.markerManager);
    this.navTarget.restore(initialSave?.navTarget, this.dynamicSystem);
    // 参照フレームの基準・回転対象が機体・役割トークンを指すときの解決役。update()/sync() の
    // 先頭で毎フレーム表示時刻を差し込み、以降のフレーム変換の呼び出しはこれを渡す。
    this.frameAnchors = new FrameAnchors(celestialSystem, {
      entityState: (id, t) => this.dynamicSystem.all().find((e) => e.id === id && e.alive)?.stateAt(t, celestialSystem) ?? null,
      controlledState: (t) => this.activeControllable?.stateAt(t, celestialSystem) ?? null,
      navTargetState: (bodies, t) => this.navTarget.resolveState(this.dynamicSystem, celestialSystem, bodies, t)?.state ?? null,
    });
    this.frameControls = new FrameControls(
      this._hud.mapRoot, this._hud.layers.popup, celestialSystem, this.cameraSystem.mapCamera,
      this.displayWindowManager, this._hud.overlayManager, this.frameAnchors,
    );
    this.targeter = new Targeter(
      this.markerManager, this.navTarget, this.dynamicSystem, celestialSystem, this.celestialMarkers,
    );
    this.navball = new Navball(this.cameraSystem.viewOptionsPanel);
    this.navball.onOrbitGuideSettingsChange = (settings) => this._celestialSystem.setOrbitGuideSettings(settings);
    this._celestialSystem.setOrbitGuideSettings(this.navball.orbitGuideSettings);
    this.navball.onGridVisibilityChange = (visibility) => this._celestialSystem.setGridVisibility(visibility);
    this._celestialSystem.setGridVisibility(this.navball.gridVisibility);
    // 線が増えすぎたときの警告を UI へ戻す。
    this._celestialSystem.orbitGuide.setOnLineCountChange(
      (count) => this.cameraSystem.viewOptionsPanel.setOrbitGuideLineCount(count),
    );
    this.controlSelection = new ControlSelection(
      initialSave?.activeControlledId, this.dynamicSystem, this.cameraSystem, this.navTarget, this._worldSfx, this._hud,
    );
    this._hud.topBar.setCommands({
      setSimulationSpeed: (speed) => this.simSpeedManager.setSpeed(speed),
    });
    this._hud.orbitPanel.setCommands({
      setReferenceMode: (mode) => this.orbitReference.setMode(mode),
    });
    this._hud.vesselPanel.setCommands({
      toggleSolar: (side) => this.activeControllable?.power?.toggle(side),
      toggleRadiator: (side) => this.activeControllable?.radiator?.toggle(side),
    });
    this._hud.burnManagementPanel.setHandlers({
      onAttach: () => { this.activeControllable?.boosters?.attach(); },
      onToggleIgnition: () => { this.activeControllable?.boosters?.toggleIgnition(); },
      onDecouple: () => { this.activeControllable?.boosters?.decouple(this.dynamicSystem); },
    });
    this.planDisplay = new PlanDisplay(
      this._scene, this.markerManager, celestialSystem, this.displayWindowManager, this.controlSelection,
    );
    const editor = new PlanEditor(
      this._hud,
      uiSfx,
      this.simSpeedManager,
      celestialSystem,
      this._scene,
      this.controlSelection,
      this.displayWindowManager,
      this.frameControls,
      this.planDisplay.path,
    );
    this.input = new Input(gs.renderer.domElement);
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
    // activeStage の authoring/executesPlans を読むので、その直後に生成する。
    const objectPickables = new ObjectPickables(
      this.controlSelection, this.dynamicSystem, celestialSystem, this.navTarget, this.cameraSystem,
      this.celestialMarkers, this.planDisplay, this.frameAnchors,
    );
    const linePickables = new LinePickables(this.dynamicSystem, this._celestialSystem);
    this.objectWindows = new ObjectWindows(
      this._hud, this.dynamicSystem, celestialSystem, this.navTarget,
      this.cameraSystem, editor, this.simSpeedManager, this.pauseMenu, objectPickables, linePickables,
      this.controlSelection, this.frameControls, this.activeStage, this.targeter,
    );

    const combatView = new CombatView(
      this.input, this.cameraSystem, this.targeter, this.objectWindows, this.dynamicSystem,
      this.celestialMarkers, this.touchControls,
      this.controlSelection, this.planDisplay.path, celestialSystem,
      this.simSpeedManager, this._hud, uiSfx, this.markerManager,
    );
    const mapView = new MapView(
      this.input, this.cameraSystem, editor, this.objectWindows,
      this.dynamicSystem, celestialSystem, objectPickables, linePickables,
      this.celestialMarkers, this.markerManager, this.displayWindowManager, this.frameControls,
      this.frameAnchors, this.controlSelection, this._hud, this.navTarget,
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
      this._hud.renderStyle, this.dynamicSystem, celestialSystem,
    );
    const controlSelection = this.controlSelection;
    const orbitAnalysisSource: OrbitAnalysisSource = {
      get activeControllable(): Controllable | null { return controlSelection.current; },
      navTarget: this.navTarget,
      dynamicSystem: this.dynamicSystem,
      celestialSystem: this._celestialSystem,
      orbitReference: this.orbitReference,
      displayWindowManager: this.displayWindowManager,
    };
    this._hud.setOrbitAnalysisAdapter({
      source: orbitAnalysisSource,
    });

    this.inputCoordinator = new InputCoordinator(
      this.input, this._hud, this.pauseMenu, this.simSpeedManager, this.viewManager,
    );
    this.simulationCoordinator = new SimulationCoordinator(
      this.activeStage, this.simSpeedManager, this.dynamicSystem, this.targeter,
      this.controlSelection, this.flashEffects, this.input, this.sections,
    );
    this.presentationCoordinator = new PresentationCoordinator(
      this.renderer, this._hud, this.viewBadge, this.displayWindowManager, this.frameAnchors,
      this.planDisplay, this.predictor, this.cameraSystem, this.viewManager, this.input,
      this.dynamicSystem, this.simSpeedManager, this._celestialSystem, this.markerManager,
      this.targeter, this.navTarget,
      this.objectWindows, this.entityLines, this.activeStage, this.flashEffects, this.orbitReference,
      this.controlSelection, this.sections,
    );

    // 復元した focus を、軌道表示の基準系へも通しておく。
    this.frameControls.setFocus(this.cameraSystem.mapCamera.focus);
  }

  // ------------------------------------------------------------------ lifecycle

  // 時間を止め、連続指令を畳む。
  pause(): void {
    this._worldSfx.setThrust(false);
    this.dynamicSystem.pause();
    this._isPaused = true;
  }

  resume(): void { this._isPaused = false; }

  // このゲームが scene・Hud・window/document/canvas へ足したものを残らず取り除く。呼んだ後の
  // このインスタンスは使えない。構築の逆順で辿る — 後から組んだものほど先に組んだものを参照する。
  // マーカープールは最後 — 各表示物が自分の dispose で自分のキーを外していくため。
  dispose(): void {
    this.viewBadge.dispose();
    this.viewManager.dispose();
    this.objectWindows.dispose();
    this.activeStage.dispose();
    // Hud はこのゲームより長生きするので、書き換えたクラスと差し込んだ参照を元へ戻す。
    this._hud.root.classList.remove('creative-mode');
    this._hud.vesselPanel.setInput(null);
    this._hud.vesselPanel.setCommands({ toggleSolar: () => {}, toggleRadiator: () => {} });
    this._hud.topBar.setCommands({ setSimulationSpeed: () => {} });
    this._hud.orbitPanel.setCommands({ setReferenceMode: () => {} });
    this._hud.burnManagementPanel.setHandlers({});
    this._hud.burnManagementPanel.sync(null);
    this._hud.setOrbitAnalysisAdapter(null);
    this._worldSfx.dispose();
    this.touchControls?.dispose();
    this.input.dispose();
    this.planDisplay.dispose();
    this._celestialSystem.dispose();
    this.frameControls.dispose();
    this.cameraSystem.dispose();
    this.displayWindowManager.dispose();
    this.dynamicSystem.dispose();
    this.flashEffects.dispose();
    this.markerManager.dispose();
  }

  get simTime(): number { return this.dynamicSystem.simTime; }

  // ------------------------------------------------------------ update

  update(dtRaw: number): void {
    const dt = Math.min(dtRaw, 0.1);
    const simTime = this.dynamicSystem.simTime;
    this.sections.enter(SECTION.input);
    this.inputCoordinator.update(dt, simTime);
    this.sections.exit(SECTION.input);

    this.simulationCoordinator.update(dt, this._isPaused);
    this.presentationCoordinator.update(dt, this._isPaused);
  }

  // ------------------------------------------------------------------ sync

  sync(graphics: GraphicsSettingsData, style: RenderStyle): void {
    this.presentationCoordinator.sync(graphics, style, this._isPaused);
  }

  // ------------------------------------------------------------------ render

  render(style: RenderStyle): void {
    this.pipeline.render(this._scene, this.cameraSystem.activeCamera, style);
  }

  // ------------------------------------------------------------------ debug

  // 各モジュールが答えた計測値を1つに合流させる。
  perfCounts(): PerfCounts {
    return {
      ...this.dynamicSystem.perfCounts(),
      ...this.predictor.perfCounts(
        this.dynamicSystem.simTime, this.displayWindowManager.current.duration, this.activeControllable),
      ...this.planDisplay.perfCounts(),
      ...this._celestialSystem.perfCounts(),
      ...this.viewManager.activeView.perfCounts(),
      displayDurationSec: this.displayWindowManager.current.duration,
      warp: this.simSpeedManager.simSpeed,
    };
  }

  // タンパク質敵モーションの集計値。
  proteinMotionFrameSample(): ProteinMotionFrameSample {
    return proteinMotionFrameSample(this.dynamicSystem.all());
  }
}
