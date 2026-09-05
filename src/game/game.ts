// ゲーム全体のオーケストレーション: 各システムの生成・保持と、フレームごとの呼び出し順序の決定。
import * as THREE from 'three/webgpu';
import type { PerfCounts } from './perf-counts';
import type { ProteinMotionFrameSample } from './protein/protein-motion-metrics';
import { FrameSections, SECTION } from './frame-sections';
import { Player } from './player/player';
import { Base } from './dynamic/dynamic-entity/base';
import type { Controllable } from './dynamic/dynamic-entity/controllable';
import { CameraSystem } from './camera/camera-system';
import { Stage, StageClass } from './stages/stage';
import { MarkerManager } from './marker/marker-manager';
import { CelestialMarkers } from './marker/celestial-markers';
import { ActiveControllableController } from './active-controllable-controller';
import { Targeter } from './targeter';
import { PlanEditor } from './plan/plan-editor';
import { PlanDisplay } from './plan/plan-display';
import { DisplayWindowManager } from './display-window-manager';
import { SimSpeedManager } from './dynamic/sim-speed-manager';
import { DynamicSystem } from './dynamic/dynamic-system';
import { EntityLineManager } from './lines/entity-line-manager';
import { Simulator } from './dynamic/simulator';
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
import { NanWatchdog } from './dynamic/nan-watchdog';
import { NavTarget } from './nav-target';
import { FrameAnchors } from './frame-anchors';
import { autoOrbitReference, OrbitReferenceSelector, type OrbitReference } from './orbit-reference';
import { ObjectPickables } from './pickable/object-pickables';
import { LinePickables } from './pickable/line-pickables';
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
import { Docking } from './docking/docking';
import { ViewBadge } from './hud/view-badge';
import { FrameControls } from './hud/frame/frame-controls';

export class Game {
  private readonly _scene: THREE.Scene;
  private readonly pipeline: RenderPipeline;
  readonly input: Input;
  private readonly touchControls: TouchControls | null;
  private readonly _hud: Hud;
  private readonly _worldSfx: WorldSfx;
  private readonly pauseMenu: PauseMenu;
  private readonly markerManager: MarkerManager;
  private readonly celestialMarkers: CelestialMarkers;
  readonly cameraSystem: CameraSystem;
  // 操作対象艦(0..n 隻のうちどれを操作するか)の切替を持つ。
  private readonly activePlayers: ActiveControllableController;
  get player(): Player | null { return this.activePlayers.current; }
  get controlledBase(): Base | null { return this.activePlayers.controlledBase; }
  get activeControllableEntity(): Controllable | null {
    return this.controlledBase ?? this.player ?? this.dynamicSystem.bases.find((b) => b.alive) ?? null;
  }
  readonly simSpeedManager: SimSpeedManager;

  private readonly planDisplay: PlanDisplay;
  // このフレームの表示座標系・表示時刻窓と、表示側の重力源窓。update で確定させ sync でも読む。
  // HUD(軌道分析パネルの投影タブなど)が current 経由で表示期間を読むため公開する。
  readonly displayWindowManager: DisplayWindowManager;
  readonly viewManager: ViewManager;
  private readonly objectWindows: ObjectWindows;

  readonly activeStage: Stage;
  // ポーズは Game 自身の状態として持つ。SIM_SPEED_LEVELS は離散段で 0 を表現できないうえ、
  // 「時間を止めるか」と「どの倍率まで相互作用を成立させるか」は別の関心事なので、
  // SimSpeedManager へは寄せない。
  private _isPaused = false;
  get isPaused(): boolean { return this._isPaused; }

  private readonly _celestialSystem: CelestialSystem;
  get celestialSystem(): CelestialSystem { return this._celestialSystem; }
  private readonly navball: Navball;

