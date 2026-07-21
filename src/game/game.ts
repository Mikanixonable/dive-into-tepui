// ゲーム全体のオーケストレーション: エンティティ管理、物理積分、
// 入力 → 推力/トルク変換、衝突判定、勝敗判定、描画同期。
//
// 座標系: ECI (慣性系)、Y軸 = 北極、単位 m / m/s。
// 描画は自機中心のフローティングオリジン(自機が常に (0,0,0))。
import * as THREE from 'three/webgpu';
import {
  Vec3,
} from '../physics/vec3';
import { Elements, elementsFromState } from '../physics/orbital';
import { sunAzimuth } from '../physics/ephemeris';
import { Player } from './player/player';
import { FireCtx } from './player/player-fire';
import { CameraSystem } from './camera/camera-system';
import { HitCtx, HitSystem } from './combat/hit';
import { CombatCtx, StageCtx, StageDefinition } from './stages/stage-definition';
import { EphemerisSystem } from './ephemeris';
import { MarkerCtx, MarkersSystem } from '../hud/markers';
import { CollisionPhysics } from './combat/collision';
import { EffectsCtx, EffectsSystem } from './effects-system';
import { getStageDefinition, resolveStageInitData } from './stages/stage-data';
import { UnlockManager } from './unlock-manager';
import { Targeter } from './combat/targeter';
import { HudProjection } from './camera/projection';
import { MapModeSystem } from './map-mode/map-mode-system';
import { Plan, PlanCtx } from './plan/plan';
import { PlanGuide } from './plan/plan-guide';
import { SimSpeedManager } from './sim-speed-manager';
import { PipRect, PipRenderer } from './pip-renderer';
import { Simulator, SimulatorCtx } from './combat/simulator';
import * as C from './const';
import { EnemyAiCtx } from './enemy/enemy';
import { Input } from './input';
import { TouchControls } from './touch';
import { Hud } from '../hud/hud';
import { Sfx } from '../audio/sfx';
import { GameScene } from '../render/scene';
import { EnvironmentScene } from '../render/environment-scene';

type GamePhase = 'playing' | 'won' | 'lost' | 'timeup';

export class Game {
  private readonly _scene: THREE.Scene;
  private readonly renderer: GameScene['renderer'];

  private readonly input: Input;
  // HudPanels が状態を直接参照するため public(下記 hud.panels.update 呼び出し参照)。
  touchControls: TouchControls | null = null;
  private readonly _hud = new Hud();
  private readonly _sfx = new Sfx();
  // 戦闘ビュー(ChaseCamera)とマップビュー(MapCamera)を切り替えて駆動する
  // (mapModeSystem のコンストラクタで MapCamera への参照を注入するため、
  // mapModeSystem より前に構築する必要がある)。panel.ts が chase.camFollowAttitude を
  // 読むため public(旧 readonly chase フィールドと同じ可視性)。
  readonly cameraSystem = new CameraSystem(this._hud, this._sfx);


  readonly player: Player;
  // enemies / bullets / plasmaBullets / casings / debris の各エンティティ配列は
  // Simulator が所有する(this.simulator.enemies 等)。追加は simulator.addXxx 経由。
  // フラッシュエフェクト配列(effects)は effectsSystem が所有する。

  // ?perf=1 のデバッグ表示用エンティティ数(軽量化計画ステップ0)。挙動には影響しない。
  perfCounts(): { enemies: number; bullets: number; casings: number; debris: number; } {
    return {
      enemies: this.simulator.enemies.length,
      bullets: this.simulator.bullets.length,
      casings: this.simulator.casings.length,
      debris: this.simulator.debris.length,
    };
  }

  private readonly environment: EnvironmentScene;

  //readonly stage: number;

  // シミュレーション速度(旧「ワープ」)の段階管理と、[N] キーによるノードへの自動ワープ
  readonly simSpeedManager = new SimSpeedManager(this._hud, this._sfx);

  // 軌道計画(ノード列+予測キャッシュ)。マップモードの有無と無関係なデータで、
  // Game が所有し、表示・編集は mapModeSystem へ、実施(噴射ガイド)は planGuide へ
  // それぞれ「注入」する — plan-mode/plan.ts 参照。
  private readonly plan = new Plan();
  // 直近ノードの噴射ガイド(戦闘ビューのみ、マップモード中は呼ばない — [M] で開いている
  // 間は WASDQE がΔv編集に使われるため)。scene に計画軌道ラインを持つため
  // コンストラクタ本体で構築する(effectsSystem 等と同じ理由)。
  private readonly planGuide: PlanGuide;

