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
import { MapContextGizmo, MapMenuItem } from './map-context-gizmo';
import { MapPickable, pickNearest } from './map-pick';
import { NavTarget } from './nav-target';
import { Navball } from './navball/navball';
import { CreativeShip } from './game-entity/creative-ship';

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
  player: Player;
  readonly simSpeedManager: SimSpeedManager;

  private readonly editor: PlanEditor;
  private readonly displayTimeManager: DisplayTimeManager;
  private readonly guide: PlanGuide;
  readonly mapModeToggler: MapModeToggler;
  private readonly mapContextGizmo: MapContextGizmo;

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
      () => this.player.fineAttitude,
      this.player,
    );
    // 表示期間の非連続な切り替えは、予測折れ線の通常のスロットルを待たせず即座に作り直す。
    this.displayTimeManager.onDurationChange = () => this.editor.planDisplay.traj.invalidate();

    this.guide = new PlanGuide(this._hud, this._sfx, this.markerManager);
    // クリエイティブモードはマップから始まる。
    this.mapModeToggler = new MapModeToggler(this._hud, launch.mode === 'creative');
    this.mapModeToggler.applyInitialState(this.editor, this.cameraSystem, this.displayTimeManager);
    this.mapContextGizmo = new MapContextGizmo();
    this.mapContextGizmo.onSelect = (act, target) => {
      if (act === 'focus') {
        this.cameraSystem.overviewCamera.focus = target.id;
        this._hud.hint(`${target.name} にフォーカス`);
      } else if (act === 'navTarget') {
        this.navTarget.toggleTarget(target.id, target.name);
      } else if (act === 'warp') {
        const t = this.navTarget.passTimeOf(target.id);
        if (t !== null) this.simSpeedManager.startAutoWarpTo(t);
      } else if (act === 'addNode') {
        const t = target.kind === 'apsis'
          ? this.editor.planDisplay.apsisTimeOf(target.id)
          : this.navTarget.passTimeOf(target.id);
        if (t !== null) this.editor.addNodeAt(t);
        else this._hud.hint('この時刻の計画軌道が求まりません');
      } else if (act === 'activate') {
        this.activateCreativeShip(target.id);
      } else if (act === 'followToggle') {
        this.toggleCreativeShipFollowPlan(target.id);
      } else if (act === 'delete') {
        this.deleteCreativeShip(target.id);
      }
    };

    this.input = new Input(gs.renderer.domElement);
    this.input.onFirstGesture = () => this._sfx.unlock();
    if (TouchControls.isTouchDevice()) this.touchControls = new TouchControls(this.input);
    this.touchControls?.setMapMode(this.mapModeToggler.mapMode);

    this.simulator = new Simulator(this.entities, this.ephemeris, this._sfx, this.effects);
    this.predictor = new Predictor(this.entities, this.ephemeris);

    if (launch.mode === 'stage') {
      this.activeStage = initStage(
        launch.stage,
        this.player,
        this.entities,
        this._hud,
        this._sfx,
        this._scene,
        this.unlockManager,
        this.effects,
        this.markerManager,
      );
    } else {
      const creativeStage = new CreativeStage();
      creativeStage.setup(this._hud, this._sfx, this._scene, this.entities, this.unlockManager, this.effects, this.markerManager);
      creativeStage.setupCreative(this.markerManager, this.ephemeris);
      creativeStage.init(this.player, this.entities);
      this.activeStage = creativeStage;
    }

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

  // アクティブ艦(操作対象・追従カメラ・計画編集の対象)を差し替える。切替の副作用を
  // ここへ閉じ、各所有者はそれぞれの持ち分だけを更新する。
  setActivePlayer(ship: Player): void {
    this.player = ship;
    this.cameraSystem.setActivePlayer(ship);
    this.editor.setActiveShip(ship);
    this.targeter.clearTargets();
  }

  // ------------------------------------------------------------ update

  update(dtRaw: number): void {
    this.input.update();
    const dt = Math.min(dtRaw, 0.1);
    this.handleInput();

    this.navTarget.update(this.player, this.entities.enemies, this.ephemeris, this.simulator.simTime);
    const mapPickables = this.buildMapPickables();

    // handleInput より後に置く: ポーズ中も Esc・ヘルプなどは効かせる。
    if (this._isPaused) {
      if (this.editor.editMode) {
        this.editor.handleMapPointer(this.input);
        this.handleMapContextMenu(this.input, mapPickables);
        this.editor.updateEditing(dt, this.simulator.simTime, this.input);
      }
      this.cameraSystem.update(this.player, this.simulator.simTime, this.input, dt, mapPickables);
      return;
    }

    // behave が呼ばれなくなるので、決着時点の thrust が凍結され続けないよう明示的に消す。
    if (!this.activeStage.isPlaying) {
      this.player.thrust = null;
      this.player.torque = v3();
      const simDt = dt * Math.min(this.simSpeedManager.simSpeed, C.MAX_PHYS_SIM_SPEED);
      this.simulator.stepSimulation(dt, simDt, this.player, this.activeStage, false, false, false);
      this.nanWatchdog.checkAll('stepSimulation(決着後)', this.player, this.entities, this.simulator.simTime, dt, simDt);
      this.entities.cleanup(dt, this.simulator.simTime, this.activeStage, this.player.state.r, this.player);
      // 決着後もカメラ更新は飛ばせない: 飛ばすと視点だけが絶対 ECI に取り残され、
      // 軌道速度で遠ざかる原点(自機)から残骸が即座にフレームアウトする。
      this.cameraSystem.update(this.player, this.simulator.simTime, this.input, dt, mapPickables);
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

    this.entities.cleanup(dt, this.simulator.simTime, this.activeStage, this.player.state.r, this.player);

    // cleanup の後に呼ぶ: 死んだ個体を予測せず、積分後の実状態と突き合わせるため。
    this.predictor.update(this.simulator.simTime, this.player);

    // 物理積分の後に行う: 追従カメラの基準は sync 時のフローティングオリジン
    // (積分後の自機位置)と一致していなければならない。
    this.cameraSystem.update(
      this.player,
      this.simulator.simTime,
      this.input,
      dt,
      mapPickables,
    );

    this.editor.plan.trackAnchor(this.player.state);

    if (this.editor.editMode) {
      // 右クリックはノードを先に試し、外したぶんだけコンテキストメニューへ回る(優先順位はこの順序だけ)。
      this.editor.handleMapPointer(this.input);
      this.handleMapContextMenu(this.input, mapPickables);
      this.editor.updateEditing(dt, this.simulator.simTime, this.input);
    }
    else {
      this.targeter.updateCombatTargeting(
        this.player, this.entities.enemies, this.input, this.cameraSystem.activeCameraProjection,
      );
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
    // 戦闘ビューはアクティブ艦を前提とする。艦がまだ配置されていない/破壊されている間は無効。
    const canToggleView = this.player.alive;
    this.mapModeToggler.update(
      this.input, this.activeStage.isPlaying, this._isPaused, canToggleView,
      this.editor, this.touchControls, this.cameraSystem, this.displayTimeManager,
      this.mapContextGizmo,
    );
    this.editor.handleInput(this.input);
  }

  // 右クリックの最寄り候補(mapPickables → 近地点・遠地点アイコンの順)を探し、
  // 当たればその種別に応じた項目でコンテキストメニューを開いて消費する。
  private handleMapContextMenu(input: Input, mapPickables: readonly MapPickable[]): void {
    input.takeRightClicks((p) => {
      const target =
        this.cameraSystem.pickFocusCandidate(p.x, p.y, mapPickables) ??
        pickNearest(this.editor.planDisplay.apsisMarkers, p.x, p.y, this.cameraSystem.activeCameraProjection, C.MAP_PICK_PX_SQ);
      if (!target) return false;
      this.mapContextGizmo.openMenu(p.x, p.y, target, this.mapMenuItemsFor(target));
      return true;
    });
  }

  // 被選択物の種別に応じたコンテキストメニュー項目を返す。
  private mapMenuItemsFor(target: MapPickable): readonly MapMenuItem[] {
    switch (target.kind) {
      case 'body':
        return [
          { label: 'フォーカスを移動', act: 'focus' },
          { label: 'キャンセル', act: 'cancel' },
        ];
      case 'apsis':
        return [
          { label: 'ここにノードを追加', act: 'addNode' },
          { label: 'フォーカスを移動', act: 'focus' },
          { label: 'キャンセル', act: 'cancel' },
        ];
      case 'ship':
        return [
          { label: 'フォーカスを移動', act: 'focus' },
          { label: target.id === this.navTarget.id ? '航法ターゲット解除' : '航法ターゲットに設定', act: 'navTarget' },
          { label: 'キャンセル', act: 'cancel' },
        ];
      case 'creativeShip': {
        const ship = this.findCreativeShip(target.id);
        const following = ship?.followPlan ?? false;
        return [
          { label: '操作対象にする', act: 'activate' },
          { label: following ? '軌道計画への自動追従 OFF' : '軌道計画への自動追従 ON', act: 'followToggle' },
          { label: 'フォーカスを移動', act: 'focus' },
          { label: '削除', act: 'delete' },
          { label: 'キャンセル', act: 'cancel' },
        ];
      }
      case 'relnode':
        return [
          { label: 'ここまで時間加速', act: 'warp' },
          { label: 'ここにノードを追加', act: 'addNode' },
          { label: 'フォーカスを移動', act: 'focus' },
          { label: 'キャンセル', act: 'cancel' },
        ];
    }
  }

  // フォーカス/航法ターゲット選択の被選択物一覧(天体ラベル + 生存中の自機・敵船 +
  // 航法ターゲットの AN/DN アイコン)。船の位置は表示時刻の displayState — 機体メッシュや
  // 敵マーカーと同じ未来ゴースト位置に揃える。
  private buildMapPickables(): MapPickable[] {
    const orbitPeriod = this.player.elements?.period ?? null;
    const displayTime = this.displayTimeManager.resolveDisplayTime(orbitPeriod, this.simulator.simTime);
    const items: MapPickable[] = [...this.cameraSystem.focusMarkers.labels];
    // クリエイティブ艦(アクティブ艦含む)は下の creativeShips ループで 'creativeShip' として
    // 出すので、ここでは非クリエイティブ(ステージモード)の自機だけを 'ship' として出す。
    if (this.player.alive && !(this.player instanceof CreativeShip)) {
      const pos = this.player.displayState(displayTime)?.r;
      if (pos) items.push({ id: 'player', name: '自機', pos, kind: 'ship' });
    }
    for (const enemy of this.entities.enemies) {
      if (!enemy.alive) continue;
      const pos = enemy.displayState(displayTime)?.r;
      if (pos) items.push({ id: enemy.name, name: enemy.name, pos, kind: 'ship' });
    }
    for (const ship of this.entities.creativeShips) {
      if (!ship.alive) continue;
      const pos = ship.displayState(displayTime)?.r;
      if (pos) items.push({ id: ship.name, name: ship.name, pos, kind: 'creativeShip' });
    }
    items.push(...this.navTarget.mapPickables());
    return items;
  }

  // id で名指しされたクリエイティブ艦を探す。見つからなければ null。
  private findCreativeShip(id: string): CreativeShip | null {
    return this.entities.creativeShips.find((s) => s.name === id) ?? null;
  }

  private activateCreativeShip(id: string): void {
    const ship = this.findCreativeShip(id);
    if (!ship) return;
    this.setActivePlayer(ship);
    this._hud.hint(`${ship.name} を操作対象にする`);
  }

  private toggleCreativeShipFollowPlan(id: string): void {
    const ship = this.findCreativeShip(id);
    if (!ship) return;
    ship.followPlan = !ship.followPlan;
    this._hud.hint(`${ship.name}: 軌道計画への自動追従 ${ship.followPlan ? 'ON' : 'OFF'}`);
  }

  // 操作対象の艦は削除できない(削除すると自機が消える)。
  private deleteCreativeShip(id: string): void {
    const ship = this.findCreativeShip(id);
    if (!ship) return;
    if (ship === this.player) {
      this._hud.hint('操作対象の艦は削除できません');
      return;
    }
    this.entities.removeCreativeShip(ship);
    this._hud.hint(`${ship.name} を削除`);
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
    const secondaryTarget = this.targeter.aliveSecondaryTarget;

    this.environment.sync({
      dt,
      player: this.player,
      floatingOrigin: this.floatingOrigin,
      displayTime,
      cameraSystem: this.cameraSystem,
      celestialGridVisibility: this.navball.gridVisibility,
    });

    this.player.syncPlayer(this.floatingOrigin, this.cameraSystem, this.activeStage.isPlaying, this._isPaused, displayTime);

    this.entities.sync(this.floatingOrigin, displayTime, this.player);

    this.effects.sync(dt, this.simulator.lastSimDt, this.floatingOrigin, this.cameraSystem.activeCamera);

    this.targeter.sync(dt, this.floatingOrigin, this.player, this.entities.enemies, overviewMode, project);
    this.navTarget.sync(project);
    this.navball.sync(this.player.state, this.player.att, this.player.alive, target?.state ?? null);

    // 敵マーカーは1体では決められない(画面上で近接するものをまとめる)ので集合として渡す。
    // 位置は機体メッシュと同じ displayState — 揃えないと「機体は未来位置、マーカーは現在位置」に割れる。
    const aliveEnemies = this.entities.enemies.filter((enemy) => enemy.alive);
    const enemyMarkerItems: GroupedMarkerItem[] = [];
    for (const enemy of aliveEnemies) {
      const pos = enemy.displayState(displayTime)?.r;
      if (!pos) continue;
      const role: 'none' | 'primary' | 'secondary' =
        enemy === target ? 'primary' : enemy === secondaryTarget ? 'secondary' : 'none';
      enemyMarkerItems.push(enemy.markerItem(role, this.player.state.r, pos));
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