  readonly targeter: Targeter;
  readonly navTarget: NavTarget;
  private readonly frameAnchors: FrameAnchors;
  readonly orbitReference = new OrbitReferenceSelector();
  // このフレームの軌道要素・軌道線の基準。update が確定させ、同じ animate() の sync が読む。
  private orbitRef: OrbitReference | undefined;
  readonly dynamicSystem: DynamicSystem;
  private readonly entityLines: EntityLineManager;
  readonly simulator: Simulator;
  private readonly predictor: Predictor;
  private readonly nanWatchdog: NanWatchdog;
  private readonly docking: Docking;
  private readonly viewBadge: ViewBadge;
  private readonly frameControls: FrameControls;
  // 計測区間の境界を打つ先。集計と保持はこのオブジェクトが持つ。
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
    // このランの元期。スナップショットを読むならその元期をそのまま継ぐ(照合はしない) —
    // 保存されている simTime はその元期からの経過秒なので、別の元期で組むと全天体がずれる。
    // 次に開始日時の指定、最後にステージの宣言。**星系を組む前に決まっていなければならない。**
    const savedJdTdb = initialSave?.ephemerisContext?.epochJdTdb;
    const epoch = savedJdTdb !== undefined ? createJulianDate('TDB', savedJdTdb) : startEpoch ?? stageClass.epoch;
    // 地球の自転初期位相。起動ごとに無作為だが、下位を決定的に保つため乱数はここでだけ引く。
    const earthSpinPhase0 = initialSave?.earthSpinPhase0 ?? Math.random() * 2 * Math.PI;
    const celestialSystem = await stageClass.createCelestialSystem(
      initialSave?.phaseOffsets ?? {}, earthSpinPhase0, epoch, (ratio) => progress.within(ratio),
    );
    await progress.enter('bodies');
    celestialSystem.build(
      gs.scene, gs.pipeline.sunLight, gs.pipeline.exposure, gs.pipeline.sunOcclusion,
      gs.pipeline.planetLight, gs.pipeline.ambient, gs.pipeline.atmosphere,
    );
    await progress.enter('run');
    const game = new Game(gs, stageClass, hud, audioEngine, pauseMenu, sections, celestialSystem, initialSave);
    // シェーダを組む前に、最初に描かれるフレームと同じ表示状態を作る。時間の進まない 1 フレーム
    // として通す — 天体表面の分割段やベルトのリンク数のように、update/sync が決めるまで
    // 隠れている表示物は、通さなければ事前コンパイルから漏れる。
    const style = hud.renderStyle.current;
    game.update(0, graphics);
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

  // このランを1件ぶんのセーブ本体へ畳む。各サブシステム自身の serialize を集める —
  // 何を持っているかを知っているのは持ち主だけなので、dispose と同じくここに書く。
  // どこへ何件残すかはランの外側が決める。
  serialize(): GameSaveData {
    const { phaseOffsets, earthSpinPhase0 } = this._celestialSystem.serialize();
    return {
      version: SAVE_VERSION,
      stageId: this.activeStage.id,
      simTime: this.simTime,
      ephemerisContext: { ...ephemerisContextFor(this._celestialSystem.epoch) },
      phaseOffsets,
      earthSpinPhase0,
      players: this.dynamicSystem.players.map((p) => p.serialize()),
      activePlayerId: this.player ? this.player.id : null,
      enemies: this.dynamicSystem.enemies.map((e) => e.serialize()),
      ammoPickups: this.dynamicSystem.ammoPickups.map((pickup) => pickup.serialize()),
      rcsFuelPickups: this.dynamicSystem.rcsFuelPickups.map((pickup) => pickup.serialize()),
      detachedBoosters: this.dynamicSystem.detachedBoosters.map((booster) => booster.serialize()),
      bases: this.dynamicSystem.bases.map((b) => b.serialize()),
      stage: this.activeStage.serialize(),
      camera: { view: this.viewManager.current, ...this.cameraSystem.serialize() },
      navTarget: this.navTarget.id !== null ? { id: this.navTarget.id, name: this.navTarget.name! } : null,
    };
  }

