// ゲーム全体のオーケストレーション: 各システムの生成・保持と、フレームごとの呼び出し順序の決定。
import * as THREE from 'three/webgpu';
import { FloatingOrigin } from './floating-origin';
import * as C from './const';
import { v3 } from '../physics/vec3';
import type { PerfCounts, PerfMeter } from '../perf-meter';
import { Player } from './player/player';
import { Enemy } from './game-entity/enemy';
import { CameraSystem } from './camera/camera-system';
import { focusPoint } from './camera/focus-target';
import { focusTargetId } from './camera/focus-target';
import { Stage } from './stages/stage';
import { CreativeStage } from './stages/creative-stage';
import { LaunchSelection } from './game-mode';
import { MarkerManager } from './marker/marker-manager';
import { GroupedMarkers, GroupedMarkerItem } from './marker/grouped-markers';
import { LeadMarkers } from './marker/lead-markers';
import { EquatorNodeMarkers, EqNodeSource } from './marker/equator-node-markers';
import { EffectsSystem } from './vfx/effects-system';
import { ephemerisConfigFor, initStage } from './stages/stage-dictionary';
import { UnlockManager } from './unlock-manager';
import { Targeter } from './targeter';
import { PlanEditor } from './plan/plan-editor';
import { DisplayTimeManager, type DisplayWindow } from './display-time-manager';
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
import { Ephemeris } from '../physics/ephemeris';
import type { AbsoluteEphemeris } from '../physics/absolute-ephemeris';
import { SIM_EPOCH_ET, SIM_EPOCH_JD_TDB } from './sim-epoch';
import { ViewManager } from './view-manager';
import { NanWatchdog } from './nan-watchdog';
import { DebugTrajectoryLine } from './debug-trajectory-line';
import { PredictedTrajectoryLine } from './predicted-trajectory-line';
import { NavTarget } from './nav-target';
import { MapPicker } from './map-picker';
import { Navball } from './navball/navball';
import { GameSaveData } from './save-data';
import { Ammo } from './game-entity/ammo';
import { SnapshotService } from './save/snapshot-service';
import type { SaveBrowser } from './hud/save-browser';
import { KEY_MAPPING as K } from './input/key-mapping';
import { Docking } from './docking';
import { ViewBadge } from './hud/view-badge';
import { Base } from './game-entity/base';
import { strongestAttractor } from '../physics/attractor';
import type { Attractor } from '../physics/attractor';
import { mergeAttractors, planAttractorProvider, planSourceRevision } from './simulation/attractors';
import { FrameControls } from './frame-controls';
import { systemMembersAt } from './celestial/body-visibility';
import { MapVisibilityPolicy } from './celestial/map-visibility';

export class Game {
  private readonly _scene: THREE.Scene;
  private readonly renderer: GameScene['renderer'];
  private floatingOrigin: FloatingOrigin;
  private readonly input: Input;
  touchControls: TouchControls | null = null;
  private readonly _hud: Hud;
  private readonly _sfx: Sfx;
  private readonly settingsPanel: SettingsPanel;
  private readonly markerManager: MarkerManager;
  private readonly _ephemeris: Ephemeris;
  get ephemeris(): Ephemeris { return this._ephemeris; }
  readonly cameraSystem: CameraSystem;
  // Campaign では常に1隻、Creative では未配置/全滅時に null になれる操作対象。
  player: Player | null;
  readonly simSpeedManager: SimSpeedManager;

  private readonly editor: PlanEditor;
  private readonly displayTimeManager: DisplayTimeManager;
  private readonly guide: PlanGuide;
  readonly viewManager: ViewManager;
  private readonly mapPicker: MapPicker;

  readonly activeStage: Stage;
  private readonly launchMode: LaunchSelection['mode'];
  private _isPaused = false;
  get isPaused(): boolean { return this._isPaused; }

  private readonly _environment: EnvironmentScene;
  get environment(): EnvironmentScene { return this._environment; }
  private readonly navball: Navball;

  private readonly unlockManager: UnlockManager;
  private readonly snapshotService: SnapshotService;
  // SaveBrowser は自分自身(Game)を必要とするため Game より後に作られる。ViewManager が
  // Docking を後から受け取るのと同じ遅延注入。
  private saveBrowser: SaveBrowser | null = null;
  // PerfMeter は計測点である rAF ループ側の持ち物なので、同じく後から受け取る。
  private perfMeter: PerfMeter | null = null;

  // 単独のオブジェクトでは決められないマーカー群。敵マーカーは「画面上で近接するものを
  // まとめる」ために集合全体を、LEAD マーカーは自機と敵の両方を必要とする。EqAN/EqDN は
  // 操作艦・航法ターゲット・戦闘ターゲットという複数の役割にまたがる source 列を Game が組む。
  private readonly enemyMarkers: GroupedMarkers;
  private readonly leadMarkers: LeadMarkers;
  readonly equatorNodeMarkers: EquatorNodeMarkers;
  private readonly effects: EffectsSystem;
  // 1フレーム分の表示時刻一式。update で確定した結果を、状態が変わっていない限り sync
  // でも再利用する。プレイヤー未配置経路では simulator.advance 後に simTime が変わるため、
  // sync 側で自然に再計算される。
  private _window: DisplayWindow = {
    simTime: 0, referencePeriod: NaN, duration: C.APERIODIC_ARC_DURATION, displayTime: 0,
  };
  private windowSimTime = NaN;
  private windowDisplayRevision = -1;
  private windowPlayer: Player | null = null;
  private windowPlayerState: Player['state'] | null = null;
  // Ephemeris の時刻窓と EntityManager の安定配列が同じ間は、updateMapPresentation と sync
  // の合流配列を共有する。返す配列は readonly として扱い、呼び出し側は変更しない。
  private mergedAttractorsSimTime = NaN;
  private mergedAttractorsBodies: readonly Attractor[] | null = null;
  private mergedAttractorsDynamic: readonly Attractor[] | null = null;
  private mergedAttractorsCache: readonly Attractor[] = [];
  private readonly equatorSourceScratch = new Map<string, EqNodeSource>();
  private readonly equatorSourcesCache: EqNodeSource[] = [];
  readonly targeter: Targeter;
  readonly navTarget: NavTarget;
  readonly entities: EntityManager;
  readonly simulator: Simulator;
  private readonly predictor: Predictor;
  private readonly nanWatchdog: NanWatchdog;
  private readonly debugTrajectoryLine: DebugTrajectoryLine;
  private readonly predictedTrajectoryLine: PredictedTrajectoryLine;
  private readonly docking: Docking;
  private readonly viewBadge: ViewBadge;
  readonly frameControls: FrameControls;