  // 軌道計画モード(map-mode/ フォルダの唯一の外部窓口)
  private readonly mapModeSystem = new MapModeSystem(
    this._hud,
    this._sfx,
    this.simSpeedManager,
    this.plan,
    (rel: Vec3) => this.hudProjection.project(rel),
    this.cameraSystem.mapCamera,
    () => this.player.fineAttitude,
    () => this.planCtx(),
  );

  private phase: GamePhase = 'playing';
  // 選択されたステージの振る舞い(初期化・毎フレーム処理・勝敗判定)を持つインスタンス
  // (stages/ 参照)。固有のランタイム状態(タイマー・ウェーブ管理等)もこれ自身が持つ。
  readonly activeStage: StageDefinition;
  simTime = 0;
  private lastSimDt = 0;
  paused = false;

  //private zoomActive = false;

  // 天体暦(太陽・月の位置と日照率)は ephemeris.ts に切り出し済み。マップモード専用の
  // geo/moon 参照軌道線も scene 登録込みでここが持つため、コンストラクタ本体で構築する。
  private readonly ephemeris: EphemerisSystem;

  // --- 弾薬・マガジン ---
  // マガジンベルト(表示メッシュ + Verlet 物理)は弾薬状態に密結合なため
  // player/player-fire.ts の PlayerFire が所有する(this.player.updateBelt 等)。
  // 発射・排莢・バレル交換の演出も PlayerFire が持つ(fireCtx 経由)。
  // 撃破の集計・勝敗判定・発射/命中/撃破カウンタは activeStage(StageDefinition)が持つ
  // (killCounter フィールド、recordKill/recordKilled メソッド)。
  private readonly unlockManager = new UnlockManager();
  // 弾の高度な衝突判定(トンネリング防止・被弾ダメージ)は combat/hit.ts の HitSystem に
  // 切り出し済み。撃破が発生したら activeStage.recordKill を呼ぶ(ctx 経由、状態は持たない)。
  private readonly hitSystem = new HitSystem();
  // HUDマーカー(方向・敵/リード/AMMO/ノード/PIP/ボード)の同期は markers.ts の
  // MarkersSystem に切り出し済み。boardMarks(標的面通過点)もここが保持する
  // (combat/hit.ts の checkBoardCrossings が直接この配列へ push する)。
  // ステータスパネルは hud.panels が担う。
  private readonly markersSystem = new MarkersSystem(this._hud.markers);
  private readonly collisionPhysics = new CollisionPhysics();
  // scene(_scene)はコンストラクタ引数 gs 由来で field initializer の時点では未確定のため、
  // これらはコンストラクタ本体で構築する(environment/player と同じ理由)。
  private readonly effectsSystem: EffectsSystem;
  readonly targeter: Targeter;
  private readonly hudProjection = new HudProjection(() => this.cameraSystem.activeCamera);
  readonly simulator: Simulator;
  private readonly pipRenderer: PipRenderer;

