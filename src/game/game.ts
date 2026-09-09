// ゲーム全体のオーケストレーション: 各システムの生成・保持と、フレームごとの呼び出し順序の決定。
import * as THREE from 'three/webgpu';
import type { PerfCounts } from './perf-counts';
import { proteinMotionFrameSample, type ProteinMotionFrameSample } from './protein/protein-motion-metrics';
import { FrameSections, SECTION } from './frame-sections';
import type { Controllable } from './dynamic/dynamic-entity/controllable';
import { CameraSystem } from './camera/camera-system';
import { Stage, StageClass } from './stages/stage';
import { MarkerManager } from './marker/marker-manager';
import { CelestialMarkers } from './marker/celestial-markers';
import { EquatorNodeManager } from './marker/equator-node-manager';
import { ControlSelection } from './control-selection';
import { Targeter } from './targeter';
import { PlanDisplay } from './plan/plan-display';
import { DisplayWindowManager, timeLabelSettingOf } from './display-window-manager';
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
import { Hud } from './hud/hud';
import { PauseMenu } from '../hud/windows/pause-menu';
import { WorldSfx } from '../audio/sfx/world-sfx';
import { UiSfx } from '../audio/sfx/ui-sfx';
import type { AudioEngine } from '../audio/audio-engine';
import { GameScene } from '../render/scene';
import type { RenderPipeline } from '../render/pipeline/render-pipeline';
import type { GraphicsSettingsData } from '../render/graphics-settings';
import type { RenderStyle } from '../render/render-style';
import { CelestialSystem } from './celestial/celestial-system';
import { ViewManager } from './view/view-manager';
import { CombatView } from './view/combat-view';
import { MapView } from './view/map-view';
import { NavTarget } from './nav-target';
import { FrameAnchors } from './frame-anchors';
import { autoOrbitReference, OrbitReferenceSelector } from './orbit-reference';
import { ObjectWindows } from './pickable/object-windows';
import { Navball } from './navball/navball';
import { GameSaveData, SAVE_VERSION } from './save/save-data';
import { ephemerisContextFor } from '../physics/ephemeris/ephemeris-context';
import type { RunSummary } from './run-summary';
import { orbitInfo } from './orbit-info';
import { LoadingProgress } from './loading-progress';
import { createJulianDate, type TdbJulianDate } from '../physics/time';
import { KEY_MAPPING as K } from '../input/key-mapping';
import { frameRoleOf } from '../physics/frame';
import { ViewBadge } from './hud/view-badge';
import { FrameControls } from './hud/frame/frame-controls';
import { syncControlledLoopSfx } from './controlled-loop-sfx';
import { MapVisibilityPolicy } from './map/visibility-policy';

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
  private readonly equatorNodes: EquatorNodeManager;
  private readonly predictor: Predictor;
  private readonly viewBadge: ViewBadge;
  private readonly frameControls: FrameControls;
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
      autoOrbitReference(
        controlled.motion.state.r, celestial.celestialMotions, controlled.motion.state.t,
      ),
      controlled.motion.state.t, (id: string) => celestial.nameOf(id),
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
      enemyAliveCount: entities.filter(isEnemy).filter((e) => e.motion.alive).length,
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
    this.equatorNodes = new EquatorNodeManager(this.dynamicSystem, this.markerManager);
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
        return entity?.motion.alive ? entity.motion.att.q : null;
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
      entityState: (id, t) => this.dynamicSystem.all()
        .find((e) => e.id === id && e.motion.alive)
        ?.motion.stateAt(t, celestialSystem) ?? null,
      controlledState: (t) => this.activeControllable?.motion.stateAt(t, celestialSystem) ?? null,
      navTargetState: (bodies, t) => this.navTarget.resolveState(this.dynamicSystem, celestialSystem, bodies, t)?.state ?? null,
    });
    this.frameControls = new FrameControls(
      this._hud.mapRoot, this._hud.layers.popup, celestialSystem, this.cameraSystem.mapCamera,
      this.displayWindowManager, this._hud.overlayManager, this.frameAnchors,
    );
    this.targeter = new Targeter(
      this.markerManager, this.navTarget, this.dynamicSystem, celestialSystem.celestialMotions, this.celestialMarkers,
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
    this._hud.burnManagementPanel.setHandlers({
      onAttach: () => { this.activeControllable?.boosters?.attach(); },
      onToggleIgnition: () => { this.activeControllable?.boosters?.toggleIgnition(); },
      onDecouple: () => { this.activeControllable?.boosters?.decouple(this.dynamicSystem); },
    });
    this.planDisplay = new PlanDisplay(
      this._scene, this.markerManager, celestialSystem, this.displayWindowManager, this.controlSelection,
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
    // activeStage の authoring/executesPlans を読むので、その直後に生成する。候補列と計画の
    // 編集口はマップビューが持つので、ビューより先に組み上がるここへは遅延評価で渡す。
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
      this._scene, this._hud, uiSfx, this.navTarget,
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

    // 復元した focus を、軌道表示の基準系へも通しておく。
    this.frameControls.setFocus(this.cameraSystem.mapCamera.focus);
  }

  // ------------------------------------------------------------------ lifecycle

  // 時間を止め、連続指令を畳む。
  pause(): void {
    this._worldSfx.setThrust(false);
    this._worldSfx.setRcs(false);
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
    this._hud.burnManagementPanel.setHandlers({});
    this._hud.burnManagementPanel.sync(null);
    this._worldSfx.dispose();
    this.touchControls?.dispose();
    this.input.dispose();
    this.planDisplay.dispose();
    this._celestialSystem.dispose();
    this.frameControls.dispose();
    this.cameraSystem.dispose();
    this.displayWindowManager.dispose();
    this.equatorNodes.dispose();
    this.dynamicSystem.dispose();
    this.flashEffects.dispose();
    this.markerManager.dispose();
  }

  get simTime(): number { return this.dynamicSystem.simTime; }

  // ------------------------------------------------------------ update

  update(dtRaw: number): void {
    this.sections.enter(SECTION.input);
    this.input.update();
    const dt = Math.min(dtRaw, 0.1);
    // ポーズ中も Esc・ヘルプなどは効かせるので、入力配分はポーズ判定より前に置く。
    this.handleInput(dt);
    this.sections.exit(SECTION.input);

    if (!this._isPaused && this.activeStage.isPlaying) this.advanceSimulation(dt);
    // ここから先はポーズ中も決着後も通す。決着は積分を止めないので、飛ばすと描画原点になる
    // カメラ位置だけが絶対 ECI に取り残され、追従対象が軌道速度で流れて即フレームアウトする。
    const activeControllable = this.activeControllable;
    const displayWindow = this.displayWindowManager.resolve(this.dynamicSystem.simTime, activeControllable);
    // 過去表示に要る履歴の長さを要求する。次の積分がサンプルを積むまでに立っていればよいので、
    // 窓が確定したこの場で渡す。
    this.dynamicSystem.requestHistoryDuration(displayWindow.pastDuration);
    const view = this.viewManager.current;
    const canDisplayFuture = !this.displayWindowManager.forceCurrent;
    // このフレームが天体を引く表示時刻を差し込む: 以降の frameTransformAt 呼び出しは
    // すべてこの frameAnchors を通す。
    this.frameAnchors.update(displayWindow.displayTime);
    // 計画表示、予測伸長、選択候補、カメラはこの順序で同じ時刻の状態へ更新する。
    this.sections.enter(SECTION.plan);
    this.planDisplay.update(displayWindow, this.frameAnchors, view);
    this.sections.exit(SECTION.plan);
    // 予測の伸長対象は軌道分析ウィンドウが見ている個体を含むので、予測より先に確定させる。
    this._hud.updateAnalysisReaders(this);
    // ポーズ中・決着後も無条件に呼ぶ: simTime が止まっている間はサブステップも進まず、
    // 消費も期限切れの張り直しも起きないので、予測は伸び切ったところで止まるだけで害はない。
    this.sections.enter(SECTION.predict);
    this.predictor.update(
      this.dynamicSystem.simTime, this.dynamicSystem.lastSimDt,
      activeControllable?.motion ?? null, displayWindow.duration,
      canDisplayFuture, this.planDisplay.growableArcs(),
    );
    this.sections.exit(SECTION.predict);
    // 交点を置く先は計画折れ線か解析軌道楕円のどちらかなので、折れ線を組み終えた計画表示と、
    // 楕円が引く予測列を伸ばした後に通す。
    this.sections.enter(SECTION.plan);
    const equatorVisibility = this.cameraSystem.view === 'map'
      ? new MapVisibilityPolicy(
        this._celestialSystem, this.cameraSystem.mapDisplayToggles,
      )
      : null;
    this.equatorNodes.update({
      displayTime: displayWindow.displayTime,
      celestialBodies: this._celestialSystem,
      frameAnchors: this.frameAnchors,
      paths: this.planDisplay,
    }, activeControllable, equatorVisibility);
    this.sections.exit(SECTION.plan);
    this.sections.enter(SECTION.camera);
    this.cameraSystem.update(
      displayWindow.displayTime, this.input, dt, this.viewManager.activeView.pickables,
      this.frameAnchors, activeControllable,
    );
    this.sections.exit(SECTION.camera);
    // カメラ更新の後に置く: 候補列の組み直しが読む近傍系抽出・遮蔽判定・可視マーカー更新は
    // cameraSystem.activeCameraPos を使うので、先に組むとこのフレームの sync が1フレーム古い
    // カメラ位置基準の判定を読むことになる。
    this.sections.enter(SECTION.mapPick);
    this.viewManager.activeView.update(displayWindow);
    this.sections.exit(SECTION.mapPick);
    this.sections.enter(SECTION.pointer);
    this.handlePointerInput();
    this.sections.exit(SECTION.pointer);
    // View の描画同期ではなく update フェーズで、次回予測の読者を確定する。
    this.entityLines.updatePredictionReaders(
      this.activeControllable,
      this.targeter.aliveTarget,
      this.viewManager.current,
      displayWindow,
      this.viewManager.activeView.visibilityPolicy,
    );
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
  private handlePointerInput(): void {
    if (this._isPaused || this._hud.overlayManager.isInputGated()) return;
    this.viewManager.activeView.handlePointer(this.dynamicSystem.simTime);
  }

  // --------------------------------------------------------------- input

  // 入力エッジを担当モジュールへ先着順で配る。決めるのは優先順位 = 呼ぶ順序だけで、
  // どのキー/クリックが何をするかは各モジュールが持つ。ここで配るのは、決着後・ポーズ中も
  // 効くべき操作(設定・ヘルプ・再出撃・ワープ・マップ開閉・計画破棄・計画のΔv編集)。
  private handleInput(dt: number): void {
    // ESC: 開いているオーバーレイがあれば最前面を閉じ、何も無ければ一時停止メニューを開く。
    if (this.input.takeKey(K.pauseMenu)) {
      if (!this._hud.overlayManager.closeTopmostOnEscape()) this.pauseMenu.toggle(true);
    }
    // オーバーレイの項目ショートカット([F]等)も同じ優先度で最前面へ配送する。
    this.input.takeKeys((code) => this._hud.overlayManager.dispatchShortcut(code));
    // 上から下へ優先順位順に呼ぶ。
    this._hud.handleInput(this.input);
    // ヘルプや設定など、背景入力をゲートするモーダルが開いた後は、同じフレームの
    // ワープ/ビュー切り替え/計画編集へキーを漏らさない。
    if (this._hud.overlayManager.isInputGated()) return;
    this.simSpeedManager.handleInput(this.input);
    this.viewManager.handleInput(this.input);
    // ビュー固有のキー(戦闘=計画破棄/自動ワープ、マップ=Δv 編集)は現在のビューが持つ。
    this.viewManager.activeView.handleInput(this.input, dt, this.dynamicSystem.simTime);
  }

  // ------------------------------------------------------------------ sync

  sync(graphics: GraphicsSettingsData, style: RenderStyle): void {
    const controlled = this.activeControllable;
    // update() が確定させた、このフレームの表示窓。
    const displayWindow = this.displayWindowManager.current;
    this.viewBadge.sync(
      this.activeStage.stageClass.selectLabel, this.cameraSystem.activeFocus,
      controlled, this.navTarget.name,
    );

    // 表示時刻 = 未来ゴーストのスライダーぶん先取りした simTime。
    const { displayTime, simTime } = displayWindow;
    const celestialBodies = this._celestialSystem.celestialMotions;

    // 最初に行う: 後続の sync とマーカー投影がこのフレームのカメラ行列と描画原点を読む。
    this.cameraSystem.sync();
    const fo = this.cameraSystem.getFloatingOrigin();
    // 天体ラベルの間引きは、この後のマーカー同期が近接判定に読むので先に済ませる。
    this.viewManager.activeView.syncLabels(displayWindow);

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
      fo, displayTime,
      this.cameraSystem, graphics, style, visibilityPolicy, this.markerManager,
    );
    this._celestialSystem.bakeClouds(this.renderer, displayTime);

    // 通過時刻ラベルの設定は、赤道交点と航法ターゲットの両方が同じものを読む。
    const timeLabel = timeLabelSettingOf(displayWindow);
    this.dynamicSystem.sync(
      fo, displayTime, controlled, visibilityPolicy, this.cameraSystem, style, graphics,
      orbitRef,
    );
    this.equatorNodes.sync(
      this.cameraSystem.activeCameraProjection,
      this.cameraSystem.activeCameraPos,
      this.frameAnchors.bodies,
      this.frameAnchors.bodiesPivot,
      this.cameraSystem.view === 'map',
      timeLabel,
    );
    syncControlledLoopSfx(this._worldSfx, controlled, displayTime, visibilityPolicy);
    // ビルボードはこのフレームのカメラ姿勢へ向けるので、cameraSystem.sync より後に通す。
    this.flashEffects.sync(fo, this.cameraSystem.activeCamera, this.cameraSystem.zoomActive);

    this.targeter.sync(controlled, this.cameraSystem, displayTime, simTime, visibilityPolicy);
    this.navTarget.sync(
      this.cameraSystem, this.frameAnchors.bodies, this.frameAnchors.bodiesPivot, timeLabel);

    // 戦闘中に開いたプロパティウィンドウも最新値を表示し続ける必要があるので、ビューに依らず呼ぶ。
    this.objectWindows.sync(simTime, displayTime);
    this.planDisplay.sync(this.cameraSystem, fo, displayWindow);

    // 計画軌道の折れ線と同じ座標系で描かないと、同一画面上で並べたときに比較にならない。
    this.entityLines.sync(
      controlled, this.targeter.aliveTarget, this.viewManager.current, displayWindow, visibilityPolicy, orbitRef,
      fo, this.cameraSystem.activeCamera, this.frameAnchors, this._celestialSystem);
    // ビュー専用のパネル・表示物と軌道線の右クリック候補。軌道線が今フレーム焼いたサンプルを
    // 読むため、celestialSystem.sync/entityLines.sync の後に置く。
    this.viewManager.activeView.syncPanels(displayWindow, fo);

    this.activeStage.sync(fo, this.cameraSystem, displayTime, visibilityPolicy);

    this._hud.syncPanels(this.viewManager.current, this);

    // このフレームのマーカーが出揃った後でなければならないので最後に置く。
    this.markerManager.resolveCollisions(this.viewManager.current);
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
        this.dynamicSystem.simTime, this.displayWindowManager.current.duration,
        this.activeControllable?.motion ?? null,
      ),
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