  // 各サブシステムを、互いの依存関係が満たせる順に生成して配線する。
  constructor(
    gs: GameScene,
    launch: LaunchSelection,
    hud: Hud,
    sfx: Sfx,
    settingsPanel: SettingsPanel,
    unlockManager: UnlockManager,
    snapshotService: SnapshotService,
    absoluteEphemeris?: AbsoluteEphemeris,
  ) {
    this.launchMode = launch.mode;
    this._scene = gs.scene;
    this.renderer = gs.renderer;
    this._hud = hud;
    this._sfx = sfx;
    this.settingsPanel = settingsPanel;
    this.unlockManager = unlockManager;
    this.snapshotService = snapshotService;

    const ephemerisConfig = ephemerisConfigFor(launch);
    this._ephemeris = ephemerisConfig === undefined
      ? new Ephemeris(undefined, undefined, SIM_EPOCH_ET, {}, absoluteEphemeris, SIM_EPOCH_JD_TDB)
      : new Ephemeris(ephemerisConfig.registry, ephemerisConfig.originId, ephemerisConfig.epochOffsetSec);

    this.markerManager = new MarkerManager(this._hud.layers.marker, this._hud.svgOverlay);
    this.enemyMarkers = new GroupedMarkers(this.markerManager, C.MARKER_CLUSTER_PX);
    this.leadMarkers = new LeadMarkers(this.markerManager);
    this.equatorNodeMarkers = new EquatorNodeMarkers(this.markerManager, this.ephemeris);

    this.entities = new EntityManager();
    this.effects = new EffectsSystem(this._scene, this.entities, this._sfx);
    // 依存グラフを組むための一時艦。Creative では構築後に必ず破棄し、実ゲーム上は0隻で開始する。
    const bootstrapPlayer = new Player(this._hud, this._sfx, this._scene, this.effects, this.markerManager);
    this.player = bootstrapPlayer;
    if (launch.mode === 'stage') this.entities.addPlayer(bootstrapPlayer);

    // Player より後に生成する: 追従カメラは自機を参照として直接持つ(遅延解決しない)。
    this.cameraSystem = new CameraSystem(
      this._hud,
      this._sfx,
      this.markerManager,
      this.ephemeris,
      bootstrapPlayer,
      launch.mode === 'creative',
    );
    this.simSpeedManager = new SimSpeedManager(this._hud, this._sfx);

    this.targeter = new Targeter(this._hud, this._sfx, this.markerManager, this._scene, this.settingsPanel);
    this.navTarget = new NavTarget(this._hud, this.markerManager);
    this.navball = new Navball(this._hud.layers.panel);
    this._environment = new EnvironmentScene(this._scene, this.ephemeris);
    this.displayTimeManager = new DisplayTimeManager(this._hud.layers.panel);
    this.editor = new PlanEditor(
      this._hud,
      this._sfx,
      this.simSpeedManager,
      this.ephemeris,
      this._scene,
      this.markerManager,
      bootstrapPlayer,
      this.displayTimeManager,
    );
    this.editor.onFocusNode = (state) => {
      this.frameControls.setFocus(
        focusPoint(this.ephemeris, this.ephemeris.inertialFrame, state.r, state.t));
    };
    this.mapPicker = new MapPicker(
      this, this._hud, this.entities, this.ephemeris, this.navTarget,
      this.cameraSystem, this.editor, this.simSpeedManager,
    );
    this.guide = new PlanGuide(this._hud, this._sfx, this.markerManager);
    // クリエイティブモードはマップから始まる。
    this.viewManager = new ViewManager(
      this._hud, this.editor, this.cameraSystem, this.displayTimeManager, this.mapPicker,
      launch.mode === 'creative' ? 'map' : 'combat',
    );

    this.input = new Input(gs.renderer.domElement);
    this.input.onFirstGesture = () => this._sfx.unlock();
    if (TouchControls.isTouchDevice()) this.touchControls = new TouchControls(this.input);
    this.viewManager.setTouchControls(this.touchControls);

    this.simulator = new Simulator(this.entities, this.ephemeris);
    this.predictor = new Predictor(this.entities, this.ephemeris);

    if (launch.mode === 'stage') {
      this.activeStage = initStage(
        launch.stage,
        bootstrapPlayer,
        this.entities,
        this._hud,
        this._sfx,
        this._scene,
        this.unlockManager,
        this.effects,
        this.markerManager,
        this.ephemeris,
        this.simulator,
      );
    } else {
      const creativeStage = new CreativeStage();
      creativeStage.setup(
        this._hud, this._sfx, this._scene, this.entities, this.unlockManager,
        this.effects, this.markerManager, this.ephemeris, this.simulator,
      );
      creativeStage.init();
      this.activeStage = creativeStage;
      creativeStage.onShipPlaced = (ship) => {
        if (this.player === null) this.setActivePlayer(ship);
      };
      // Creative は0隻で開始する。破棄するbootstrap艦をcamera/editorに保持させない。
      this.editor.setActivePlayer(null);
      this.cameraSystem.setActivePlayer(null);
      bootstrapPlayer.dispose();
      this.player = null;
    }

    this.nanWatchdog = new NanWatchdog(this._hud);
    this.debugTrajectoryLine = new DebugTrajectoryLine(this._scene);
    this.predictedTrajectoryLine = new PredictedTrajectoryLine(this._scene);
    this.docking = new Docking(
      this, this._hud, this._sfx, this._scene, this.effects, this.markerManager,
      this.entities, this.mapPicker, this.cameraSystem, this.viewManager,
    );
    this.mapPicker.setDocking(this.docking);
    this.viewBadge = new ViewBadge(this._hud.layers.notify, this._hud.layers.popup, this.viewManager);
    this.frameControls = new FrameControls(
      this._hud.layers.panel, this._hud.layers.popup, this.ephemeris, this.cameraSystem.overviewCamera, this.editor.planDisplay,
    );

    // 暫定値: cameraSystem はまだ update() を経ていないため activeCameraPos が定まらない。
    // 最初の Game.sync() が render より前に必ず上書きするので、これは描画に使われない。
    this.floatingOrigin = this.player
      ? new FloatingOrigin(this.player.state.r, this.player.state.v)
      : new FloatingOrigin(v3(), v3());
  }

