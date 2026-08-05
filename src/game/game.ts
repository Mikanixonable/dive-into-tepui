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
import { EnvironmentScene } from '../render/environment-scene';
import { Ephemeris } from '../physics/ephemeris';
import { MapModeToggler } from './map-mode-toggler';
import { NanWatchdog } from './nan-watchdog';
import { DebugHistoryLine } from './debug-history-line';
import { NavTarget } from './nav-target';
import { MapPicker } from './map-picker';
import { Navball } from './navball/navball';

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
  readonly mapModeToggler: MapModeToggler;
  private readonly mapPicker: MapPicker;

  readonly activeStage: Stage;
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

  // 各サブシステムを、互いの依存関係が満たせる順に生成して配線する。
  constructor(
    gs: GameScene,
    launch: LaunchSelection,
    hud: Hud,
    sfx: Sfx,
    settingsPanel: SettingsPanel,
    unlockManager: UnlockManager,
  ) {
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

    this.targeter = new Targeter(this._hud, this._sfx, this.markerManager, this._scene);
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
    );
    this.mapPicker = new MapPicker(
      this, this._hud, this.entities, this.ephemeris, this.navTarget,
      this.cameraSystem, this.editor, this.simSpeedManager,
    );
    this.guide = new PlanGuide(this._hud, this._sfx, this.markerManager);
    // クリエイティブモードはマップから始まる。
    this.mapModeToggler = new MapModeToggler(this._hud, launch.mode === 'creative');
    this.mapModeToggler.applyInitialState(this.editor, this.cameraSystem, this.displayTimeManager);

    this.input = new Input(gs.renderer.domElement);
    this.input.onFirstGesture = () => this._sfx.unlock();
    if (TouchControls.isTouchDevice()) this.touchControls = new TouchControls(this.input);
    this.touchControls?.setMapMode(this.mapModeToggler.mapMode);

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

  // MapPicker の削除口。参照を片付けてから EntityManager へ渡すため、削除後に stale id が残らない。
  removeCreativePlayer(ship: Player): void {
    const wasActive = this.player === ship;
    this.navTarget.clearIfTargeting(ship.id);
    this.mapPicker.close();
    if (this.cameraSystem.overviewCamera.focus === ship.id) this.cameraSystem.overviewCamera.focus = 'earth';
    if (wasActive) {
      ship.clearTransientCommands();
      this.player = null;
      this.editor.setActivePlayer(null);
    }
    this.entities.removePlayer(ship);
    if (wasActive) {
      const next = this.entities.players.find((p) => p.alive) ?? null;
      if (next) this.setActivePlayer(next);
      else this.cameraSystem.overviewMode = true;
    }
  }

  // このフレームの表示時刻(未来ゴーストのスライダーぶん先取りした simTime)。
  private get displayTime(): number {
    return this.displayTimeManager.resolveDisplayTime(this.player?.elements?.period ?? null, this.simulator.simTime);
  }

  // ------------------------------------------------------------ update

  update(dtRaw: number): void {
    this.input.update();
    const dt = Math.min(dtRaw, 0.1);
    this.handleInput();

    // handleInput より後に置く: ポーズ中も Esc・ヘルプなどは効かせる。
    if (this._isPaused) {
      this.editor.update(this.simulator.simTime, this.displayTime);
      this.mapPicker.refresh(this.simulator.simTime, this.displayTime);
      if (this.editor.editMode) {
        this.editor.handleMapPointer(this.input);
        this.mapPicker.handleRightClick(this.input, this.simulator.simTime);
        this.editor.updateEditing(dt, this.input);
      }
      this.cameraSystem.update(this.player, this.simulator.simTime, this.input, dt, this.mapPicker.pickables);
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
        this.simSpeedManager.simSpeed > C.MAX_PHYS_SIM_SPEED,
      );
      this.effects.update(dt, simDt);
      this.editor.update(this.simulator.simTime, this.displayTime);
      this.mapPicker.refresh(this.simulator.simTime, this.displayTime);
      this.cameraSystem.update(null, this.simulator.simTime, this.input, dt, this.mapPicker.pickables);
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
      this.effects.update(dt, simDt);
      this.editor.update(this.simulator.simTime, this.displayTime);
      this.mapPicker.refresh(this.simulator.simTime, this.displayTime);
      // 決着後もカメラ更新は飛ばせない: 飛ばすと視点だけが絶対 ECI に取り残され、
      // 軌道速度で遠ざかる原点(自機)から残骸が即座にフレームアウトする。
      this.cameraSystem.update(
        player, this.simulator.simTime, this.input, dt, this.mapPicker.pickables,
      );
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
          this.cameraSystem.overviewMode = true;
        }
      }
    }

    // Simulator内のsubstep cleanup後に呼ぶ: 死んだ個体を予測せず、積分後の実状態と突き合わせるため。
    this.predictor.update(
      this.simulator.simTime,
      this.player,
      this.simSpeedManager.simSpeed > C.MAX_PHYS_SIM_SPEED,
    );

    this.effects.update(dt, simDt);

    // trackAnchor より前に置く: 最後のノードが落ちたフレームからアンカーを自機へ追従させる。
    const activePlayer = this.player;
    if (activePlayer) {
      this.guide.update(this.editor.plan, activePlayer, this.simulator.simTime, this.editor.editMode);
      this.editor.plan.trackAnchor(activePlayer.state);
    }
    // 被選択物の候補にアプシスアイコンが入るので、計画の再積分はその組み立てより前に置く。
    this.editor.update(this.simulator.simTime, this.displayTime);

    // 物理積分の後に行う: 追従カメラの基準は sync 時のフローティングオリジン
    // (積分後の自機位置)と一致していなければならない。被選択物の座標も同じ理由で
    // ここまで待つ。
    this.mapPicker.refresh(this.simulator.simTime, this.displayTime);
    this.cameraSystem.update(
      activePlayer,
      this.simulator.simTime,
      this.input,
      dt,
      this.mapPicker.pickables,
    );

    if (this.editor.editMode) {
      // 右クリックはノードを先に試し、外したぶんだけコンテキストメニューへ回る(優先順位はこの順序だけ)。
      this.editor.handleMapPointer(this.input);
      this.mapPicker.handleRightClick(this.input, this.simulator.simTime);
      this.editor.updateEditing(dt, this.input);
    }
    else if (this.player) {
      this.targeter.updateCombatTargeting(
        this.player, this.entities.enemies, this.input, this.cameraSystem.activeCameraProjection,
      );
    }
  }

  // 並進・射撃・衝突と同じく、RCS command torqueは物理相互作用域だけで有効。
  // 全艦を明示的にzeroへ戻すことで、active切替前やauto-warp開始前のstale指令も残さない。
  private applyWarpCommandPolicy(): void {
    if (this.simSpeedManager.simSpeed <= C.MAX_PHYS_SIM_SPEED) return;
    for (const ship of this.entities.players) ship.suppressAttitudeCommandForWarp();
    this._sfx.setRcs(false);
  }

  // --------------------------------------------------------------- input

  // 入力エッジを担当モジュールへ先着順で配る。決めるのは優先順位 = 呼ぶ順序だけで、
  // どのキー/クリックが何をするかは各モジュールが持つ。ここで配るのは、決着後・ポーズ中も
  // 効くべき操作(設定・ヘルプ・再出撃・ワープ・マップ開閉・計画破棄)。
  private handleInput(): void {
    // 上から下へ優先順位順に呼ぶ。
    this.settingsPanel.handleInput(this.input);
    this._hud.handleInput(this.input);
    this.activeStage.handleInput(this.input);
    this.simSpeedManager.handleInput(
      this.input,
      this.activeStage.isPlaying,
      this.editor.editMode,
      this.editor.plan.firstNode(),
    );
    // 戦闘ビューはアクティブ艦を前提とする。艦がまだ配置されていない/破壊されている間は無効。
    const canToggleView = this.player?.alive ?? false;
    this.mapModeToggler.update(
      this.input, this.activeStage.isPlaying, this._isPaused, canToggleView,
      this.editor, this.touchControls, this.cameraSystem, this.displayTimeManager,
      this.mapPicker,
    );
    this.editor.handleInput(this.input);
  }

  // ------------------------------------------------------------------ sync

  sync(dt: number): void {
    const player = this.player;
    this.floatingOrigin = player
      ? new FloatingOrigin(player.state.r, player.state.v)
      : new FloatingOrigin(v3(), v3());

    // 表示時刻 = 未来ゴーストのスライダーぶん先取りした simTime。
    const orbitPeriod = player?.elements?.period ?? null;
    const displayTime = this.displayTimeManager.resolveDisplayTime(orbitPeriod, this.simulator.simTime);

    // 最初に行う: 後続の sync とマーカー投影がこのフレームのカメラ行列を読む。
    this.cameraSystem.sync(this.floatingOrigin, displayTime);

    const project = this.cameraSystem.activeCameraProjection;
    const overviewMode = this.cameraSystem.overviewMode;
    const simTime = this.simulator.simTime;
    const target = this.targeter.aliveTarget;
    const secondaryTarget = this.targeter.aliveSecondaryTarget;

    this.environment.sync(
      dt, player?.state.r ?? v3(), this.floatingOrigin, displayTime,
      this.cameraSystem, this.navball.gridVisibility,
    );

    // 0隻状態へ移ったフレームで、直前の操作艦のRCSループ音を確実に止める。
    if (!player) this._sfx.setRcs(false);
    for (const ship of this.entities.players) {
      ship.syncPlayer(
        this.floatingOrigin, this.cameraSystem, this.activeStage.isPlaying, this._isPaused,
        displayTime, ship === player,
      );
    }

    this.entities.sync(this.floatingOrigin, displayTime);

    this.effects.sync(this.floatingOrigin, this.cameraSystem.activeCamera);

    if (player) this.targeter.sync(this.floatingOrigin, player, this.entities.enemies, overviewMode, project);
    this.navTarget.sync(project);
    if (player) this.navball.sync(player.state, player.att, player.alive, target?.state ?? null);

    // 敵マーカーは1体では決められない(画面上で近接するものをまとめる)ので集合として渡す。
    // 位置は機体メッシュと同じ displayState — 揃えないと「機体は未来位置、マーカーは現在位置」に割れる。
    const aliveEnemies = this.entities.enemies.filter((enemy) => enemy.alive);
    const enemyMarkerItems: GroupedMarkerItem[] = [];
    for (const enemy of aliveEnemies) {
      const pos = enemy.displayState(displayTime)?.r;
      if (!pos) continue;
      const role: 'none' | 'primary' | 'secondary' =
        enemy === target ? 'primary' : enemy === secondaryTarget ? 'secondary' : 'none';
      enemyMarkerItems.push(enemy.markerItem(role, player?.state.r ?? v3(), pos));
    }
    this.enemyMarkers.sync(enemyMarkerItems, project);
    if (player) this.leadMarkers.sync(player, aliveEnemies, target, simTime, overviewMode, project);

    this.displayTimeManager.sync(orbitPeriod);
    this.editor.sync(this.cameraSystem.overviewCamera.dist, simTime, this.floatingOrigin, project);

    if (player) {
      this.touchControls?.syncModeButtons(player.rcsDamp, player.fineAttitude, player.progradeHold);
      this.activeStage.sync(player, project, displayTime, overviewMode);
    } else if (this.activeStage instanceof CreativeStage) {
      this.activeStage.syncWithoutPlayer(overviewMode);
    }

    this._hud.panels.sync(this, dt);
    this._hud.tick();

    if (player) this.guide.sync(this.editor.plan, player, simTime, this.editor.editMode, project);

    const debugTargets = player ? (target ? [player, target] : [player]) : [];
    this.debugHistoryLine.sync(debugTargets, this.editor.planDisplay.trajectoryFrame, simTime, this.ephemeris, this.floatingOrigin);

    // このフレームのマーカーが出揃った後でなければならないので最後に置く。
    this.markerManager.resolveCollisions();
  }

  // ------------------------------------------------------------------ render

  render(): void {
    this.renderer.render(this._scene, this.cameraSystem.activeCamera);
  }

  // ------------------------------------------------------------------ debug

  // ?perf=1 のデバッグ表示用エンティティ数。
  perfCounts(): { enemies: number; bullets: number; casings: number; debris: number; } {
    return {
      enemies: this.entities.enemies.length,
      bullets: this.entities.bullets.length,
      casings: this.entities.casings.length,
      debris: this.entities.debris.length,
    };
  }
}
