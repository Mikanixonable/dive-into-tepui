// ゲーム全体のオーケストレーション: エンティティ管理、物理積分、
// 入力 → 推力/トルク変換、衝突判定、勝敗判定、描画同期。
//
// 座標系: ECI (慣性系)、Y軸 = 北極、単位 m / m/s。
// 描画は自機中心のフローティングオリジン(自機が常に (0,0,0))。
import * as THREE from 'three/webgpu';
import { FloatingOrigin } from './floating-origin';
import { v3 } from '../physics/vec3';
import { Player } from './player/player';
import { CameraSystem } from './camera/camera-system';
import { HitSystem } from './orbit-entity/hit';
import { Stage, StageId } from './stages/stage';
import { MarkerCtx, MarkerForGame } from './marker/marker-for-game';
import { MarkerManager } from './marker/marker-manager';
import { CollisionPhysics } from './orbit-entity/collision';
import { EffectsSystem } from './vfx/effects-system';
import { initStage } from './stages/stage-dictionary';
import { UnlockManager } from './unlock-manager';
import { Targeter } from './targeter';
import { PlanSystem } from './plan/plan-system';
import { SimSpeedManager } from './sim-speed-manager';
import { PipRenderer } from './pip-renderer';
import { Simulator } from './orbit-entity/simulator';
import { Input } from './input/input';
import { TouchControls } from './input/touch';
import { Hud } from './hud/hud';
import { Sfx } from '../audio/sfx';
import { GameScene } from '../render/scene';
import { EnvironmentScene } from '../render/environment-scene';
import { Ephemeris } from '../physics/ephemeris';
import { MapModeToggler } from './map-mode-toggler';

export class Game {
  private readonly _scene: THREE.Scene;
  private readonly renderer: GameScene['renderer'];
  private floatingOrigin: FloatingOrigin;
  private readonly input: Input;
  touchControls: TouchControls | null = null;
  private readonly _hud = new Hud();
  private readonly _sfx = new Sfx();
  private readonly markerManager = new MarkerManager(this._hud.root, this._hud.svgOverlay);
  // 太陽・月の天体暦(状態を持たない純サンプラ)。environment/simulator/cameraSystem/
  // planSystem がこの単一インスタンスを共有参照する。cameraSystem など field initializer で
  // 注入する先より前に確定させる必要があるため、ここで最初に構築する。
  private readonly ephemeris = new Ephemeris();
  // hud.panels.update(this, ...) が Game インスタンスをまるごと受け取って状態を直接読むため、
  // panel.ts から参照されるフィールド(cameraSystem/player/activeStage/simulator/targeter 等)は
  // public にする。planSystem のコンストラクタで MapCamera・mapMarkers への参照を注入する
  // ため、cameraSystem は planSystem より前に構築する必要がある。
  // マップモードのフォーカス候補ラベル(地球・月・太陽・ラグランジュ点)とその選択 UI は
  // 「どこを注視するか」= mapCamera 寄りの責務なので cameraSystem が所有する。
  readonly cameraSystem = new CameraSystem(this._hud, this._sfx, this.markerManager, this.ephemeris);
  readonly player: Player;
  // ?perf=1 のデバッグ表示用エンティティ数。
  perfCounts(): { enemies: number; bullets: number; casings: number; debris: number; } {
    return {
      enemies: this.simulator.enemies.length,
      bullets: this.simulator.bullets.length,
      casings: this.simulator.casings.length,
      debris: this.simulator.debris.length,
    };
  }


  // シミュレーション速度(HUD ヒント・SFX 上は「ワープ」と呼ぶ、sfx.warp() 参照)の
  // 段階管理と、[N] キーによるノードへの自動ワープ。
  readonly simSpeedManager = new SimSpeedManager(this._hud, this._sfx);

  // 直近ノードの噴射ガイド(戦闘ビューのみ、マップモード中は呼ばない — [M] で開いている
  // 間は WASDQE がΔv編集に使われるため)。scene に計画軌道ラインを持つため
  // コンストラクタ本体で構築する(effects 等と同じ理由)。

  // 軌道計画(ノード列+予測キャッシュ、Plan)は planSystem が所有する。
  // マップモードの有無と無関係なデータだが、編集・保持ともマップモード側にしか
  // 出てこないため、実施(噴射ガイド=planGuide)へは planSystem.plan 経由で注入する。
  // scene(_scene)はコンストラクタ引数 gs 由来で field initializer の時点では
  // 未確定のため、コンストラクタ本体で構築する(effects 等と同じ理由)。
  private readonly planSystem: PlanSystem;
  readonly mapModeToggler: MapModeToggler;