  // ------------------------------------------------------------------ lifecycle

  pause(): void {
    this.simulator.lastSimDt = 0;
    this._sfx.setThrust(false);
    this.player?.pause();
    this._isPaused = true;
  }

  resume(): void { this._isPaused = false; }

  // アクティブ艦(操作対象・追従カメラ・計画編集の対象)を差し替える。
  setActivePlayer(ship: Player): void {
    if (this.player === ship) return;
    this.player?.clearTransientCommands();
    this.player = ship;
    this.cameraSystem.setActivePlayer(ship);
    this.editor.setActivePlayer(ship);
    this.targeter.clearTargets();
  }

  // ship が null なら未配置状態(Creative の全滅/未収容、または操作対象の手動解除)へ戻す。
  setActivePlayerOrNull(ship: Player | null): void {
    if (ship) this.setActivePlayer(ship);
    else {
      this.player?.clearTransientCommands();
      this.player = null;
      this.cameraSystem.setActivePlayer(null);
      this.editor.setActivePlayer(null);
      this.viewManager.setView('map');
    }
  }

  get isCreative(): boolean { return this.launchMode === 'creative'; }

  // MapPicker の削除口。参照を片付けてから EntityManager へ渡すため、削除後に stale id が残らない。
  removeCreativePlayer(ship: Player): void {
    const wasActive = this.player === ship;
    this.navTarget.clearIfTargeting(ship.id);
    this.mapPicker.close();
    this.cameraSystem.overviewCamera.clearFocusIf(ship.id);
    if (wasActive) {
      ship.clearTransientCommands();
      this.player = null;
      this.editor.setActivePlayer(null);
    }
    this.entities.removePlayer(ship);
    if (wasActive) {
      const next = this.entities.players.find((p) => p.alive) ?? null;
      if (next) this.setActivePlayer(next);
      else this.viewManager.setView('map');
    }
  }


  // このフレーム時点の表示時刻一式を組む。currentOrbitPeriod() は登録天体全体を組んで
  // strongestAttractor を回す重い計算なので、resolveWindowIfStale() が同じ状態へ重ねて呼ばない。
  private resolveWindow(): DisplayWindow {
    return this.displayTimeManager.window(this.simulator.simTime, this.currentOrbitPeriod());
  }

  private resolveWindowIfStale(): DisplayWindow {
    const player = this.player;
    const playerState = player?.state ?? null;
    if (this.windowSimTime !== this.simulator.simTime
      || this.windowDisplayRevision !== this.displayTimeManager.revision
      || this.windowPlayer !== player
      || this.windowPlayerState !== playerState) {
      this._window = this.resolveWindow();
      this.windowSimTime = this.simulator.simTime;
      this.windowDisplayRevision = this.displayTimeManager.revision;
      this.windowPlayer = player;
      this.windowPlayerState = playerState;
    }
    return this._window;
  }

  private mergedAttractorsAt(simTime: number): readonly Attractor[] {
    const bodies = this.ephemeris.attractorsAt(simTime);
    const dynamic = this.entities.attractors();
    if (this.mergedAttractorsSimTime === simTime
      && this.mergedAttractorsBodies === bodies
      && this.mergedAttractorsDynamic === dynamic) {
      return this.mergedAttractorsCache;
    }
    this.mergedAttractorsSimTime = simTime;
    this.mergedAttractorsBodies = bodies;
    this.mergedAttractorsDynamic = dynamic;
    this.mergedAttractorsCache = mergeAttractors(bodies, dynamic);
    return this.mergedAttractorsCache;
  }

  // 自機の現在軌道の周期 [s]。自機がいない、または有限な周期が求まらない間は NaN —
  // DisplayTimeManager.durationSec 側のフォールバックに委ねる。
  private currentOrbitPeriod(): number {
    if (!this.player) return NaN;
    const center = strongestAttractor(this.player.state.r, this.ephemeris.attractorsAt(this.simulator.simTime));
    return this.player.orbitalElementsAround(center)?.period ?? NaN;
  }

  // 自機の予測軌道が表示期間のどこまで届いているかの割合(0..1)。スライダーがまだ積分の
  // 届いていない未来を指しうることをスクラバー上で示すのに使う。自機がいない、または
  // 予測が無い/表示期間が無い間は、警告すべき相手がいないので 1(全域到達済み扱い)を返す。
  private predictionCoverageRatio(): number {
    const end = this.player?.predictedTrajectory?.state.t;
    if (end === undefined || this._window.duration <= 0) return 1;
    const ratio = (end - this._window.simTime) / this._window.duration;
    return Math.max(0, Math.min(1, ratio));
  }

