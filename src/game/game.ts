// ゲーム全体のオーケストレーション: 各システムの生成・保持と、フレームごとの呼び出し順序の決定。
import * as THREE from 'three/webgpu';
import { FloatingOrigin } from './floating-origin';
import * as C from './const';
import { v3 } from '../physics/vec3';
import { Player } from './player/player';
import { Enemy } from './game-entity/enemy';
import { CameraSystem } from './camera/camera-system';
import { Stage, StageId } from './stages/stage';
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
  readonly player: Player;
  readonly simSpeedManager: SimSpeedManager;

  private readonly editor: PlanEditor;
  private readonly displayTimeManager: DisplayTimeManager;
  private readonly guide: PlanGuide;
  readonly mapModeToggler: MapModeToggler;

  readonly activeStage: Stage;
  private _isPaused = false;
  get isPaused(): boolean { return this._isPaused; }

  private readonly environment: EnvironmentScene;

  private readonly unlockManager: UnlockManager;

  // 単独のオブジェクトでは決められないマーカー群。敵マーカーは「画面上で近接するものを
  // まとめる」ために集合全体を、LEAD マーカーは自機と敵の両方を必要とする。
  private readonly enemyMarkers: GroupedMarkers;
  private readonly leadMarkers: LeadMarkers;
  private readonly effects: EffectsSystem;
  readonly targeter: Targeter;
  readonly entities: EntityManager;
  readonly simulator: Simulator;
  private readonly predictor: Predictor;
  private readonly nanWatchdog: NanWatchdog;
  private readonly debugHistoryLine: DebugHistoryLine;

  // 各サブシステムを、互いの依存関係が満たせる順に生成して配線する。
  constructor(
    gs: GameScene,
    stageId: StageId,
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
    this.player = new Player(this._hud, this._sfx, this._scene, this.effects, this.markerManager);

    this.cameraSystem = new CameraSystem(
      this._hud,
      this._sfx,
      this.markerManager,
      this.ephemeris,
      this.player,
    );
    this.simSpeedManager = new SimSpeedManager(this._hud, this._sfx);

    this.targeter = new Targeter(this._hud, this._sfx, this.markerManager, this._scene);
    this.environment = new EnvironmentScene(this._scene, this.ephemeris);
    this.displayTimeManager = new DisplayTimeManager(this._hud.root);
    this.editor = new PlanEditor(
      this._hud,
      this._sfx,
      this.simSpeedManager,
      this.ephemeris,
      this._scene,
      this.markerManager,
      () => this.player.fineAttitude,
    );
    // 表示期間の非連続な切り替えは、予測折れ線の通常のスロットルを待たせず即座に作り直す。
    this.displayTimeManager.onDurationChange = () => this.editor.planDisplay.traj.invalidate();

    this.guide = new PlanGuide(this._hud, this._sfx, this.markerManager);
    this.mapModeToggler = new MapModeToggler(this._hud);

    this.input = new Input(gs.renderer.domElement);
    this.input.onFirstGesture = () => this._sfx.unlock();
    if (TouchControls.isTouchDevice()) this.touchControls = new TouchControls(this.input);

    this.simulator = new Simulator(this.entities, this.ephemeris, this._sfx, this.effects);
    this.predictor = new Predictor(this.entities, this.ephemeris);

    this.activeStage = initStage(
      stageId,
      this.player,
      this.entities,
      this._hud,
      this._sfx,
      this._scene,
      this.unlockManager,
      this.effects,
      this.markerManager,
    );

    this.nanWatchdog = new NanWatchdog(this._hud);
    this.debugHistoryLine = new DebugHistoryLine(this._scene);

    this.floatingOrigin = new FloatingOrigin(this.player.state.r, this.player.state.v);
  }

  // ------------------------------------------------------------------ lifecycle

  pause(): void {
    this.simulator.lastSimDt = 0;
    this._sfx.setThrust(false);
    this.player.pause();
    this._isPaused = true;
  }

  resume(): void { this._isPaused = false; }

  // ------------------------------------------------------------ update

  update(dtRaw: number): void {
    this.input.update();
    const dt = Math.min(dtRaw, 0.1);
    this.handleInput();

    // handleInput より後に置く: ポーズ中も Esc・ヘルプなどは効かせる。
    if (this._isPaused) {
      if (this.editor.editMode) {
        this.editor.handleMapPointer(this.input);
        this.cameraSystem.handleMapPointer(this.input);
        this.editor.updateEditing(dt, this.simulator.simTime, this.input);
      }
      this.cameraSystem.update(this.player, this.simulator.simTime, this.input, dt);
      return;
    }

    // behave が呼ばれなくなるので、決着時点の thrust が凍結され続けないよう明示的に消す。
    if (!this.activeStage.isPlaying) {
      this.player.thrust = null;
      this.player.torque = v3();
      const simDt = dt * Math.min(this.simSpeedManager.simSpeed, C.MAX_PHYS_SIM_SPEED);
      this.simulator.stepSimulation(dt, simDt, this.player, this.activeStage, false, false, false);
      this.nanWatchdog.checkAll('stepSimulation(決着後)', this.player, this.entities, this.simulator.simTime, dt, simDt);
      this.entities.cleanup(dt, this.simulator.simTime, this.activeStage, this.player.state.r);
      // 決着後もカメラ更新は飛ばせない: 飛ばすと視点だけが絶対 ECI に取り残され、
      // 軌道速度で遠ざかる原点(自機)から残骸が即座にフレームアウトする。
      this.cameraSystem.update(this.player, this.simulator.simTime, this.input, dt);
      return;
    }

    this.nanWatchdog.checkPlayer('frameStart', this.player, this.simulator.simTime, dt, this.simulator.lastSimDt);

    this.player.behave({
      dt,
      input: this.input,
      simSpeed: this.simSpeedManager,
      editMode: this.editor.editMode,
      scoreCounter: this.activeStage.scoreCounter,
      simTime: this.simulator.simTime,
      zoomActive: this.cameraSystem.zoomActive,
      ephemeris: this.ephemeris,
      addBullet: (bullet) => this.entities.addBullet(bullet),
    });

    this.nanWatchdog.checkPlayer('player.behave', this.player, this.simulator.simTime, dt, this.simulator.lastSimDt);

    this.activeStage.update(dt, this.player, this.entities, this.simulator.simTime, this.simSpeedManager);

    this.nanWatchdog.checkPlayer('activeStage.update', this.player, this.simulator.simTime, dt, this.simulator.lastSimDt);

    this.simSpeedManager.update(this.simulator.simTime);
    const simDt = dt * this.simSpeedManager.simSpeed;
    this.simulator.stepSimulation(dt, simDt, this.player, this.activeStage,
      true, // bulletCollision
      this.simSpeedManager.canResolvePhysicalCollisions, // resolveCollision
      true, // doSubstep
      (a, b, speed) => {
        if (a === this.player && b instanceof Enemy) {
          this.player.collidedAtSpeed(speed, this.activeStage);
          b.collidedAtSpeed(speed, this.simulator.simTime, this.activeStage);
        } else if (b === this.player && a instanceof Enemy) {
          this.player.collidedAtSpeed(speed, this.activeStage);
          a.collidedAtSpeed(speed, this.simulator.simTime, this.activeStage);
        }
      },
    );

    // 薬莢や破片が先に壊れて接触経由で自機へ伝播することがあるので、ここは全エンティティを見る。
    this.nanWatchdog.checkAll('simulator.stepSimulation', this.player, this.entities, this.simulator.simTime, dt, simDt);

    this.targeter.markBoardCrossings(this.player, this.entities);

    this.player.checkLoss(dt, this.simulator.simTime, this.activeStage, this.player.state.r);

    this.entities.cleanup(dt, this.simulator.simTime, this.activeStage, this.player.state.r);

    // cleanup の後に呼ぶ: 死んだ個体を予測せず、積分後の実状態と突き合わせるため。
    this.predictor.update(this.simulator.simTime, this.player);

    // 物理積分の後に行う: 追従カメラの基準は sync 時のフローティングオリジン
    // (積分後の自機位置)と一致していなければならない。
    this.cameraSystem.update(
      this.player,
      this.simulator.simTime,
      this.input,
      dt,
    );

    this.editor.plan.trackAnchor(this.player.state);

    if (this.editor.editMode) {
      // 右クリックはノードを先に試し、外したぶんだけフォーカス選択へ回る(優先順位はこの順序だけ)。
      this.editor.handleMapPointer(this.input);
      this.cameraSystem.handleMapPointer(this.input);
      this.editor.updateEditing(dt, this.simulator.simTime, this.input);
    }
    else {
      this.targeter.updateCombatTargeting(this.player, this.entities.enemies, this.input, this.cameraSystem);
    }
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
    this.mapModeToggler.update(
      this.input, this.activeStage.isPlaying, this._isPaused,
      this.editor, this.touchControls, this.cameraSystem, this.displayTimeManager
    );
    this.editor.handleInput(this.input);
  }

  // ------------------------------------------------------------------ sync

  sync(dt: number): void {
    this.floatingOrigin = new FloatingOrigin(this.player.state.r, this.player.state.v);

    // 表示時刻 = 未来ゴーストのスライダーぶん先取りした simTime。
    const orbitPeriod = this.player.elements?.period ?? null;
    const displayTime = this.displayTimeManager.resolveDisplayTime(orbitPeriod, this.simulator.simTime);

    // 最初に行う: 後続の sync とマーカー投影がこのフレームのカメラ行列を読む。
    this.cameraSystem.sync(this.floatingOrigin, displayTime);

    const project = this.cameraSystem.activeCameraProjection;
    const overviewMode = this.cameraSystem.overviewMode;
    const simTime = this.simulator.simTime;
    const target = this.targeter.aliveTarget;

    this.environment.sync({
      dt,
      player: this.player,
      floatingOrigin: this.floatingOrigin,
      displayTime,
      cameraSystem: this.cameraSystem,
    });

    this.player.syncPlayer(this.floatingOrigin, this.cameraSystem, this.activeStage.isPlaying, this._isPaused, displayTime);

    this.entities.sync(this.floatingOrigin, displayTime);

    this.effects.sync(dt, this.simulator.lastSimDt, this.floatingOrigin, this.cameraSystem.activeCamera);

    this.targeter.sync(dt, this.floatingOrigin, this.player, this.entities.enemies, overviewMode, project);

    // 敵マーカーは1体では決められない(画面上で近接するものをまとめる)ので集合として渡す。
    // 位置は機体メッシュと同じ displayState — 揃えないと「機体は未来位置、マーカーは現在位置」に割れる。
    const aliveEnemies = this.entities.enemies.filter((enemy) => enemy.alive);
    const enemyMarkerItems: GroupedMarkerItem[] = [];
    for (const enemy of aliveEnemies) {
      const pos = enemy.displayState(displayTime)?.r;
      if (pos) enemyMarkerItems.push(enemy.markerItem(enemy === target, this.player.state.r, pos));
    }
    this.enemyMarkers.sync(enemyMarkerItems, project);
    this.leadMarkers.sync(this.player, aliveEnemies, target, simTime, overviewMode, project);

    this.displayTimeManager.sync(orbitPeriod);
    const displayEnd = simTime + this.displayTimeManager.durationSec(orbitPeriod);
    this.editor.sync(this.cameraSystem.overviewCamera.dist, displayEnd, simTime, displayTime, this.floatingOrigin, project);

    this.touchControls?.syncModeButtons(this.player.rcsDamp, this.player.fineAttitude, this.player.progradeHold);
    this.activeStage.sync(this.player, project, displayTime, overviewMode);

    this._hud.panels.update(this, dt);
    this._hud.tick();

    this.guide.update(this.editor.plan, this.player, simTime, this.simSpeedManager, this.editor.editMode, project);

    const debugTargets = target ? [this.player, target] : [this.player];
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