  // 選択されたステージの振る舞い(初期化・毎フレーム処理・勝敗判定、stages/ 参照)。
  // 固有のランタイム状態(タイマー・ウェーブ管理等)もこれ自身が持つ。
  readonly activeStage: Stage;
  paused = false;

  // 空の天体・地球・環境光・参照軌道線をまとめて所有する描画系。天体暦は上の ephemeris を
  // 共有参照する(所有はしない)。
  private readonly environment: EnvironmentScene;

  private readonly unlockManager = new UnlockManager();
  private readonly hitSystem = new HitSystem();
  private readonly markersSystem = new MarkerForGame(this.markerManager);
  private readonly collisionPhysics = new CollisionPhysics();
  // フラッシュ・破片エフェクトのスポーン窓口(effects-system.ts)。scene への注入・
  // FlashEffectManager の所有もここに一元化されており、Player/Enemy/PlayerFire は
  // scene を持ち回さずに済む。scene(_scene)はコンストラクタ引数 gs 由来で field
  // initializer の時点では未確定のため、コンストラクタ本体で構築する(environment/player
  // と同じ理由)。
  private readonly effects: EffectsSystem;
  readonly targeter: Targeter;
  readonly simulator: Simulator;
  private readonly pipRenderer: PipRenderer;

  constructor(gs: GameScene, stageId: StageId = '1') {
    this._scene = gs.scene;
    this.renderer = gs.renderer;
    this.effects = new EffectsSystem(this._scene, (piece) => this.simulator.addDebris(piece));
    this.pipRenderer = new PipRenderer(this._scene);
    this.targeter = new Targeter(this._hud, this._sfx, this.markerManager, this._scene);
    this.environment = new EnvironmentScene(this._scene, this.ephemeris);
    this.planSystem = new PlanSystem(
      this._hud,
      this._sfx,
      this.markerManager,
      this.simSpeedManager,
      this.cameraSystem.activeCameraProjection,
      this.cameraSystem.mapCamera,
      this.cameraSystem.mapMarkers,
      this._scene,
      () => this.player.fineAttitude,
      this.ephemeris,
    );
    // ノードハンドル直接右クリックは、canvas 右クリックと同じフォールバック調停に流す。
    this.planSystem.onNodeHandleRightClick = (x, y) => this.dispatchMapRightClick(x, y);
    this.mapModeToggler = new MapModeToggler(this._hud);

    this.input = new Input(gs.renderer.domElement);
    this.input.onFirstGesture = () => this._sfx.unlock();
    if (TouchControls.isTouchDevice()) this.touchControls = new TouchControls(this.input);
    this.wireHudCallbacks();

    this.simulator = new Simulator(this.ephemeris, this.hitSystem);

    this.player = new Player(this._hud, this._sfx, this._scene, this.effects);

    this.activeStage = initStage(
      stageId,
      this.player,
      this.simulator,
      this._hud,
      this._sfx,
      this._scene,
      this.unlockManager,
      this.effects,
    );

    this.floatingOrigin = new FloatingOrigin(this.player.state.r, this.player.state.v);
  }

  private wireHudCallbacks(): void {
    this._hud.setBgmState(this._sfx.isBgmEnabled());
    this._hud.onBgmToggle = (on) => this._sfx.setBgmEnabled(on);
    // ⚙ギアクリック・[閉じる]・[Esc] いずれの経路で開閉しても一時停止フラグを同期する
    this._hud.onSettingsOpenChange = (open) => {
      this.paused = open;
    };
    // 「ゲームを中断してタイトル画面に戻る」— ?stage= クエリを落として選択画面へ
    this._hud.onQuitToTitle = () => {
      location.assign(location.pathname);
    };
  }

  // ------------------------------------------------------------ update