  get simTime(): number { return this.simulator.simTime; }

  // ------------------------------------------------------------ save/load

  restore(data: GameSaveData): void {
    this.entities.clearAll();
    this.player = null;
    this.editor.setActivePlayer(null);
    this.cameraSystem.setActivePlayer(null);
    this.targeter.clearTargets();
    this.navTarget.clear();
    // entities.clearAll() が旧 Base を dispose するので、それを掴んだままの DockView を
    // 開いておけない — 対象基地消失時と同じ経路(ViewManager.leaveDock)で閉じる。
    this.viewManager.leaveDock();
    this.docking.clearSelection();
    this.simSpeedManager.reset();

    // 時刻の復元
    this.simulator.simTime = data.simTime;
    this._ephemeris.setPhaseOffsets(data.phaseOffsets);
    if (data.earthSpinPhase0 !== undefined) this._environment.setEarthSpinPhase0(data.earthSpinPhase0);

    // Playerの復元(複数隻ぶん)
    let activePlayer: Player | null = null;
    for (const pdata of data.players) {
      const p = Player.restore(pdata, data.simTime, this._hud, this._sfx, this._scene, this.effects, this.markerManager);
      this.entities.addPlayer(p);
      if (pdata.id === data.activePlayerId) activePlayer = p;
    }
    if (!activePlayer) activePlayer = this.entities.players[0] ?? null;
    if (activePlayer) this.setActivePlayer(activePlayer);

    // Enemyの復元
    for (const edata of data.enemies) {
      const e = Enemy.restore(edata, data.simTime, this._hud, this._sfx, this.effects, this._scene);
      this.entities.addEnemy(e);
    }

    // Ammoの復元
    for (const adata of data.ammos) {
      const a = Ammo.restore(adata, data.simTime, this._scene);
      this.entities.addAmmo(a);
    }

    // Baseの復元(所持金・在庫・格納艦を含む)
    for (const bdata of data.bases ?? []) {
      const b = Base.restore(bdata, data.simTime, this._scene, this._hud, this._sfx, this.effects, this.markerManager);
      this.entities.addBase(b);
    }

    // ステージ状態(スコア・決着状態・固有の内訳)の復元。SnapshotService が
    // セーブ時と同じ stageId であることを既に検証済み。
    this.activeStage.restore(data.stage);

    // カメラ視点の復元。旧スナップショットには無いので、無ければ既定視点のまま
    // restoreView を呼び、未来ゴーストスライダー等の表示系フラグだけ現在のビューへ揃え直す。
    this.viewManager.restoreView(data.camera?.view ?? this.viewManager.serializeView());
    if (data.camera) this.cameraSystem.restore(data.camera);

    // ロード直後の状態同期と安定化
    this.entities.sync(this.floatingOrigin, data.simTime);
  }

  // スナップショット一覧ウィンドウを登録する。構築直後に一度だけ呼ぶ。
  setSaveBrowser(browser: SaveBrowser): void {
    this.saveBrowser = browser;
  }

  // 負荷確認ウィンドウを登録する。構築直後に一度だけ呼ぶ。
  setPerfMeter(meter: PerfMeter): void {
    this.perfMeter = meter;
  }

  // ------------------------------------------------------------ update