  constructor(gs: GameScene, stage = 1) {
    this._scene = gs.scene;
    this.renderer = gs.renderer;
    this.ephemeris = new EphemerisSystem(this._scene);
    this.effectsSystem = new EffectsSystem(this._scene);
    this.pipRenderer = new PipRenderer(this._scene);
    this.targeter = new Targeter(this._hud, this._sfx, this._scene);
    this.planGuide = new PlanGuide(this._hud, this._sfx, this._scene);

    this.activeStage = getStageDefinition(stage);

    this.input = new Input(gs.renderer.domElement);
    this.input.onFirstGesture = () => this._sfx.unlock();
    if (TouchControls.isTouchDevice()) this.touchControls = new TouchControls(this.input);
    this.wireHudCallbacks();
    this.simulator = new Simulator(this.ephemeris, this.hitSystem);
    this.activeStage.setup(this._hud, this._sfx, this._scene, this.simulator);

    // --- 環境 ---
    this.ephemeris.update(this.simTime);
    this.environment = new EnvironmentScene(this._scene, this.ephemeris.sunDir, {
      sunIntensity: C.SUN_INTENSITY,
      ambientIntensity: C.AMBIENT_INTENSITY,
      shadowMinSun: C.SHADOW_MIN_SUN,
      shadowMinAmbient: C.SHADOW_MIN_AMBIENT,
    });

    this._scene.add(this.mapModeSystem.trajLineGroup);

    // --- 自機: 高度420km・傾斜51.6°の円軌道 ---
    this.player = new Player(this._hud, this._sfx, this._scene);

    this.initStage();
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

  // ステージ別の初期敵配置・初期弾薬・初期補給の配置と作戦目標のブリーフィング表示
  // (ステージごとの分岐は stage-data.ts の StageDefinition.init が直接行う)。
  private initStage(): void {
    const enemyCount = this.activeStage.init(this.stageCtx());
    const data = resolveStageInitData(this.activeStage, enemyCount);
    this.player.initAmmo(data.magsLeft, data.roundsInMag);
    this._hud.toast(data.briefingHtml, 12000);
  }

  // Plan(軌道計画)の refresh() や PlanGuide が要求する「現在状態」のスナップショット。
  private planCtx(): PlanCtx {
    return {
      simTime: this.simTime,
      playerR: this.player.state.r,
      playerV: this.player.state.v,
      sunPhase0: this.ephemeris.sunPhase0,
      moonPhase0: this.ephemeris.moonPhase0,
    };
  }

  // ズームウィンドウ(PIP)描画中、マズルフラッシュを非表示にする(pip-renderer.ts から
  // playerShipObj.visible=false と同じタイミングで呼ばれる)。this.effects には被弾スパーク・
  // 撃破爆発のフラッシュも入っているため、muzzle フラグ付きのものだけを切り替える
  // (ズーム中でも敵側の命中・爆発の閃光は照準フィードバックとして見せたい)。
  private setMuzzleFlashesVisible(v: boolean): void {
    for (const fx of this.effectsSystem.effects) if (fx.muzzle) fx.mesh.visible = v;
  }

  // ---------------------------------------------------------------- update

  update(dtRaw: number): void {
    const dt = Math.min(dtRaw, 0.1);
    this.cameraSystem.zoomActive = !this.cameraSystem.mapMode && this.input.down('KeyZ');
    this.handleEdgeInput();
    this.cameraSystem.mapMode = this.mapModeSystem.syncMapModeWithPhase(this.phase, this.touchControls, this.cameraSystem.mapMode);

    this.handleFrame(dt);

    this.pipRenderer.syncFineAttitude(
      this.player.isFiring,
      (prevFiring, nowFiring) => this.player.setFineAttitudeFromFiring(prevFiring, nowFiring),
    );
  }

  private handleFrame(dt: number): void {
    if (this.phase === "playing" && this.paused) {
      this.handlePausedFrame();
      return;
    }
    // ゲームオーバー以降等場合、シミュレーションは進めるが、プレイヤーのアクションは無効化する。
    // シミュレーションも簡略化する
    if (this.phase !== 'playing') {
      const advanced = this.simulator.integrateSimulation(
        this.simTime,
        dt,
        this.simSpeedManager.simSpeed,
        this.simulatorCtx(),
        false,
        false,
      );
      this.simTime = advanced.simTime;
      this.lastSimDt = advanced.simDt;
      return;
    }

    this.updateFrame(dt);
  }

  private updateFrame(dt: number): void {
    this.simSpeedManager.update(this.simTime);
    const simSpeed = this.simSpeedManager.simSpeed;
    const simDt = dt * simSpeed;
    // プレイヤーの HP 回復・移動/発射の試行
    const action = this.player.behave({
      dt,
      input: this.input,
      canPlayerThrust: this.simSpeedManager.canPlayerThrust,
      canPlayerFire: this.simSpeedManager.canPlayerFire,
      mapMode: this.cameraSystem.mapMode,
      killCounter: this.activeStage.killCounter,
      fireCtx: this.fireCtx(),
    });
    const playerAccel = this.simulator.buildPlayerAccel(action.thrustFn);

    const advanced = this.simulator.integrateSimulation(
      this.simTime,
      dt,
      simSpeed,
      this.simulatorCtx(),
      true,
      true,
      playerAccel,
    );
    this.simTime = advanced.simTime;
    this.lastSimDt = advanced.simDt;

    this.handlePostSimulation(dt, simDt);

    if (this.cameraSystem.mapMode) {
      this.mapModeSystem.updateEditing(dt, this.input);
    }
    else {
      this.targeter.updateCombatTargeting(
        {
          player: this.player,
          enemies: this.simulator.enemies,
          input: this.input,
          activeCamera: this.cameraSystem.activeCamera,
          project: (rel) => this.hudProjection.project(rel),
        });
    }

    this.activeStage.update(dt, this.stageCtx());
  }

  private handlePausedFrame(): void {
    this.lastSimDt = 0;
    this._sfx.setThrust(false);
    this.player.pause();
    this.input.takeClicks();
    this.input.takeRightClicks();
  }

  // [X] キー: マップモード中は選択中ノードのみ(mapModeSystem 側の責務)、
  // マップ外では計画全体を破棄する。Plan を直接持つのは Game なので、
  // 全破棄はここが受け持つ(mapModeSystem にマップ外の状態を持たせないため)。
  private clearPlanByKey(): void {
    if (this.cameraSystem.mapMode) {
      this.mapModeSystem.deleteSelectedNode();
      return;
    }
    if (this.plan.nodes.length <= 0) return;
    this.plan.clear();
    this.planGuide.clearActiveTarget();
    this.simSpeedManager.cancelAutoWarp();
    this._hud.hint('マニューバ計画を破棄');
  }

  private handleEdgeInput(): void {
    const presses = this.input.takePresses();
    const unconsumedPresses = this.player.handleEdgeInput(presses, this.fireCtx());
    for (const code of unconsumedPresses) {
      this.handleEdgePress(code);
    }
  }

  private handleEdgePress(code: string): void {
    switch (code) {
      case 'KeyG': this.cameraSystem.chaseCamera.toggleFollowAttitude(); break;
      case 'Comma': this.simSpeedManager.shift(-1); break;
      case 'Period': this.simSpeedManager.shift(1); break;
      case 'KeyM':
        this.cameraSystem.mapMode = this.mapModeSystem.toggleMap(this.phase, this.touchControls, this.cameraSystem.mapMode);
        // マップを閉じた: 同じノードのままΔvだけ編集された可能性があり、
        // ノード時刻の一致だけでは検出できないため、噴射ガイドの凍結目標を作り直す。
        if (!this.cameraSystem.mapMode) this.planGuide.clearActiveTarget();
        break;
      case 'KeyN': this.mapModeSystem.toggleAutoWarpToFirstNode(this.phase, this.cameraSystem.mapMode); break;
      case 'KeyX': this.clearPlanByKey(); break;
      case 'KeyH': this._hud.toggleHelp(); break;
      case 'Escape': this._hud.toggleSettings(); break;
      case 'KeyR': if (this.phase !== 'playing') location.reload(); break;
    }
  }

  // activeStage.init/update に渡す、現在状態のスナップショット
  // (敵の追加は addEnemy 経由、既存要素は参照渡しでミューテートされる)。
  private stageCtx(): StageCtx {
    return {
      phase: this.phase,
      player: this.player,
      enemies: this.simulator.enemies,
      totalEnemies: this.simulator.totalEnemiesSpawned,
      addEnemy: (enemy) => this.simulator.addEnemy(enemy),
      magsLeft: this.player.magsLeft,
      roundsInMag: this.player.roundsInMag,
      setPhase: (p) => { this.phase = p; },
      simTime: this.simTime,
    };
  }

  // Ship.attacked/checkLoss(被弾・自然喪失の判定)が必要とする、現在状態のスナップショット。
  private combatCtx(simTime = this.simTime): CombatCtx {
    const ctx: CombatCtx = {
      simTime,
      player: this.player,
      totalEnemies: this.simulator.totalEnemiesSpawned,
      activeStage: this.activeStage,
      setPhase: (p) => { this.phase = p; },
      fx: this.effectsCtx(),
      unlockManager: this.unlockManager,
    };
    return ctx;
  }

  // フラッシュ・破片のスポーン(effects-system.ts の spawnFlash/spawnFragments 等)が
  // 必要とする最小の受け皿。CombatCtx/FireCtx から共通して参照される。
  private effectsCtx(): EffectsCtx {
    return {
      effects: this.effectsSystem.effects,
      addDebris: (piece) => this.simulator.addDebris(piece),
    };
  }

  // PlayerFire の発射・排莢・バレル交換が必要とする、現在状態のスナップショット。
  private fireCtx(): FireCtx {
    return {
      simTime: this.simTime,
      zoomActive: this.cameraSystem.zoomActive,
      fx: this.effectsCtx(),
      addBullet: (bullet) => this.simulator.addBullet(bullet),
      addCasing: (casing) => this.simulator.addCasing(casing),
      addDebris: (piece) => this.simulator.addDebris(piece),
    };
  }

  // HitSystem(弾の衝突判定)が必要とする、現在状態のスナップショット。
  private hitCtx(simTime: number): HitCtx {
    return {
      combatCtx: this.combatCtx(simTime),
      enemies: this.simulator.enemies,
      target: this.targeter.autoTarget,
      bullets: this.simulator.bullets,
      boardMarks: this.markersSystem.boardMarks,
    };
  }

  // Enemy.behave(敵 AI)が必要とする、現在状態のスナップショット。
  private enemyAiCtx(simTime: number): EnemyAiCtx {
    return {
      simTime,
      player: this.player,
      enemies: this.simulator.enemies,
      addBullet: (bullet) => this.simulator.addBullet(bullet),
    };
  }

  // MarkersSystem の各メソッド呼び出しに渡す、現在状態のスナップショット。
  private markerCtx(): MarkerCtx {
    return {
      mapMode: this.cameraSystem.mapMode,
      player: this.player,
      enemies: this.simulator.enemies,
      target: this.targeter.autoTarget,
      magPickups: this.simulator.magPickups,
      mapLabelIds: this.mapModeSystem.mapLabelIds(),
      activeCamera: this.cameraSystem.activeCamera,
      simTime: this.simTime,
    };
  }

  private collisionCtx() {
    return {
      player: this.player,
      enemies: this.simulator.enemies,
      casings: this.simulator.casings,
      magPickups: this.simulator.magPickups,
      debris: this.simulator.debris,
    };
  }

  private simulatorCtx(): SimulatorCtx {
    return {
      player: this.player,
      combatCtx: (simTime) => this.combatCtx(simTime),
      hitCtx: (simTime) => this.hitCtx(simTime),
    };
  }

  // ------------------------------------------------------------- simulate

  private handlePostSimulation(dt: number, simDt: number): void {
    this.player.checkLoss({ dt, combatCtx: this.combatCtx() });

    if (this.simSpeedManager.canResolvePhysicalCollisions) {
      this.collisionPhysics.resolve(dt, this.collisionCtx(), () => {
        this._sfx.clank();
      });
    }
    this.updateAttitudes(Math.min(simDt, 0.12));

    // シミュレーション配列から不要なものを消去
    this.simulator.cleanup({ dt, combatCtx: this.combatCtx() });

    if (this.activeStage.index === -1 && this.phase === 'playing' && this.simSpeedManager.canEnemyFire) {
      const ctx = this.enemyAiCtx(this.simTime);
      for (const e of this.simulator.enemies) {
        if (e.alive) e.behave(dt, ctx);
      }
    }
  }

  private updateAttitudes(attDt: number): void {
    this.player.updateAttitude(this.input, this.cameraSystem.mapMode, attDt, () => {
      this._hud.hint('進行方向ホールド解除(手動操作)');
    });
    this.simulator.stepCoastingAttitudes(attDt);
  }

  // --------------------------------------------------------- render sync

  private syncRender(dt: number): void {
    const o = this.player.state.r;
    const pv = this.player.state.v;
    const displayTime = this.mapModeSystem.resolveDisplayTime(this.cameraSystem.mapMode);
    const cam = this.syncRenderCamera(dt, o, pv);
    this.environment.syncRenderEnvironment({
      dt,
      origin: o,
      displayTime,
      camera: cam,
      sunPhase0: this.ephemeris.sunPhase0,
      moonPhase0: this.ephemeris.moonPhase0,
      mapMode: this.cameraSystem.mapMode,
      mapCameraFar: this.cameraSystem.mapCamera.camera.far,
      lit: this.cameraSystem.mapMode ? 1.0 : this.ephemeris.shadowLitFactor(o),
    });
    this.syncRenderThrust();
    this.syncRenderRcs();
    this.syncRenderDynamicObjects(dt, o, pv);
    this.syncRenderEffects(dt, o);
    this.syncRenderHud(dt, o, pv);
  }

  private syncRenderCamera(dt: number, o: Vec3, pv: Vec3): THREE.PerspectiveCamera {
    const mouse = this.input.consumeMouse();
    const keyYaw = (this.input.down('ArrowLeft') ? 1 : 0) + (this.input.down('ArrowRight') ? -1 : 0);
    const keyPitch = (this.input.down('ArrowDown') ? 1 : 0) + (this.input.down('ArrowUp') ? -1 : 0);
    return this.cameraSystem.updateActiveCamera({
      zoomActive: this.cameraSystem.zoomActive,
      player: this.player,
      sunAz: sunAzimuth(this.simTime, this.ephemeris.sunPhase0),
      focusRel: this.mapModeSystem.focusRel(o),
      mouse,
      keyYaw,
      keyPitch,
      dt,
      origin: o,
      playerVelocity: pv,
    });
  }

  private syncRenderThrust(): void {
    this.player.renderThrustEffects(this.cameraSystem);
  }

  private syncRenderRcs(): void {
    this._sfx.setRcs(
      this.player.updateRcsEffects(
        this.input,
        this.cameraSystem,
        this.phase === 'playing',
        this.paused,
      ),
    );
  }

  private syncRenderDynamicObjects(dt: number, o: Vec3, pv: Vec3): void {
    this.player.render(this.cameraSystem.zoomActive);
    for (const e of this.simulator.enemies) if (e.alive) e.syncTransform(o);
    for (const b of this.simulator.bullets) b.syncBulletTransform(o, pv);
    for (const cs of this.simulator.casings) cs.syncTransform(o);
    for (const mp of this.simulator.magPickups) mp.syncTransform(o);
    this.player.updateBelt(dt);
    for (const d of this.simulator.debris) d.syncTransform(o);
  }

  private syncRenderEffects(dt: number, o: Vec3): void {
    this.effectsSystem.updateFlashEffects(dt, this.lastSimDt, o, this.cameraSystem.activeCamera);
  }

  // 自機・敵の軌道線は各 entity 自身が持つ(Player/Enemy コンストラクタ参照)ため、
  // ここでは毎フレームの Elements 算出と update() 呼び出しだけを行う。
  private syncEntityOrbitLines(o: Vec3, pv: Vec3, mapMode: boolean): Elements | null {
    const playerEl = elementsFromState(o, pv);
    this.player.orbitLine.update(this.player.alive ? playerEl : null, o, this.player.thrustVizDir !== null, true);
    const tgt = this.targeter.aliveTarget;
    for (const enemy of this.simulator.enemies) {
      const showGray = mapMode && enemy.alive && enemy !== tgt;
      enemy.orbitLine.update(showGray ? elementsFromState(enemy.state.r, enemy.state.v) : null, o);
    }
    return playerEl;
  }

  private syncRenderHud(dt: number, o: Vec3, pv: Vec3): void {
    const project = (rel: Vec3) => this.hudProjection.project(rel);
    this.mapModeSystem.updateDisplay(this.cameraSystem.mapMode);

    const mapMode = this.cameraSystem.mapMode;
    const playerEl = this.syncEntityOrbitLines(o, pv, mapMode);
    const tgtEl = this.targeter.updateOrbitLine(o);
    this.ephemeris.updateReferenceLines(this.simTime, o, mapMode);
    this.planGuide.updatePlannedLine(this.plan, this.planCtx(), o, mapMode);

    const markerCtx = this.markerCtx();
    this.markersSystem.updateMarkers(markerCtx, pv, project);
    this.markersSystem.updateNodeMarkers(markerCtx, playerEl, tgtEl, project);
    this.markersSystem.updateBoardMarkers(markerCtx, dt, project);
    if (mapMode) {
      this._hud.markers.hide('burn');
    } else {
      const { achieved } = this.planGuide.update(this.plan, this.planCtx(), o, pv, playerEl, this.player.alive, project);
      if (achieved) this.simSpeedManager.cancelAutoWarp();
    }

    this._hud.panels.update(this, dt, playerEl, tgtEl);
    this._hud.tick();
  }

  // ズームウィンドウ(PIP)のオーバーレイ更新。実処理は markers.ts へ委譲。
  private updatePipOverlay(rect: PipRect | null): void {
    this.markersSystem.updatePipOverlay(this.markerCtx(), rect);
  }

  public render(dtRaw: number): void {
    const dt = Math.min(dtRaw, 0.1);
    this.syncRender(dt);
    this.pipRenderer.renderFrame(this.renderer, {
      firing: this.player.isFiring,
      mapMode: this.cameraSystem.mapMode,
      camera: this.cameraSystem.activeCamera,
      playerShipObj: this.player.obj,
      setMuzzleFlashesVisible: (visible) => this.setMuzzleFlashesVisible(visible),
      updateOverlay: (rect) => this.updatePipOverlay(rect),
    });
  }
}
