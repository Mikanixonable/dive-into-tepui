// ゲーム全体のオーケストレーション: エンティティ管理、物理積分、
// 入力 → 推力/トルク変換、衝突判定、勝敗判定、描画同期。
//
// 座標系: ECI (慣性系)、Y軸 = 北極、単位 m / m/s。
// 描画は自機中心のフローティングオリジン(自機が常に (0,0,0))。
import * as THREE from 'three/webgpu';
import {
  Vec3,
} from '../physics/vec3';
import { sunAzimuth } from '../physics/ephemeris';
import { Player } from './player/player';
import { CameraSystem } from './camera/camera-system';
import { HitSystem } from './orbit-entity/hit';
import { Stage } from './stages/stage';
import { EphemerisSystem } from './ephemeris';
import { MarkerCtx, MarkerForGame } from './marker/marker-for-game';
import { MarkerManager } from './marker/marker-manager';
import { CollisionPhysics } from './orbit-entity/collision';
import { EffectsSystem } from './effects-system';
import { getStage, initStage } from './stages/stage-dictionary';
import { UnlockManager } from './unlock-manager';
import { Targeter } from './targeter';
import { PlanSystem } from './plan/plan-system';
import { MapMarkers } from './map-mode/map-markers';
import { SimSpeedManager } from './sim-speed-manager';
import { PipRenderer } from './pip-renderer';
import { Simulator } from './orbit-entity/simulator';
import { Input } from './input';
import { TouchControls } from './touch';
import { Hud } from '../hud/hud';
import { Sfx } from '../audio/sfx';
import { GameScene } from '../render/scene';
import { EnvironmentScene } from '../render/environment-scene';
import { MapModeToggler } from './map-mode/map-mode-toggler';

export class Game {
  private readonly _scene: THREE.Scene;
  private readonly renderer: GameScene['renderer'];

  private readonly input: Input;
  touchControls: TouchControls | null = null;
  private readonly _hud = new Hud();
  private readonly _sfx = new Sfx();
  private readonly markerManager = new MarkerManager(this._hud.root, this._hud.svgOverlay);
  // マップモードのフォーカス候補ラベル(地球・月・太陽・ラグランジュ点)。MapCamera が
  // フォーカス解決(ラベル ID → 座標)に、mapModeSystem がラベル一覧の更新・右クリメニュー
  // 候補に、それぞれ必要とするため game.ts が構築して両方へ注入する共有インスタンス。
  private readonly mapMarkers = new MapMarkers(this.markerManager);
  // hud.panels.update(this, ...) が Game インスタンスをまるごと受け取って状態を直接読むため、
  // panel.ts から参照されるフィールド(cameraSystem/player/activeStage/simulator/targeter 等)は
  // public にする。mapModeSystem のコンストラクタで MapCamera への参照を注入するため、
  // cameraSystem は mapModeSystem より前に構築する必要がある。
  readonly cameraSystem = new CameraSystem(this._hud, this._sfx, this.mapMarkers);
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

  // 軌道計画(ノード列+予測キャッシュ、Plan)は mapModeSystem が所有する。
  // マップモードの有無と無関係なデータだが、編集・保持ともマップモード側にしか
  // 出てこないため、実施(噴射ガイド=planGuide)へは mapModeSystem.plan 経由で注入する。
  // scene(_scene)はコンストラクタ引数 gs 由来で field initializer の時点では
  // 未確定のため、コンストラクタ本体で構築する(effects 等と同じ理由)。
  private readonly mapModeSystem: PlanSystem;
  readonly mapModeToggler: MapModeToggler;

  // 選択されたステージの振る舞い(初期化・毎フレーム処理・勝敗判定、stages/ 参照)。
  // 固有のランタイム状態(タイマー・ウェーブ管理等)もこれ自身が持つ。
  readonly activeStage: Stage;
  paused = false;