  update(dtRaw: number): void {
    this.input.update();
    const dt = Math.min(dtRaw, 0.1);
    this.handleInput();

    // handleInput より後に置く: ポーズ中も Esc・ヘルプなどは効かせる。
    if (this._isPaused) {
      this.resolveWindowIfStale();
      this.updateMapPresentation(dt, () => {
        if (!this.editor.editMode) return;
        // ESCメニュー中はカメラ操作だけを通し、背景のノード配置・コンテキストメニューは
        // 誤操作防止のため止める。updateMapPresentation 自体は先に呼ばれるので視点は動く。
        if (this._hud.modalController.isOpen) return;
        this.mapPicker.handleRightClick(this.input, this.simulator.simTime);
        this.mapPicker.handleLeftClick(this.input);
        this.mapPicker.handleDoubleClick(this.input);
        this.editor.handleMapPointer(this.input);
        this.mapPicker.handleEmptySpaceRightClick(this.input, this.simulator.simTime);
        this.editor.updateEditing(dt, this.input);
      });
      return;
    }

    // Creative の未配置状態でも、残骸・弾など全エンティティの epoch は進め続ける。
    if (this.player === null) {
      this.resolveWindowIfStale();
      this.simSpeedManager.update(this.simulator.simTime);
      this.applyWarpCommandPolicy();
      const simDt = dt * this.simSpeedManager.simSpeed;
      this.simulator.advance(
        dt, simDt, null, this.activeStage,
        false, true, this.nanWatchdog,
      );
      this.predictor.update(
        this.simulator.simTime,
        null,
        this._window.duration,
        this.cameraSystem.overviewMode ? 'map' : 'combat',
      );
      this.activeStage.update(dt, null, this.entities, this.simulator.simTime, this.simSpeedManager);
      this.effects.update(dt, this.simulator.simTime);
      this.updateMapPresentation(dt);
      if (this.editor.editMode) {
        this.mapPicker.handleRightClick(this.input, this.simulator.simTime);
        this.mapPicker.handleLeftClick(this.input);
        this.mapPicker.handleDoubleClick(this.input);
        this.editor.handleMapPointer(this.input);
        this.mapPicker.handleEmptySpaceRightClick(this.input, this.simulator.simTime);
        this.editor.updateEditing(dt, this.input);
      }
      return;
    }
    const player = this.player;

    // behave が呼ばれなくなるので、決着時点の thrust が凍結され続けないよう明示的に消す。
    if (!this.activeStage.isPlaying) {
      this.resolveWindowIfStale();
      player.thrust = null;
      player.torque = v3();
      const simDt = dt * Math.min(this.simSpeedManager.simSpeed, C.MAX_PHYS_SIM_SPEED);
      this.simulator.advance(dt, simDt, player, this.activeStage, false, false, this.nanWatchdog);
      this.nanWatchdog.checkAll('advance(決着後)', player, this.entities, this.simulator.simTime, dt, simDt);
      this.effects.update(dt, this.simulator.simTime);
      // 決着後もカメラ更新は飛ばせない: 飛ばすと視点だけが絶対 ECI に取り残され、
      // 軌道速度で遠ざかる原点(自機)から残骸が即座にフレームアウトする。
      this.updateMapPresentation(dt);
      return;
    }

    this.nanWatchdog.checkPlayer('frameStart', player, this.simulator.simTime, dt, this.simulator.lastSimDt);

    player.behave({
      dt,
      input: this.input,
      simSpeed: this.simSpeedManager,
      mapMode: this.editor.editMode,
      dvEditActive: this.editor.editMode && this.editor.selectedNodeIdx !== null,
      scoreCounter: this.activeStage.scoreCounter,
      simTime: this.simulator.simTime,
      zoomActive: this.cameraSystem.zoomActive,
      entities: this.entities,
      ephemeris: this.ephemeris,
    });

    // 非操作艦にも、表示フレーム基準のベルト・HP回復だけを一度ずつ進める。
    // 熱・電力・ラジエータは Simulator が全艦をsubstepごとに stepEnvironment する。
    for (const ship of this.entities.players) if (ship !== player) ship.updatePassive(dt);
    this.nanWatchdog.checkPlayer('player.behave', player, this.simulator.simTime, dt, this.simulator.lastSimDt);

    this.activeStage.update(dt, player, this.entities, this.simulator.simTime, this.simSpeedManager);

    this.nanWatchdog.checkPlayer('activeStage.update', player, this.simulator.simTime, dt, this.simulator.lastSimDt);

    this.simSpeedManager.update(this.simulator.simTime);
    this.applyWarpCommandPolicy();
    const simDt = dt * this.simSpeedManager.simSpeed;
    this.simulator.advance(dt, simDt, player, this.activeStage,
      this.simSpeedManager.canResolvePhysicalCollisions, // resolveCollision
      true, // doSubstep
      this.nanWatchdog,
    );
    // simulator.advance 直後、predictor.update より前 — このフレームの表示時刻一式を
    // 積分後の状態で確定させ、以降の消費者(predictor/updateMapPresentation)へ共有する。
    this.resolveWindowIfStale();

    // 薬莢や破片が先に壊れて接触経由で自機へ伝播することがあるので、ここは全エンティティを見る。
    this.nanWatchdog.checkAll('simulator.advance', player, this.entities, this.simulator.simTime, dt, simDt);

    this.targeter.updateBoardMarks(dt, player, this.entities);

    if (this.activeStage instanceof CreativeStage) {
      // Creative の撃沈艦は一覧からも物理からも取り除く。これにより上限8隻を永久に消費しない。
      for (const lost of [...this.entities.players]) {
        if (lost.alive) continue;
        if (this.player === lost) this.player = null;
        this.removeCreativePlayer(lost);
      }
      if (!this.player) {
        const next = this.entities.players.find((p) => p.alive) ?? null;
        if (next) this.setActivePlayer(next);
        else {
          this.editor.setActivePlayer(null);
          this.viewManager.setView('map');
        }
      }
    }

    // ドックビューが開いている間は収容判定を止める(発進直後の再収容ループを防ぐ)。
    if (this.viewManager.current !== 'dock' && this.entities.bases.length > 0) {
      this.docking.checkProximity();
    }


    // Simulator内のsubstep cleanup後に呼ぶ: 死んだ個体を予測せず、積分後の実状態と突き合わせるため。
    this.predictor.update(
      this.simulator.simTime,
      this.player,
      this._window.duration,
      this.cameraSystem.overviewMode ? 'map' : 'combat',
    );

    this.effects.update(dt, this.simulator.simTime);

    // trackAnchor より前に置く: 最後のノードが落ちたフレームからアンカーを自機へ追従させる。
    const activePlayer = this.player;
    if (activePlayer) {
      this.guide.update(
        this.editor.plan, activePlayer, this.simulator.simTime, this.editor.editMode,
        this.ephemeris.attractorsAt(this.simulator.simTime),
      );
      this.editor.plan.trackAnchor(activePlayer.state);
    }
    this.updateMapPresentation(dt);

    if (this.editor.editMode) {
      this.mapPicker.handleRightClick(this.input, this.simulator.simTime);
      this.mapPicker.handleLeftClick(this.input);
      this.mapPicker.handleDoubleClick(this.input);
      this.editor.handleMapPointer(this.input);
      this.mapPicker.handleEmptySpaceRightClick(this.input, this.simulator.simTime);
      this.editor.updateEditing(dt, this.input);
    } else if (this.player) {
      this.navTarget.updateCombatBasePicking(this.entities, this.input, this.cameraSystem.activeCameraProjection);
      const targets = this.entities.getCombatTargets(this.player);
      this.targeter.updateCombatTargeting(
        this.player, targets, this.input, this.cameraSystem.activeCameraProjection,
      );
    }
  }