  // per frameの論理値更新
  update(dtRaw: number): void {
    this.input.update();
    const dt = Math.min(dtRaw, 0.1);
    this.handleEdgeInput();
    this.mapModeToggler.update(this.activeStage.isPlaying, this.planSystem, this.touchControls, this.cameraSystem);

    // ゲームオーバー後もシミュレーションは進めるが、プレイヤーの入力は無効化し、
    // 積分もサブステップなしの簡略版(integrateSimulation の hardCollision/doSubstep 引数)にする。
    // behave が呼ばれなくなる分、勝敗確定時点の thrustFn が凍結され続けないよう明示的に消す。
    if (!this.activeStage.isPlaying) {
      this.player.thrustFn = null;
      this.player.torque = v3();
      const simDt = dt * Math.min(this.simSpeedManager.simSpeed, 4);
      this.simulator.stepSimulation(dt, simDt, this.player, this.activeStage, false, false);
      return;
    }

    // ポーズ中の処理
    if (this.paused) {
      this.simulator.lastSimDt = 0;
      this._sfx.setThrust(false);
      this.player.pause();
      return;
    }

    // プレイヤーの HP 回復・移動/発射の試行
    this.player.behave({
      dt,
      input: this.input,
      simSpeed: this.simSpeedManager,
      editMode: this.planSystem.editMode,
      scoreCounter: this.activeStage.scoreCounter,
      simTime: this.simulator.simTime,
      zoomActive: this.cameraSystem.zoomActive,
      addBullet: (bullet) => this.simulator.addBullet(bullet),
    });

    // ステージの更新 (敵の行動・スポーン管理・スコア加算・勝敗判定を含む)
    this.activeStage.update(dt, this.player, this.simulator, this.simulator.simTime, this.simSpeedManager);

    this.simSpeedManager.update(this.simulator.simTime);
    const simDt = dt * this.simSpeedManager.simSpeed;
    this.simulator.stepSimulation(dt, simDt, this.player, this.activeStage, true, true);

    // 衝突判定
    if (this.simSpeedManager.canResolvePhysicalCollisions) {
      this.collisionPhysics.resolve(dt, this.player, this.simulator.allEntities(), () => this._sfx.clank());
    }

    this.targeter.markBoardCrossings(this.player, this.simulator);

    this.player.checkLoss(dt, this.simulator.simTime, this.activeStage);

    this.simulator.cleanup(dt, this.activeStage);

    // カメラ更新は物理積分の後に行う: 追従カメラは自機を絶対 ECI 座標で追い、その基準は
    // sync 時のフローティングオリジン(積分後の自機位置)と一致していなければならない。
    this.cameraSystem.update(
      this.player,
      this.simulator.simTime,
      this.input,
      dt,
    );

    // 計画が空の間、予定 player の起点を現在状態へ追従させる(最初のノードで凍結)。
    this.planSystem.trackAnchor(this.player, this.simulator.simTime);

    if (this.planSystem.editMode) {
      this.dispatchMapPointer();
      this.planSystem.updateEditing(dt, this.input, this.player, this.simulator.simTime);
    }
    else {
      this.targeter.updateCombatTargeting(this.player, this.simulator.enemies, this.input, this.cameraSystem);
    }
  }

  // マップモードのポインタ操作を各サブシステムへ振り分ける。ノード編集(plan)と
  // フォーカス選択(camera)は本来独立した責務で、共有するのは「右クリックの取り合い」
  // だけ — ノードが消費しなかった右クリックだけをフォーカス選択へフォールバックさせる
  // この調停をここ(上位)に集約し、各サブシステムは互いを知らずに済ませる。
  private dispatchMapPointer(): void {
    for (const c of this.input.clicks()) {
      this.cameraSystem.closeFocusMenu();
      this.planSystem.handleMapClick(c.x, c.y);
    }
    for (const rc of this.input.rightClicks()) {
      this.dispatchMapRightClick(rc.x, rc.y);
    }
  }

  private dispatchMapRightClick(x: number, y: number): void {
    if (this.planSystem.handleNodeRightClick(x, y)) this.cameraSystem.closeFocusMenu();
    else this.cameraSystem.handleFocusRightClick(x, y);
  }

  // --------------------------------------------------------------- input

  private handleEdgeInput(): void {
    for (const code of this.input.presses()) {
      this.handleEdgePress(code);
    }
  }

  private handleEdgePress(code: string): void {
    switch (code) {
      case 'KeyG': this.cameraSystem.chaseCamera.toggleFollowAttitude(); break;
      case 'Comma': this.simSpeedManager.shift(-1); break;
      case 'Period': this.simSpeedManager.shift(1); break;
      case 'KeyM':
        this.mapModeToggler.toggle(this.activeStage.isPlaying, this.planSystem, this.touchControls, this.cameraSystem);
        break;
      // 計画編集中は WASDQE などが Δv 編集に使われるため、[N] の自動ワープはその外でのみ働く。
      case 'KeyN':
        if (!this.planSystem.editMode)
          this.simSpeedManager.toggleAutoWarpToFirstNode(
            this.activeStage.isPlaying,
            this.planSystem.editor.plan.firstNode());
        break;
      case 'KeyX': this.planSystem.clearPlanByKey(this.planSystem.editMode); break;
      case 'KeyH': this._hud.toggleHelp(); break;
      case 'Escape': this._hud.toggleSettings(); break;
      case 'KeyR': if (!this.activeStage.isPlaying) location.reload(); break;
    }
  }

  // ------------------------------------------------------------------ sync