  // ランの外側が一覧へ描くための要約。自機が居ない周回でも値が欠けないよう、
  // 軌道の項は星系の原点へ寄せる。
  runSummary(): RunSummary {
    const player = this.player;
    const celestial = this._celestialSystem;
    const info = player === null ? null : orbitInfo(
      player,
      autoOrbitReference(player.state.r, celestial.celestialMotions, player.state.t),
      player.state.t, (id: string) => celestial.nameOf(id),
    );
    return {
      simTime: this.simTime,
      phase: this.activeStage.phase,
      centerBodyId: info ? info.centerId : celestial.origin.id,
      centerBodyName: info ? info.centerName : celestial.nameOf(celestial.origin.id),
      altitude: info ? info.alt : 0,
      speed: info ? info.spd : 0,
      hpRatio: player !== null && player.maxHp > 0 ? Math.max(0, player.hp) / player.maxHp : 0,
      maxHp: player ? player.maxHp : 0,
      magazines: player ? player.magsLeft : 0,
      money: this.dynamicSystem.bases.reduce((sum, b) => sum + b.baseState.money, 0),
      playerCount: this.dynamicSystem.players.length,
      enemyAliveCount: this.dynamicSystem.enemies.filter((e) => e.alive).length,
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
    this.pipeline = gs.pipeline;
    this._celestialSystem = celestialSystem;
    this._hud = hud;
    this._worldSfx = new WorldSfx(audioEngine);
    const uiSfx = new UiSfx(audioEngine);
    this.pauseMenu = pauseMenu;

    this.markerManager = new MarkerManager(this._hud.layers.marker, this._hud.svgOverlay);

    this.dynamicSystem = new DynamicSystem(this._scene, this._hud, this._worldSfx, this.markerManager, initialSave);
    this.entityLines = new EntityLineManager(this.dynamicSystem);
    this.displayWindowManager = new DisplayWindowManager(this._hud.mapRoot, celestialSystem);

    // ビューの正本(ViewManager)はカメラより後に組み上がるため、遅延評価で渡す。
    // ViewManager 生成前にカメラの update/sync は呼ばれない。
    // 姿勢は現在値しか持たないため、解決はフォーカス id → 生存エンティティの現在姿勢。
    this.cameraSystem = new CameraSystem(
      this._hud, celestialSystem, () => this.viewManager.current,
      (id, t) => {
        const role = frameRoleOf(id);
        const entity = role === 'activeShip' ? this.activeControllableEntity
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
      activeShipState: (t) => this.activeControllableEntity?.stateAt(t, celestialSystem) ?? null,
      navTargetState: (bodies, t) => this.navTarget.resolveState(this.dynamicSystem, celestialSystem, bodies, t)?.state ?? null,
    });
    this.frameControls = new FrameControls(
      this._hud.mapRoot, this._hud.layers.popup, celestialSystem, this.cameraSystem.mapCamera,
      this.displayWindowManager, this._hud.overlayManager, this.frameAnchors,
    );
    this.targeter = new Targeter(this.markerManager, this.navTarget, this.dynamicSystem);
    this.navball = new Navball(this.cameraSystem.viewOptionsPanel);
    this.navball.onOrbitGuideSettingsChange = (settings) => this._celestialSystem.setOrbitGuideSettings(settings);
    this._celestialSystem.setOrbitGuideSettings(this.navball.orbitGuideSettings);
    // 線が増えすぎたときの警告を UI へ戻す。
    this._celestialSystem.orbitGuide.setOnLineCountChange(
      (count) => this.cameraSystem.viewOptionsPanel.setOrbitGuideLineCount(count),
    );
    this.activePlayers = new ActiveControllableController(
      initialSave?.activePlayerId, this.dynamicSystem, this.cameraSystem, this.navTarget, this._worldSfx, this._hud,
    );
    this._hud.burnManagementPanel.setHandlers({
      onAttach: () => { this.player?.boosters.attach(); },
      onToggleIgnition: () => { this.player?.boosters.toggleIgnition(); },
      onDecouple: () => { this.player?.boosters.decouple(this.dynamicSystem); },
    });
    this.planDisplay = new PlanDisplay(
      this._scene, this.markerManager, celestialSystem, this.displayWindowManager, this.activePlayers,
    );
    const editor = new PlanEditor(
      this._hud,
      uiSfx,
      this.simSpeedManager,
      celestialSystem,
      this._scene,
      this.activePlayers,
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

    this.simulator = new Simulator(this.dynamicSystem, celestialSystem, sections, initialSave?.simTime ?? 0);
    this.predictor = new Predictor(this.dynamicSystem, celestialSystem);

    this.activeStage = new stageClass(
      initialSave?.stage, this._hud, this._worldSfx, uiSfx, this._scene, this.dynamicSystem,
      this.dynamicSystem.effects, this.markerManager, celestialSystem, this.simulator, this.activePlayers,
    );
    this._hud.root.classList.toggle('creative-mode', this.activeStage.id === 'creative');
    // activeStage(authoring/executesPlans を読む)を要るので、その直後に生成する。
    const objectPickables = new ObjectPickables(
      this.activePlayers, this.dynamicSystem, celestialSystem, this.navTarget, this.cameraSystem,
      this.celestialMarkers, this.planDisplay, this.frameAnchors,
    );
    const linePickables = new LinePickables(this.dynamicSystem, this._celestialSystem);
    this.objectWindows = new ObjectWindows(
      this._hud, this.dynamicSystem, celestialSystem, this.navTarget,
      this.cameraSystem, editor, this.simSpeedManager, this.pauseMenu, objectPickables, linePickables,
      this.activePlayers, this.frameControls, this.activeStage, this.targeter,
    );

    this.docking = new Docking(
      this._hud, this._worldSfx, this._scene, this.dynamicSystem.effects, this.markerManager,
      this.dynamicSystem, this.objectWindows, this.cameraSystem,
      (view) => this.viewManager.setView(view),
      this.activePlayers, this.activeStage,
    );
    this.objectWindows.setDocking(this.docking);

    const combatView = new CombatView(
      this.input, this.cameraSystem, this.targeter, this.objectWindows, this.dynamicSystem,
      this.celestialMarkers, this.touchControls,
      this.activePlayers, this.docking.guide, this.planDisplay.path, celestialSystem,
      this.simSpeedManager, this._hud, uiSfx, this.markerManager,
    );
    const mapView = new MapView(
      this.input, this.cameraSystem, this.targeter, editor, this.objectWindows,
      this.dynamicSystem, celestialSystem, objectPickables, linePickables,
      this.celestialMarkers, this.markerManager, this.displayWindowManager, this.frameControls,
      this.frameAnchors, this.activePlayers, this._hud, this.navTarget,
    );
    // 初期ビューは世界が組み上がった後にしか決まらない — 攻略ステージの自機は Stage の初期配置で
    // 置かれるので、戦闘ビューへ入れるかどうかはその後でなければ判定できない。
    this.viewManager = new ViewManager(
      this._hud, this.touchControls, this.displayWindowManager, this.activePlayers,
      { combat: combatView, map: mapView },
      initialSave?.camera?.view,
    );

    this.nanWatchdog = new NanWatchdog(this._hud);
    this.viewBadge = new ViewBadge(
      this._hud.viewBadgeRow, this._hud.layers.notify, this.viewManager, this._hud.overlayManager,
      this._hud.renderStyle, this.dynamicSystem, celestialSystem,
    );

    // ロード復元時の focus は FocusCamera が直接持つだけで frameControls.setFocus() を経由しないため、
    // ここで明示的に同期しないと軌道表示の基準系がフォーカス天体に追随しない。
    this.frameControls.setFocus(this.cameraSystem.mapCamera.focus);
  }

  // ------------------------------------------------------------------ lifecycle

  pause(): void {
    this.simulator.lastSimDt = 0;
    this._worldSfx.setThrust(false);
    // 一時停止へ入る際に、全自機の連続指令を畳む。
    this.dynamicSystem.clearTransientCommands();
    this._isPaused = true;
  }

  resume(): void { this._isPaused = false; }

  // このゲームが scene・Hud・window/document/canvas へ足したものを残らず取り除く。呼んだ後の
  // このインスタンスは使えない。構築の逆順で辿るのは、後から組んだものほど先に組んだものを
  // 参照しているため。マーカープールを最後に空にするのは、各エンティティ・各表示物が自分の
  // dispose の中で自分のキーを外していくのを先に済ませるため。
  dispose(): void {
    this.viewBadge.dispose();
    this.viewManager.dispose();
    this.docking.dispose();
    this.objectWindows.dispose();
    this.activeStage.dispose();
    // Hud はこのゲームより長生きするので、書き換えたクラスと差し込んだ参照を元へ戻す。
    // BGM は周回の外側が決めるものなので触らない。
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
    this.dynamicSystem.dispose();
    this.markerManager.dispose();
  }

  get simTime(): number { return this.simulator.simTime; }

  // ------------------------------------------------------------ update

  update(dtRaw: number, graphics: GraphicsSettingsData): void {
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
    const activeControllable = this.activeControllableEntity;
    const displayWindow = this.displayWindowManager.resolve(this.simulator.simTime, activeControllable);
    const view = this.viewManager.current;
    const canDisplayFuture = !this.displayWindowManager.forceCurrent;
    // このフレームが天体を引く表示時刻を差し込む: 以降の frameTransformAt 呼び出しは
    // すべてこの frameAnchors を通す。
    this.frameAnchors.update(displayWindow.displayTime);
    // 計画表示、予測伸長、選択候補、カメラはこの順序で同じ時刻の状態へ更新する。
    this._celestialSystem.update(displayWindow.displayTime, view, graphics);
    this.sections.enter(SECTION.plan);
    this.planDisplay.update(displayWindow, this.frameAnchors, view);
    this.sections.exit(SECTION.plan);
    // ポーズ中・決着後も無条件に呼ぶ: simTime が止まっている間はサブステップも進まず、
    // 消費も期限切れの張り直しも起きないので、予測は伸び切ったところで止まるだけで害はない。
    this.sections.enter(SECTION.predict);
    this.predictor.update(
      this.simulator.simTime, this.simulator.lastSimDt, this.player, displayWindow.duration,
      canDisplayFuture, this.planDisplay.growableArcs(),
    );
    this.sections.exit(SECTION.predict);
    this.sections.enter(SECTION.camera);
    this.cameraSystem.update(
      activeControllable, displayWindow.displayTime, this.input, dt, this.viewManager.activeView.pickables,
      this.frameAnchors,
    );
    this.sections.exit(SECTION.camera);
    // カメラ更新の後に置く: 候補列の組み直しが読む近傍系抽出・遮蔽判定・可視マーカー更新は
    // cameraSystem.activeCameraPos を使うので、先に組むとこのフレームの sync が1フレーム古い
    // カメラ位置基準の判定を読むことになる。フォーカス解決(候補配列を機体の位置として読むこと)
    // はこの順序に依存しない — resolveFocusTarget が機体・役割トークンを frameAnchors.stateOf
    // で直接解決するため、カメラへ渡る候補列が1フレーム古くても遅延は生じない。
    this.sections.enter(SECTION.mapPick);
    this.viewManager.activeView.update(displayWindow);
    this.sections.exit(SECTION.mapPick);
    this.sections.enter(SECTION.pointer);
    this.handlePointerInput();
    this.sections.exit(SECTION.pointer);

    // 基地操作中もその基地を基準に軌道パネルが解決するのと揃える(orbit-panel.ts も同じ
    // activeControllableEntity を使う) — player だけを見ると、基地操作中は常に undefined になり
    // 軌道パネルの表示と3D軌道線の基準がずれる。
    this.orbitRef = activeControllable
      ? this.orbitReference.resolve(
        activeControllable.state.r, this.celestialSystem.celestialMotions, this.navTarget,
        this.dynamicSystem, this.celestialSystem, activeControllable.state.t,
      )
      : undefined;
    // 表示可否・ターゲット・操作艦・ビューがこのフレームの確定値になった後に判断する。
    this.entityLines.update(
      this.player, this.targeter.aliveTarget,
      view, displayWindow, this.viewManager.activeView.visibilityPolicy, this.orbitRef,
    );
  }

  // 自機の行動 → ステージ → 積分 → エフェクトの順に1フレーム進める
  // (残骸・弾の先端時刻はどの状況でも進め続ける)。
  private advanceSimulation(dt: number): void {
    // 過去表示に要る履歴の長さを、積分がサンプルを積む前に要求しておく。表示窓は前フレームの
    // 確定値でよい — 保持窓が1フレーム遅れても描ける区間は変わらない。
    this.dynamicSystem.requestHistoryDuration(this.displayWindowManager.current.pastDuration);
    // このフレームで使う倍率を最初に一度だけ確定する。燃料消費・操作ゲート・積分が
    // 自動ワープの段階変更を跨いで別の倍率を読むと、同じ区間を表さなくなる。
    this.simSpeedManager.update(this.simulator.simTime);
    const simDt = dt * this.simSpeedManager.simSpeed;
    const canShipAct = this.simSpeedManager.canShipAct;
    const canResolvePhysicalCollisions = this.simSpeedManager.canResolvePhysicalCollisions;
    this.sections.enter(SECTION.player);
    this.nanWatchdog.checkPlayer('frameStart', this.player, this.simulator.simTime, dt, this.simulator.lastSimDt);
    const playerInput = this.controlledBase !== null ? null : this.input;
    this.dynamicSystem.updatePlayers(
      this.player, playerInput, canShipAct, dt, simDt, this.activeStage, this.celestialSystem,
    );
    this.dynamicSystem.updateBases(
      this.controlledBase, this.input, canShipAct, dt, simDt,
    );
    this.nanWatchdog.checkPlayer(
      'player.updatePlayerControls',
      this.player,
      this.simulator.simTime,
      dt,
      this.simulator.lastSimDt,
    );
    this.sections.exit(SECTION.player);

    this.sections.enter(SECTION.stage);
    this.activeStage.update(dt, this.player, this.dynamicSystem, this.simulator.simTime, this.simSpeedManager);
    this.sections.exit(SECTION.stage);
    this.nanWatchdog.checkPlayer('activeStage.update', this.player, this.simulator.simTime, dt, this.simulator.lastSimDt);
    this.sections.enter(SECTION.integrate);
    this.simulator.advance(
      dt, simDt, this.player, this.activeStage,
      canResolvePhysicalCollisions, this.nanWatchdog);
    this.sections.exit(SECTION.integrate);
    this.docking.updateDockedPhysics();
    // 薬莢や破片が先に壊れて接触経由で自機へ伝播することがあるので、ここは全エンティティを見る。
    this.nanWatchdog.checkAll('simulator.advance', this.player, this.dynamicSystem, this.simulator.simTime, dt, simDt);

    this.targeter.updateBoardMarks(dt, this.player, this.dynamicSystem);
    this.activePlayers.reclaimDead();

    this.sections.enter(SECTION.effects);
    this.dynamicSystem.effects.update(dt, this.simulator.simTime);
    this.sections.exit(SECTION.effects);

  }

  // ポインタ入力を現在のビューへ配る。このフレームの cameraSystem.update が終わって
  // 初めて投影がこのフレームの値になるので、update の末尾に置く。ポーズ中、または入力を
  // ゲートするオーバーレイ(セーブブラウザ・基地画面等)が開いている間は配らない(背景の誤操作を防ぐ)。
  private handlePointerInput(): void {
    if (this._isPaused || this._hud.overlayManager.isInputGated()) return;
    this.viewManager.activeView.handlePointer(this.simulator.simTime);
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
    // ヘルプや設定など、背景入力をゲートするモーダルが開いた後は、同じフレームの
    // ワープ/ビュー切り替え/計画編集へキーを漏らさない。
    if (this._hud.overlayManager.isInputGated()) return;
    this.simSpeedManager.handleInput(this.input);
    this.viewManager.handleInput(this.input);
    // ビュー固有のキー(戦闘=計画破棄/自動ワープ、マップ=Δv 編集)は現在のビューが持つ。
    this.viewManager.activeView.handleInput(this.input, dt, this.simulator.simTime);
  }

  // ------------------------------------------------------------------ sync

  sync(graphics: GraphicsSettingsData, style: RenderStyle): void {
    const player = this.player;
    // update() と sync() は同一の animate() 呼び出し内で同期的に実行されるため、
    // update() が確定させた表示窓をそのまま読める。
    const displayWindow = this.displayWindowManager.current;
    this.viewBadge.sync(
      this.activeStage.stageClass.selectLabel, this.cameraSystem.activeFocus,
      this.controlledBase ?? this.player, this.navTarget.name,
    );

    // 表示時刻 = 未来ゴーストのスライダーぶん先取りした simTime。
    const { displayTime, simTime } = displayWindow;
    const celestialBodies = this.celestialSystem.celestialMotions;
    // sync フェーズの frameTransformAt 呼び出しは、天体メッシュと同じ表示時刻で天体を引く。
    this.frameAnchors.update(displayTime);

    // 最初に行う: 後続の sync とマーカー投影がこのフレームのカメラ行列と描画原点を読む。
    this.cameraSystem.sync();
    const fo = this.cameraSystem.getFloatingOrigin();
    // 天体ラベルの間引きは、この後のマーカー同期が近接判定に読むので先に済ませる。
    this.viewManager.activeView.syncLabels();

    // 表示・選択可否はこのフレームの update フェーズで現在のビューが確定させたものを読む
    // (選べる対象と描かれる対象が同じ判定から出るようにする)。
    const visibilityPolicy = this.viewManager.activeView.visibilityPolicy;
    // マーカー描画は操作艦自身も他の船と同列に扱うので、ターゲット選定用(自分自身は除外)とは
    // 別に、除外なしの一覧を使う。
    const combatTargets = this.dynamicSystem.getCombatTargets(null);

    this._celestialSystem.sync(
      fo, displayTime,
      this.cameraSystem, graphics, style, this.navball.gridVisibility, visibilityPolicy,
      this.markerManager,
    );

    this.dynamicSystem.syncPlayers(player, fo, this.cameraSystem, displayTime, style, visibilityPolicy, this.orbitRef);
    this.dynamicSystem.syncDetachedBoosters(fo, this.cameraSystem, displayTime, style, visibilityPolicy);
    this.dynamicSystem.syncBases(
      this.controlledBase, fo, this.cameraSystem, displayTime, style, visibilityPolicy,
    );
    this.dynamicSystem.sync(fo, displayTime, this.cameraSystem.activeViewpoint, graphics.proteinVibration);
    this.dynamicSystem.applyVisibility(visibilityPolicy, player);

    this.dynamicSystem.effects.sync(fo, this.cameraSystem.activeCamera, this.cameraSystem.zoomActive);

    this.targeter.sync(player, this.cameraSystem);
    this.targeter.syncTargetMarkers(
      player, combatTargets, this.dynamicSystem.ammoPickups, this.dynamicSystem.rcsFuelPickups, displayTime, simTime, this.cameraSystem, visibilityPolicy,
      celestialBodies, this.celestialMarkers,
    );
    this.navTarget.sync(this.cameraSystem);
    this.dynamicSystem.syncEquatorNodes(this.cameraSystem);

    // 戦闘中に開いたプロパティウィンドウも最新値を表示し続ける必要があるので、ビューに依らず呼ぶ。
    this.objectWindows.sync(simTime, displayTime);
    this.planDisplay.sync(this.cameraSystem, fo);

    // 計画軌道の折れ線と同じ座標系で描かないと、同一画面上で並べたときに比較にならない。
    this.entityLines.sync(
      displayWindow, fo, this.cameraSystem.activeCamera, this.frameAnchors, this._celestialSystem);
    // ビュー専用のパネル・表示物と軌道線の右クリック候補。軌道線が今フレーム焼いたサンプルを
    // 読むため、celestialSystem.sync/entityLines.sync の後に置く。
    this.viewManager.activeView.syncPanels(displayWindow, fo);

    this.activeStage.sync(player, fo, this.cameraSystem, displayTime, visibilityPolicy);

    this._hud.syncPanels(this.viewManager.current, this);
    this._hud.tick();

    // このフレームのマーカーが出揃った後でなければならないので最後に置く。
    this.markerManager.resolveCollisions(this.viewManager.current);
  }

  // ------------------------------------------------------------------ render

  render(style: RenderStyle): void {
    this.pipeline.render(this._scene, this.cameraSystem.activeCamera, style);
  }

  // ------------------------------------------------------------------ debug

  // 負荷確認ウィンドウが読む値。各数値はそれを持つモジュールが答え、ここは合流させるだけ。
  perfCounts(): PerfCounts {
    return {
      ...this.dynamicSystem.perfCounts(),
      ...this.predictor.perfCounts(),
      ...this.simulator.perfCounts(),
      ...this.planDisplay.perfCounts(),
      ...this.celestialSystem.perfCounts(),
      ...this.viewManager.activeView.perfCounts(),
      displayDurationSec: this.displayWindowManager.current.duration,
      warp: this.simSpeedManager.simSpeed,
    };
  }

  proteinMotionFrameSample(): ProteinMotionFrameSample {
    return this.dynamicSystem.proteinMotionFrameSample();
  }
}