  // 計画表示、選択候補、カメラはこの順序で同じ時刻の状態へ更新する。
  private updateMapPresentation(dt: number, afterRefresh?: () => void): void {
    const displayTime = this._window.displayTime;
    this._environment.update(displayTime, this.cameraSystem.overviewMode);
    // revision は前フレームの計画終端を基準に畳み込む — 今フレームの終端は editor.update が
    // これから決めるので、provider を組む時点ではまだ確定していない。
    const excludedIds = this.player ? [this.player.id] : [];
    const planProvider = planAttractorProvider(
      this.ephemeris,
      this.entities,
      excludedIds,
      planSourceRevision(
        this.ephemeris, this.entities, excludedIds,
        this.editor.plan.revision, this.editor.lastPlanEnd, this.simulator.simTime,
      ),
    );
    this.editor.update(this.simulator.simTime, displayTime, planProvider);
    this.equatorNodeMarkers.update(
      this.equatorNodeSources(), this.editor.planDisplay.planFrame, displayTime,
    );
    // MapPicker/FocusMarkers は全天体・ラグランジュ点・全エンティティの候補を組む。
    // 戦闘ビューではクリック対象を別経路で処理するため、マップを表示している時だけ更新する。
    if (this.cameraSystem.overviewMode) {
      this.mapPicker.refresh(this.simulator.simTime, displayTime);
    }
    afterRefresh?.();
    // 表示側の合流窓(重力を持つ生存中の GameEntity も含める)。sync 側の attractors と
    // 同じ合流だが、update フェーズは simTime 基準でこの1箇所からしか要らないので都度求める。
    const attractors = this.mergedAttractorsAt(this.simulator.simTime);
    this.cameraSystem.update(
      this.player, this.simulator.simTime, this.input, dt, this.mapPicker.pickables, attractors,
    );
  }

  // EqAN/EqDN を出す対象: 操作艦(計画があれば最終区間の起点、無ければ実状態)・航法ターゲット
  // (entities 上の実体として引けるものだけ — 天体・ラグランジュ点はそれ自体が軌道要素を持つ
  // 「物体」ではないので対象外)・戦闘ターゲット・生存中の全基地(基地は常設の静止構造物であり、
  // 接近・ドッキングは軌道面合わせそのものなので選択の有無に関わらず常に出す)。
  // 同じ実体が複数の役割を兼ねうるので id で重複を除く。
  private equatorNodeSources(): EqNodeSource[] {
    this.equatorSourceScratch.clear();
    if (this.player) {
      const final = this.editor.planDisplay.path.finalSegment();
      this.equatorSourceScratch.set(this.player.id, {
        id: this.player.id, name: this.player.displayName,
        state: final?.state0 ?? this.player.state,
        samples: final?.samples,
      });
    }
    if (this.navTarget.id) {
      const navPlayer = this.entities.findPlayer(this.navTarget.id);
      const navEnemy = this.entities.findEnemy(this.navTarget.id);
      const navBase = this.entities.findBase(this.navTarget.id);
      const navSource: EqNodeSource | null =
        navPlayer ? { id: navPlayer.id, name: navPlayer.displayName, state: navPlayer.state } :
        navEnemy?.alive ? { id: navEnemy.id, name: navEnemy.name, state: navEnemy.state } :
        navBase ? { id: navBase.id, name: navBase.name, state: navBase.state } : null;
      if (navSource) this.equatorSourceScratch.set(navSource.id, navSource);
    }
    const combatTarget = this.targeter.aliveTarget;
    if (combatTarget) {
      this.equatorSourceScratch.set(combatTarget.id, { id: combatTarget.id, name: combatTarget.name, state: combatTarget.state });
    }
    for (const base of this.entities.bases) {
      if (base.alive) this.equatorSourceScratch.set(base.id, { id: base.id, name: base.name, state: base.state });
    }
    this.equatorSourcesCache.length = 0;
    this.equatorSourcesCache.push(...this.equatorSourceScratch.values());
    return this.equatorSourcesCache;
  }

  // 並進・射撃・衝突と同じく、RCS command torqueは物理相互作用域だけで有効。
  // 全艦を明示的にzeroへ戻すことで、active切替前やauto-warp開始前のstale指令も残さない。
  private applyWarpCommandPolicy(): void {
    if (this.simSpeedManager.simSpeed <= C.MAX_PHYS_SIM_SPEED) return;
    for (const ship of this.entities.players) ship.suppressAttitudeCommandForWarp();
    this._sfx.setRcs(false);
  }

  openSettingsMenu(): void {
    this.settingsPanel.toggle(true);
  }

  // --------------------------------------------------------------- input

  // 入力エッジを担当モジュールへ先着順で配る。決めるのは優先順位 = 呼ぶ順序だけで、
  // どのキー/クリックが何をするかは各モジュールが持つ。ここで配るのは、決着後・ポーズ中も
  // 効くべき操作(設定・ヘルプ・再出撃・ワープ・マップ開閉・計画破棄)。
  private handleInput(): void {
    // 上から下へ優先順位順に呼ぶ。
    this.docking.handleInput(this.input);
    // スナップショット一覧を開いている間は、その閉じるキーとして [Esc] を先に取る
    // (設定メニューが上に重なるのを防ぐ)。
    if (this.saveBrowser?.visible && this.input.takeKey(K.pauseMenu)) this.saveBrowser.close();
    this.settingsPanel.handleInput(this.input);
    this._hud.handleInput(this.input);
    this.activeStage.handleInput(this.input);
    this.simSpeedManager.handleInput(
      this.input,
      this.activeStage.isPlaying,
      this.editor.editMode,
      this.editor.plan.firstNode(),
      this.simulator.simTime,
    );
    // 戦闘ビューはアクティブ艦を前提とする。艦がまだ配置されていない/破壊されている間は無効。
    const canToggleView = this.player?.alive ?? false;
    this.viewManager.handleInput(this.input, this.activeStage.isPlaying, canToggleView);
    this.editor.handleInput(this.input);

    if (this.input.takeKey(K.clipSnapshot)) {
      // 決着後の phase(won/lost/timeup)は復元する経路を持たない — restore は phase を
      // そのまま代入するだけで結果画面を出し直さず、Game.update は isPlaying でない限り
      // 早期returnし続けるため、決着後のスナップショットをロードすると操作不能になる。
      if (!this.activeStage.isPlaying) {
        this._hud.hint('決着後はスナップショットを残せません');
      } else {
        const snap = this.snapshotService.capture(this, 'manual', null, true);
        this._hud.hint(snap ? `クリップしました: ${snap.name}` : 'クリップに失敗しました');
      }
    }
    if (this.input.takeKey(K.openSnapshots)) {
      if (this.saveBrowser?.visible) {
        this.saveBrowser.close();
      } else {
        // ポーズは入れ子にならない真偽値なので、同じ帯のシステム窓を重ねない。
        this.settingsPanel.toggle(false);
        this.saveBrowser?.open();
      }
    }
    if (this.input.takeKey(K.togglePerfWindow)) this.perfMeter?.toggle();
  }