  sync(dt: number): void {
    // 設定し、sync 系全体へ共通の基準として渡す。player.state とは意味論的に別物 —
    // 将来この原点を別の点(カメラ座標など)へ差し替えても描画が破綻しないよう、
    // 各 sync はこの fo だけを参照し player.state.r を描画原点として直接使わない。
    this.floatingOrigin = new FloatingOrigin(this.player.state.r, this.player.state.v);

    // カメラ姿勢を THREE.js に反映するのを最初に行う: environment.sync や
    // マーカー投影(activeCameraProjection)がこのフレームのカメラ行列を読むため。
    this.cameraSystem.sync(this.floatingOrigin);
    const displayTime = this.planSystem.predict.resolveDisplayTime(
      this.cameraSystem.mapMode,
      this.player.elements?.period ?? null,
      this.simulator.simTime,
    );
    this.environment.sync({
      dt,
      player: this.player,
      floatingOrigin: this.floatingOrigin,
      displayTime,
      cameraSystem: this.cameraSystem,
    });

    this.player.syncPlayer(this.floatingOrigin, this.cameraSystem, this.activeStage.isPlaying, this.paused);

    this.simulator.sync(this.floatingOrigin);

    this.effects.syncFlashEffects(dt, this.simulator.lastSimDt, this.floatingOrigin, this.cameraSystem.activeCamera);

    this.syncEntityOrbitLines(this.floatingOrigin, this.cameraSystem.mapMode);
    this.syncMarkers(dt, this.floatingOrigin);

    this._hud.panels.update(this, dt);
    this._hud.tick();
  }

  // 自機・敵の軌道線は各 entity 自身が持つ(Player/Enemy コンストラクタ参照)ため、
  // ここでは毎フレームの Elements 算出と update() 呼び出しだけを行う。
  private syncEntityOrbitLines(fo: FloatingOrigin, mapMode: boolean): void {
    const playerEl = this.player.elements;
    // 自機軌道線は「高精度で描きたい点」付近の頂点を密にする(focusPos)。本来これは
    // フローティングオリジン(≒カメラ近傍、単精度でも破綻させたくない領域)であるべきだが、
    // fo が微動するたびに軌道線を再生成すると破綻するため、妥協として自機位置を密点に渡す。
    this.player.orbitLine.sync(this.player.alive ? playerEl : null, fo, this.player.thrustVizDir !== null, this.player.state.r);
    const tgt = this.targeter.aliveTarget;
    for (const enemy of this.simulator.enemies) {
      const showGray = mapMode && enemy.alive && enemy !== tgt;
      enemy.orbitLine.sync(showGray ? enemy.elements : null, fo);
    }
    this.targeter.syncOrbitLine(fo);
  }

  // MarkersSystem の各メソッド呼び出しに渡す、現在状態のスナップショット。
  private markerCtx(): MarkerCtx {
    return {
      mapMode: this.cameraSystem.mapMode,
      player: this.player,
      enemies: this.simulator.enemies,
      target: this.targeter.autoTarget,
      ammos: this.simulator.ammos,
      mapLabelIds: this.planSystem.mapLabelIds(),
      simTime: this.simulator.simTime,
    };
  }

  private syncMarkers(dt: number, fo: FloatingOrigin): void {
    const project = this.cameraSystem.activeCameraProjection;
    const mapMode = this.cameraSystem.mapMode;

    this.planSystem.updateDisplay(mapMode, fo, this.player, this.ephemeris, this.simulator.simTime);

    this.environment.syncReferenceLines(this.simulator.simTime, fo, mapMode);

    this.markersSystem.updateMarkers(this.markerCtx(), project);
    this.markersSystem.updateNodeMarkers(this.player, this.targeter.aliveTarget, project);
    this.targeter.syncBoardMarkers(dt, project);
    if (mapMode) {
      this.markerManager.hide('burn');
    } else {
      this.planSystem.guide.update(this.planSystem.editor.plan, this.player, this.simulator.simTime, this.simSpeedManager, project);
    }
  }

  // ------------------------------------------------------------------ render

  render(): void {
    // 通常の全画面描画
    this.renderer.render(this._scene, this.cameraSystem.activeCamera);

    // PIP 描画
    this.pipRenderer.renderPip(this.renderer, {
      renderPip: this.player.isFiring && !this.cameraSystem.mapMode,
      pipCamera: this.cameraSystem.pipCamera,
      playerShipObj: this.player.obj,
      setMuzzleFlashesVisible: (visible) => this.effects.setMuzzleFlashesVisible(visible),
      updateOverlay: (rect) => this.markersSystem.updatePipOverlay(
        this.targeter.autoTarget, this.player, this.cameraSystem.pipCamera.projection, rect,
      ),
    });
  }
}
