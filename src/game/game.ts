// ゲーム全体のオーケストレーション: 各システムの生成・保持と、フレームごとの呼び出し順序の決定。
import * as THREE from 'three/webgpu';
import { FloatingOrigin } from './floating-origin';
import * as C from './const';
import { v3 } from '../physics/vec3';
import { Player } from './player/player';
import { Enemy } from './game-entity/enemy';
import { CameraSystem } from './camera/camera-system';
import { Stage } from './stages/stage';
import { CreativeStage } from './stages/creative-stage';
import { LaunchSelection } from './game-mode';
import { MarkerManager } from './marker/marker-manager';
import { GroupedMarkers, GroupedMarkerItem } from './marker/grouped-markers';
import { LeadMarkers } from './marker/lead-markers';
import { EffectsSystem } from './vfx/effects-system';
import { initStage } from './stages/stage-dictionary';
import { UnlockManager } from './unlock-manager';
import { Targeter } from './targeter';
import { PlanEditor } from './plan/plan-editor';
import { DisplayTimeManager } from './display-time-manager';
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
import { INERTIAL_FRAME } from '../physics/frame';
import { ViewManager } from './view-manager';
import { NanWatchdog } from './nan-watchdog';
import { DebugHistoryLine } from './debug-history-line';
import { NavTarget } from './nav-target';
import { MapPicker } from './map-picker';
import { Navball } from './navball/navball';
import { GameSaveData } from './save-data';
import { Ammo } from './game-entity/ammo';
import { SaveManager } from './save-manager';
import { KEY_MAPPING as K } from './input/key-mapping';
import { Docking } from './docking';
import { ViewBadge } from './hud/view-badge';
import { Base } from './game-entity/base';
import { strongestAttractor } from '../physics/attractor';

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
  private readonly ephemeris: Ephemeris;
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

  private readonly environment: EnvironmentScene;
  private readonly navball: Navball;

  private readonly unlockManager: UnlockManager;

  // 単独のオブジェクトでは決められないマーカー群。敵マーカーは「画面上で近接するものを
  // まとめる」ために集合全体を、LEAD マーカーは自機と敵の両方を必要とする。
  private readonly enemyMarkers: GroupedMarkers;
  private readonly leadMarkers: LeadMarkers;
  private readonly effects: EffectsSystem;
  readonly targeter: Targeter;
  readonly navTarget: NavTarget;
  readonly entities: EntityManager;
  readonly simulator: Simulator;
  private readonly predictor: Predictor;
  private readonly nanWatchdog: NanWatchdog;
  private readonly debugHistoryLine: DebugHistoryLine;
  private readonly docking: Docking;
  private readonly viewBadge: ViewBadge;

  // 各サブシステムを、互いの依存関係が満たせる順に生成して配線する。
  constructor(
    gs: GameScene,
    launch: LaunchSelection,
    hud: Hud,
    sfx: Sfx,
    settingsPanel: SettingsPanel,
    unlockManager: UnlockManager,
  ) {
    this.launchMode = launch.mode;
    this._scene = gs.scene;
    this.renderer = gs.renderer;
    this._hud = hud;
    this._sfx = sfx;
    this.settingsPanel = settingsPanel;
    this.unlockManager = unlockManager;

    this.ephemeris = new Ephemeris();

    this.markerManager = new MarkerManager(this._hud.root, this._hud.svgOverlay);
    this.enemyMarkers = new GroupedMarkers(this.markerManager, C.MARKER_CLUSTER_PX);
    this.leadMarkers = new LeadMarkers(this.markerManager);

    this.entities = new EntityManager();
    this.effects = new EffectsSystem(this._scene, this.entities);
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
    this.navball = new Navball(this._hud.root);
    this.environment = new EnvironmentScene(this._scene, this.ephemeris);
    this.displayTimeManager = new DisplayTimeManager(this._hud.root);
    this.editor = new PlanEditor(
      this._hud,
      this._sfx,
      this.simSpeedManager,
      this.ephemeris,
      this._scene,
      this.markerManager,
      () => this.player?.fineAttitude ?? false,
      bootstrapPlayer,
      this.displayTimeManager,
    );
    this.editor.onFocusNode = (state) => this.cameraSystem.overviewCamera.setFocusPos(state.r);
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

    this.simulator = new Simulator(this.entities, this.ephemeris, this._sfx, this.effects);
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
    this.debugHistoryLine = new DebugHistoryLine(this._scene);
    this.docking = new Docking(
      this, this._hud, this._sfx, this._scene, this.effects, this.markerManager,
      this.entities, this.mapPicker, this.cameraSystem, this.viewManager,
    );
    this.mapPicker.setDocking(this.docking);
    this.viewBadge = new ViewBadge(this._hud.root, this.viewManager);

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

  // ship が null なら未配置状態(Creative の全滅/未収容)へ戻す。
  setActivePlayerOrNull(ship: Player | null): void {
    if (ship) this.setActivePlayer(ship);
    else {
      this.player = null;
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


  // このフレームの表示時刻(未来ゴーストのスライダーぶん先取りした simTime)。
  private get displayTime(): number {
    return this.displayTimeManager.resolveDisplayTime(this.simulator.simTime, this.currentOrbitPeriod());
  }

  // 自機の現在軌道の周期 [s]。自機がいない、または有限な周期が求まらない間は NaN —
  // DisplayTimeManager.durationSec 側のフォールバックに委ねる。
  private currentOrbitPeriod(): number {
    if (!this.player) return NaN;
    const center = strongestAttractor(this.player.state.r, this.ephemeris.attractorsAt(this.simulator.simTime));
    return this.player.elementsAround(center)?.period ?? NaN;
  }

  get simTime(): number { return this.simulator.simTime; }

  // ------------------------------------------------------------ save/load

  restore(data: GameSaveData): void {
    this.entities.clearAll();
    this.player = null;
    this.editor.setActivePlayer(null);
    this.cameraSystem.setActivePlayer(null);
    this.targeter.clearTargets();
    this.navTarget.clearIfTargeting('');

    // 時刻の復元
    this.simulator.simTime = data.simTime;

    // Playerの復元
    if (data.player) {
      const p = Player.restore(data.player, data.simTime, this._hud, this._sfx, this._scene, this.effects, this.markerManager);
      this.entities.addPlayer(p);
      this.setActivePlayer(p);
    }

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

    // ロード直後の状態同期と安定化
    this.entities.sync(this.floatingOrigin, data.simTime);
  }

  // ------------------------------------------------------------ update

  update(dtRaw: number): void {
    this.input.update();
    const dt = Math.min(dtRaw, 0.1);
    this.handleInput();

    // handleInput より後に置く: ポーズ中も Esc・ヘルプなどは効かせる。
    if (this._isPaused) {
      this.updateMapPresentation(dt, () => {
        if (!this.editor.editMode) return;
        this.mapPicker.handleRightClick(this.input, this.simulator.simTime);
        this.editor.handleMapPointer(this.input);
        this.mapPicker.handleEmptySpaceRightClick(this.input, this.simulator.simTime);
        this.editor.updateEditing(dt, this.input);
      });
      return;
    }

    // Creative の未配置状態でも、残骸・弾など全エンティティの epoch は進め続ける。
    if (this.player === null) {
      this.simSpeedManager.update(this.simulator.simTime);
      this.applyWarpCommandPolicy();
      const simDt = dt * this.simSpeedManager.simSpeed;
      this.simulator.stepSimulation(
        dt, simDt, null, this.activeStage,
        true, false, true,
      );
      this.predictor.update(
        this.simulator.simTime,
        null,
        this.simSpeedManager.canGrowPrediction,
        this.displayTimeManager.durationSec(this.currentOrbitPeriod()),
      );
      this.activeStage.update(dt, null, this.entities, this.simulator.simTime, this.simSpeedManager);
      this.effects.update(dt, this.simulator.simTime);
      this.updateMapPresentation(dt);
      if (this.editor.editMode) {
        this.mapPicker.handleRightClick(this.input, this.simulator.simTime);
        this.editor.handleMapPointer(this.input);
        this.mapPicker.handleEmptySpaceRightClick(this.input, this.simulator.simTime);
        this.editor.updateEditing(dt, this.input);
      }
      return;
    }
    const player = this.player;

    // behave が呼ばれなくなるので、決着時点の thrust が凍結され続けないよう明示的に消す。
    if (!this.activeStage.isPlaying) {
      player.thrust = null;
      player.torque = v3();
      const simDt = dt * Math.min(this.simSpeedManager.simSpeed, C.MAX_PHYS_SIM_SPEED);
      this.simulator.stepSimulation(dt, simDt, player, this.activeStage, false, false, false);
      this.nanWatchdog.checkAll('stepSimulation(決着後)', player, this.entities, this.simulator.simTime, dt, simDt);
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
      editMode: this.editor.editMode,
      scoreCounter: this.activeStage.scoreCounter,
      simTime: this.simulator.simTime,
      zoomActive: this.cameraSystem.zoomActive,
      addBullet: (bullet) => this.entities.addBullet(bullet),
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
    this.simulator.stepSimulation(dt, simDt, player, this.activeStage,
      true, // bulletCollision
      this.simSpeedManager.canResolvePhysicalCollisions, // resolveCollision
      true, // doSubstep
      (a, b, speed) => {
        if (a === player && b instanceof Enemy) {
          player.collidedAtSpeed(speed, this.activeStage);
          b.collidedAtSpeed(speed, this.simulator.simTime, this.activeStage);
        } else if (b === player && a instanceof Enemy) {
          player.collidedAtSpeed(speed, this.activeStage);
          a.collidedAtSpeed(speed, this.simulator.simTime, this.activeStage);
        }
      },
    );

    // 薬莢や破片が先に壊れて接触経由で自機へ伝播することがあるので、ここは全エンティティを見る。
    this.nanWatchdog.checkAll('simulator.stepSimulation', player, this.entities, this.simulator.simTime, dt, simDt);

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
      this.simSpeedManager.canGrowPrediction,
      this.displayTimeManager.durationSec(this.currentOrbitPeriod()),
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
    this.editor.update(this.simulator.simTime, this.displayTime);
    this.mapPicker.refresh(this.simulator.simTime, this.displayTime);
    afterRefresh?.();
    this.cameraSystem.update(
      this.player, this.simulator.simTime, this.input, dt, this.mapPicker.pickables,
    );
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

    if (this.input.takeKey(K.quickSave)) {
      SaveManager.save(this);
    }
    if (this.input.takeKey(K.quickLoad)) {
      SaveManager.load(this);
    }
  }

  // ------------------------------------------------------------------ sync

  sync(): void {
    this.viewBadge.sync(this.activeStage.selectLabel, this.activeStage.isPlaying && (this.player?.alive ?? false));
    const player = this.player;
    this.floatingOrigin = player
      ? new FloatingOrigin(player.state.r, player.state.v)
      : new FloatingOrigin(v3(), v3());

    // 表示時刻 = 未来ゴーストのスライダーぶん先取りした simTime。
    const displayTime = this.displayTimeManager.resolveDisplayTime(this.simulator.simTime, this.currentOrbitPeriod());

    // 最初に行う: 後続の sync とマーカー投影がこのフレームのカメラ行列を読む。
    this.cameraSystem.sync(this.floatingOrigin);

    const project = this.cameraSystem.activeCameraProjection;
    const overviewMode = this.cameraSystem.overviewMode;
    const simTime = this.simulator.simTime;
    const bodies = this.ephemeris.attractorsAt(simTime);
    const target = this.targeter.aliveTarget;
    const secondaryTarget = this.targeter.aliveSecondaryTarget;

    this.environment.sync(
      player?.state.r ?? v3(), this.floatingOrigin, displayTime,
      this.cameraSystem, this.navball.gridVisibility,
    );

    // 0隻状態へ移ったフレームで、直前の操作艦のRCSループ音を確実に止める。
    if (!player) this._sfx.setRcs(false);
    for (const ship of this.entities.players) {
      ship.syncPlayer(
        this.floatingOrigin, this.cameraSystem, this.activeStage.isPlaying, this._isPaused,
        displayTime, ship === player, this.ephemeris,
      );
    }

    this.entities.sync(this.floatingOrigin, displayTime);
    for (const base of this.entities.bases) base.syncOrbitLine(overviewMode, this.floatingOrigin, bodies);

    this.effects.sync(this.floatingOrigin, this.cameraSystem.activeCamera);

    if (player) {
      const targets = this.entities.getCombatTargets(player);
      this.targeter.sync(this.floatingOrigin, player, targets, overviewMode, project, bodies);
    }
    this.navTarget.sync(project);
    if (player) this.navball.sync(player.state, player.att, player.alive, target?.state ?? null);

    // 敵マーカーは1体では決められない(画面上で近接するものをまとめる)ので集合として渡す。
    // 位置は機体メッシュと同じ displayState — 揃えないと「機体は未来位置、マーカーは現在位置」に割れる。
    const aliveTargets = this.entities.getCombatTargets(player).filter((t) => t.alive);
    const enemyMarkerItems: GroupedMarkerItem[] = [];
    for (const tgt of aliveTargets) {
      const pos = tgt.displayState(displayTime)?.r;
      if (!pos) continue;
      const role: 'none' | 'primary' | 'secondary' =
        tgt === target ? 'primary' : tgt === secondaryTarget ? 'secondary' : 'none';
      enemyMarkerItems.push(tgt.markerItem(role, player?.state.r ?? v3(), pos));
    }
    this.enemyMarkers.sync(enemyMarkerItems, project);
    if (player) this.leadMarkers.sync(player, aliveTargets, target, secondaryTarget, simTime, overviewMode, project);

    this.displayTimeManager.sync(simTime, this.currentOrbitPeriod());
    this.editor.sync(this.cameraSystem.overviewCamera.dist, simTime, this.floatingOrigin, project);
    this.mapPicker.sync(overviewMode, simTime, bodies, player);
    // 月フライバイ等で積分予測と解析楕円が乖離した場合は、重なって誤解を招く
    // 楕円近似線をマップ表示中だけ抑制する。戦闘ビューへ戻れば通常の線へ復帰する。
    if (player) {
      player.orbitLine.setSuppressed(
        overviewMode && this.editor.planDisplay.traj.isAnalyticDivergent,
      );
    }

    if (player) {
      this.touchControls?.syncModeButtons(player.rcsDamp, player.fineAttitude, player.progradeHold);
    }
    this.activeStage.sync(player, this.floatingOrigin, project, displayTime, overviewMode);

    this._hud.panels.sync(this, bodies);
    this._hud.tick();

    if (player) this.guide.sync(this.editor.plan, player, simTime, this.editor.editMode, project);

    const debugTargets = player ? (target ? [player, target] : [player]) : [];
    const debugFrame = overviewMode ? this.cameraSystem.overviewCamera.cameraFrame : INERTIAL_FRAME;
    this.debugHistoryLine.sync(debugTargets, debugFrame, simTime, this.ephemeris, this.floatingOrigin);

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

  // ?perf=1 のデバッグ表示用エンティティ数。
  perfCounts(): {
    enemies: number; bullets: number; casings: number; debris: number;
    predicted: number; predictComplete: number; predictDiscarded: number;
  } {
    return {
      enemies: this.entities.enemies.length,
      bullets: this.entities.bullets.length,
      casings: this.entities.casings.length,
      debris: this.entities.debris.length,
      predicted: this.predictor.tracked,
      predictComplete: this.predictor.complete,
      predictDiscarded: this.predictor.discarded,
    };
  }
}