  // ------------------------------------------------------------------ sync

  sync(): void {
    // 積分が終わった状態でこのフレームの表示時刻一式を確定させ、sync 全体で共有する。
    this.resolveWindowIfStale();
    this.viewBadge.sync(this.activeStage.selectLabel, this.activeStage.isPlaying && (this.player?.alive ?? false));
    const player = this.player;
    // 原点(位置)はアクティブカメラの ECI 位置 — cameraSystem.update() は update フェーズの
    // 4経路すべてから毎フレーム呼ばれるので、この sync の時点で activeCameraPos は確定済み。
    // 速度基準は自機のまま(弾の相対速度描画・再突入エフェクトが前提とする値で、原点とは別concern)。
    this.floatingOrigin = new FloatingOrigin(this.cameraSystem.activeCameraPos, player?.state.v ?? v3());

    // 表示時刻 = 未来ゴーストのスライダーぶん先取りした simTime。
    const displayTime = this._window.displayTime;

    const simTime = this.simulator.simTime;
    // 表示側は重力を持つ生存中の GameEntity(小惑星)も中心天体解決・遮蔽判定へ合流させる —
    // EntityManager.cleanup へ渡す表面到達判定用の配列(解析天体のみ)とは別物。
    const attractors = this.mergedAttractorsAt(simTime);

    // 最初に行う: 後続の sync とマーカー投影がこのフレームのカメラ行列を読む。
    this.cameraSystem.sync(this.floatingOrigin);

    const project = this.cameraSystem.activeCameraProjection;
    const overviewMode = this.cameraSystem.overviewMode;
    const displayToggles = this.cameraSystem.bodyClassToggles;
    const mapVisibility = overviewMode
      ? new MapVisibilityPolicy(
        this.ephemeris.registry,
        displayToggles,
        focusTargetId(this.cameraSystem.overviewCamera.focus),
        systemMembersAt(this.ephemeris.registry, this.cameraSystem.activeCameraPos, this.ephemeris.attractorsAt(displayTime)),
      )
      : null;
    const target = this.targeter.aliveTarget;
    const secondaryTarget = this.targeter.aliveSecondaryTarget;

    this._environment.sync(
      player?.state.r ?? v3(), this.floatingOrigin, displayTime,
      this.cameraSystem, this.navball.gridVisibility, mapVisibility,
    );

    // 0隻状態へ移ったフレームで、直前の操作艦のRCSループ音を確実に止める。
    if (!player) this._sfx.setRcs(false);
    for (const ship of this.entities.players) {
      ship.syncPlayer(
        this.floatingOrigin, this.cameraSystem, this.activeStage.isPlaying, this._isPaused,
        displayTime, ship === player, this.ephemeris, attractors,
        mapVisibility?.entity('player', ship === player) ?? null,
      );
    }

    this.entities.sync(this.floatingOrigin, displayTime);
    for (const ship of this.entities.players) {
      if (mapVisibility && !mapVisibility.entity('player', ship === player).category) ship.obj.visible = false;
    }
    for (const enemy of this.entities.enemies) {
      if (mapVisibility && !mapVisibility.entity('ship').category) enemy.obj.visible = false;
    }
    for (const ammo of this.entities.ammos) {
      if (mapVisibility && !mapVisibility.entity('ammo').category) ammo.obj.visible = false;
    }
    for (const base of this.entities.bases) {
      if (mapVisibility && !mapVisibility.entity('base').category) base.obj.visible = false;
    }
    for (const ship of this.entities.players) {
      ship.orbitLine.setDisplayEnabled(!overviewMode || (mapVisibility?.entity('player', ship === player).orbit ?? false));
    }
    for (const base of this.entities.bases) {
      base.syncOrbitLine(overviewMode, this.floatingOrigin, attractors);
      base.orbitLine.setDisplayEnabled(!overviewMode || (mapVisibility?.entity('base').orbit ?? false));
    }

    this.effects.sync(this.floatingOrigin, this.cameraSystem.activeCamera);

    if (player) {
      const targets = this.entities.getCombatTargets(player);
      this.targeter.sync(this.floatingOrigin, player, targets, overviewMode, project, attractors, mapVisibility);
      for (const enemy of this.entities.enemies) {
        enemy.orbitLine.setDisplayEnabled(!overviewMode || (mapVisibility?.entity('ship').orbit ?? false));
      }
    }
    this.navTarget.sync(project, overviewMode, this.cameraSystem.activeCameraPos);
    this.equatorNodeMarkers.sync(project, overviewMode, this.cameraSystem.activeCameraPos);

    // 敵マーカーは1体では決められない(画面上で近接するものをまとめる)ので集合として渡す。
    // 位置は機体メッシュと同じ displayState — 揃えないと「機体は未来位置、マーカーは現在位置」に割れる。
    const aliveTargets = this.entities.getCombatTargets(player).filter((t) => t.alive);
    const enemyMarkerItems: GroupedMarkerItem[] = [];
    for (const tgt of aliveTargets) {
      const ds = tgt.displayState(displayTime);
      if (!ds) continue;
      const role: 'none' | 'primary' | 'secondary' =
        tgt === target ? 'primary' : tgt === secondaryTarget ? 'secondary' : 'none';
      const entityKind = tgt instanceof Player ? 'player' : 'ship';
      const visibility = mapVisibility?.entity(entityKind, tgt === player);
      if (visibility && !visibility.pickable) continue;
      const item = tgt.markerItem(role, player?.state.r ?? v3(), ds.r, ds.v, overviewMode);
      enemyMarkerItems.push(visibility ? {
        ...item,
        sym: visibility.icon ? item.sym : '',
        name: visibility.label ? item.name : '',
        detail: visibility.label ? item.detail : '',
      } : item);
    }
    this.enemyMarkers.sync(enemyMarkerItems, project, overviewMode, this.cameraSystem.activeCameraScale);
    if (player) this.leadMarkers.sync(player, aliveTargets, target, secondaryTarget, simTime, overviewMode, project);

    this.displayTimeManager.setPredictionCoverage(this.predictionCoverageRatio());
    this.displayTimeManager.sync(this._window);
    this.editor.sync(
      this.cameraSystem.overviewCamera.dist, simTime, this.floatingOrigin, project,
      this.cameraSystem.activeCameraScale, overviewMode, this.cameraSystem.activeCameraPos,
    );
    this.mapPicker.sync(overviewMode, simTime, attractors, player);
    this.frameControls.sync(
      this.mapPicker.pickables, this.cameraSystem.activeCameraPos, attractors, simTime, overviewMode,
    );

    // 計画軌道の折れ線と同じ座標系で描かないと、同一画面上で並べたときに比較にならない。
    const predictedTargets = player?.alive ? [player] : [];
    this.predictedTrajectoryLine.sync(
      predictedTargets, this.editor.planDisplay.planFrame, simTime, this.ephemeris, this.floatingOrigin,
      this.cameraSystem.activeCameraScale, attractors,
    );
    // 解析楕円は、積分予測が表示範囲に届いていないあいだの代替表示。予測が表示ホライズンを
    // 覆いきったときだけ抑制する。predictedTrajectoryLine は操作対象艦しか描かないため、
    // 他の艦は常に non-suppressed に戻る。
    const predictHorizon = this._window.duration;
    for (const ship of this.entities.players) {
      ship.orbitLine.setSuppressed(this.predictedTrajectoryLine.coversHorizon(ship, simTime, predictHorizon));
    }

    if (player) {
      this.touchControls?.syncModeButtons(player.rcsDamp, player.fineAttitude, player.progradeHold);
    }
    this.activeStage.sync(player, this.floatingOrigin, project, this.cameraSystem.activeCameraScale, displayTime, overviewMode, mapVisibility);

    this._hud.panels.sync(this, attractors);
    this._hud.tick();

    if (player) this.guide.sync(this.editor.plan, player, simTime, this.editor.editMode, project);

    const debugTargets = player ? (target ? [player, target] : [player]) : [];
    this.debugTrajectoryLine.sync(
      debugTargets, this.editor.planDisplay.planFrame, simTime, this.ephemeris, this.floatingOrigin,
      this.cameraSystem.activeCameraScale, attractors,
    );

    // このフレームのマーカーが出揃った後でなければならないので最後に置く。
    this.markerManager.resolveCollisions();
  }