  // 天体暦(太陽・月の位置と日照率)。マップモード専用の geo/moon 参照軌道線も
  // scene 登録込みでここが持つため、コンストラクタ本体で構築する。
  private readonly ephemeris: EphemerisSystem;
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

  constructor(gs: GameScene, stage = 1) {
    this._scene = gs.scene;
    this.renderer = gs.renderer;
    this.ephemeris = new EphemerisSystem(this._scene);
    this.effects = new EffectsSystem(this._scene, (piece) => this.simulator.addDebris(piece));
    this.pipRenderer = new PipRenderer(this._scene);
    this.targeter = new Targeter(this._hud, this._sfx, this.markerManager, this._scene);
    this.mapModeSystem = new PlanSystem(
      this._hud,
      this._sfx,
      this.markerManager,
      this.simSpeedManager,
      this.cameraSystem.activeCameraProjection,
      this.cameraSystem.mapCamera,
      this.mapMarkers,
      this._scene,
      () => this.player.fineAttitude,
      () => ({ player: this.player, ephemeris: this.ephemeris, simTime: this.simulator.simTime })
    );
    this.mapModeToggler = new MapModeToggler(this._hud);

    this.input = new Input(gs.renderer.domElement);
    this.input.onFirstGesture = () => this._sfx.unlock();
    if (TouchControls.isTouchDevice()) this.touchControls = new TouchControls(this.input);
    this.wireHudCallbacks();

    this.simulator = new Simulator(this.ephemeris, this.hitSystem);

    this.ephemeris.update(this.simulator.simTime);
    this.environment = new EnvironmentScene(this._scene, this.ephemeris.sunDir);

    this.player = new Player(this._hud, this._sfx, this._scene, this.effects);

    this.activeStage = getStage(stage);
    this.activeStage.setup(this._hud, this._sfx, this._scene, this.simulator, this.unlockManager, this.effects);
    initStage(this.activeStage, this.player, this.simulator, this._hud);
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
    this.mapModeToggler.update(this.activeStage.isPlaying, this.mapModeSystem, this.touchControls, this.cameraSystem);

    // ゲームオーバー後もシミュレーションは進めるが、プレイヤーの入力は無効化し、
    // 積分もサブステップなしの簡略版(integrateSimulation の hardCollision/doSubstep 引数)にする。
    // behave が呼ばれなくなる分、勝敗確定時点の thrustFn が凍結され続けないよう明示的に消す。
    if (!this.activeStage.isPlaying) {
      this.player.thrustFn = null;
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

    // カメラ更新
    this.cameraSystem.update(
      this.player,
      sunAzimuth(this.simulator.simTime, this.ephemeris.sunPhase0),
      this.input,
      dt,
    );

    // プレイヤーの HP 回復・移動/発射の試行
    this.player.behave({
      dt,
      input: this.input,
      simSpeed: this.simSpeedManager,
      mapMode: this.cameraSystem.mapMode,
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

    if (this.cameraSystem.mapMode) {
      this.mapModeSystem.updateEditing(dt, this.input, this.player, this.ephemeris, this.simulator.simTime);
    }
    else {
      this.targeter.updateCombatTargeting(this.player, this.simulator.enemies, this.input, this.cameraSystem);
    }
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
        this.mapModeToggler.toggle(this.activeStage.isPlaying, this.mapModeSystem, this.touchControls, this.cameraSystem);
        break;
      // マップモード外でのみ、 [N] キーで直近ノードへの自動ワープをトグルする。
      case 'KeyN':
        if (!this.cameraSystem.mapMode)
          this.simSpeedManager.toggleAutoWarpToFirstNode(
            this.activeStage.isPlaying,
            this.mapModeSystem.editor.plan.firstNode());
        break;
      case 'KeyX': this.mapModeSystem.clearPlanByKey(this.cameraSystem.mapMode); break;
      case 'KeyH': this._hud.toggleHelp(); break;
      case 'Escape': this._hud.toggleSettings(); break;
      case 'KeyR': if (!this.activeStage.isPlaying) location.reload(); break;
    }
  }

  // ------------------------------------------------------------------ sync

  sync(dt: number): void {
    const o = this.player.state.r;
    const pv = this.player.state.v;
    const displayTime = this.mapModeSystem.display.resolveDisplayTime(this.cameraSystem.mapMode, this.player, this.simulator.simTime);
    this.environment.sync({
      dt,
      origin: o,
      displayTime,
      cameraSystem: this.cameraSystem,
      ephemeris: this.ephemeris,
    });
    
    this.player.sync(this.input, this.cameraSystem, this.activeStage.isPlaying, this.paused);

    this.simulator.sync(o, pv);

    this.effects.syncFlashEffects(dt, this.simulator.lastSimDt, o, this.cameraSystem.activeCamera);
    
    this.syncEntityOrbitLines(o, this.cameraSystem.mapMode);
    this.syncMarkers(dt, o, pv);

    this._hud.panels.update(this, dt);
    this._hud.tick();
  }

  // 自機・敵の軌道線は各 entity 自身が持つ(Player/Enemy コンストラクタ参照)ため、
  // ここでは毎フレームの Elements 算出と update() 呼び出しだけを行う。
  private syncEntityOrbitLines(o: Vec3, mapMode: boolean): void {
    const playerEl = this.player.elements;
    this.player.orbitLine.update(this.player.alive ? playerEl : null, o, this.player.thrustVizDir !== null, true);
    const tgt = this.targeter.aliveTarget;
    for (const enemy of this.simulator.enemies) {
      const showGray = mapMode && enemy.alive && enemy !== tgt;
      enemy.orbitLine.update(showGray ? enemy.elements : null, o);
    }
    this.targeter.updateOrbitLine(o);
  }

  // MarkersSystem の各メソッド呼び出しに渡す、現在状態のスナップショット。
  private markerCtx(): MarkerCtx {
    return {
      mapMode: this.cameraSystem.mapMode,
      player: this.player,
      enemies: this.simulator.enemies,
      target: this.targeter.autoTarget,
      ammos: this.simulator.ammos,
      mapLabelIds: this.mapModeSystem.mapLabelIds(),
      activeCamera: this.cameraSystem.activeCamera,
      simTime: this.simulator.simTime,
    };
  }

  private syncMarkers(dt: number, o: Vec3, pv: Vec3): void {
    const project = this.cameraSystem.activeCameraProjection;
    const mapMode = this.cameraSystem.mapMode;

    this.mapModeSystem.updateDisplay(mapMode, this.player, this.ephemeris, this.simulator.simTime);

    this.ephemeris.updateReferenceLines(this.simulator.simTime, o, mapMode);

    this.markersSystem.updateMarkers(this.markerCtx(), pv, project);
    this.markersSystem.updateNodeMarkers(this.player, this.targeter.aliveTarget, project);
    this.targeter.updateBoardMarkers(this.player, dt, project);
    if (mapMode) {
      this.markerManager.hide('burn');
    } else {
      this.mapModeSystem.guide.update(this.mapModeSystem.editor.plan, this.player, this.ephemeris, this.simulator.simTime, this.simSpeedManager, project);
    }
  }

  // ------------------------------------------------------------------ render

  render(): void {
    // 通常の全画面描画
    this.renderer.render(this._scene, this.cameraSystem.activeCamera);

    // PIP 描画
    this.pipRenderer.renderPip(this.renderer, {
      renderPip: this.player.isFiring && !this.cameraSystem.mapMode,
      camera: this.cameraSystem.activeCamera,
      playerShipObj: this.player.obj,
      setMuzzleFlashesVisible: (visible) => this.effects.setMuzzleFlashesVisible(visible),
      updateOverlay: (rect) => this.markersSystem.updatePipOverlay(this.targeter.autoTarget, this.player, this.cameraSystem.activeCamera, rect),
    });
  }
}