  // ------------------------------------------------------------------ render

  render(): void {
    // ドックビューは 3D 世界を持たず画面全体を不透明に覆うので、描画自体を止める。
    if (this.viewManager.current === 'dock') return;
    this.renderer.render(this._scene, this.cameraSystem.activeCamera);
  }

  // ------------------------------------------------------------------ debug

  // 負荷確認ウィンドウが読むエンティティ数・シミュレーション規模。集計と整形は PerfMeter 側。
  perfCounts(): PerfCounts {
    const attractorsCache = this._ephemeris.attractorsCacheStats;
    const timeCache = this._ephemeris.timeCacheStats;
    return {
      players: this.entities.players.length,
      enemies: this.entities.enemies.length,
      bullets: this.entities.bullets.length,
      casings: this.entities.casings.length,
      debris: this.entities.debris.length,
      ammos: this.entities.ammos.length,
      asteroids: this.entities.asteroids.length,
      bases: this.entities.bases.length,
      predicted: this.predictor.tracked,
      predictComplete: this.predictor.finished,
      predictDiscarded: this.predictor.discarded,
      predictorSteps: this.predictor.lastSteps,
      mapMode: this.cameraSystem.overviewMode,
      mapItems: this.cameraSystem.overviewMode ? this.mapPicker.pickables.length : 0,
      mapLabels: this.cameraSystem.overviewMode ? this.cameraSystem.focusMarkers.shownLabelCount : 0,
      displayDurationSec: this._window.duration,
      simSubsteps: this.simulator.lastSubsteps,
      orbitSteps: this.simulator.lastOrbitSteps,
      gravitySources: this.simulator.lastGravitySourceCount,
      planArcs: this.editor.lastReintegratedArcs,
      planSteps: this.editor.lastPlanSteps,
      attractorsCacheHits: attractorsCache.hits,
      attractorsCacheMisses: attractorsCache.misses,
      timeCacheHits: timeCache.hits,
      timeCacheMisses: timeCache.misses,
      warp: this.simSpeedManager.simSpeed,
    };
  }
}
