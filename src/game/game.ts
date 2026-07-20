// ゲーム全体のオーケストレーション: エンティティ管理、物理積分、
// 入力 → 推力/トルク変換、衝突判定、勝敗判定、描画同期。
//
// 座標系: ECI (慣性系)、Y軸 = 北極、単位 m / m/s。
// 描画は自機中心のフローティングオリジン(自機が常に (0,0,0))。
import * as THREE from 'three/webgpu';
import {
  OrbitState,
} from '../physics/orbital';
import {
  randomQuat,
} from '../physics/attitude';
import {
  Vec3,
  randSym,
  v3,
} from '../physics/vec3';
import { Player } from './player/player';
import { FireCtx } from './player/player-fire';
import { CameraSystem } from './camera/camera-system';
import { CombatCtx, CombatSystem } from './combat/combat';
import { HitCtx, HitSystem } from './combat/hit';
import { StageCtx, StageDirector } from './stage-director';
import { EphemerisSystem } from './ephemeris';
import { MarkerCtx, MarkersSystem } from '../hud/markers';
import { CollisionPhysics } from './combat/collision';
import { EffectsCtx, EffectsSystem, FlashEffect } from './effects-system';
import { OrbitLineSystem } from './orbit-line-system';
import { getStageDefinition, resolveStageInitData } from './stage-data';
import { Targeter } from './combat/targeter';
import { HudProjection } from './camera/projection';
import { AmmoResupplySystem } from './combat/ammo-resupply';
import { MapModeSystem } from './map-mode/map-mode-system';
import { Plan, PlanCtx } from './plan/plan';
import { PlanGuide, plannedOrbitElements } from './plan/plan-guide';
import { SimSpeedManager } from './sim-speed-manager';
import { PipRect, PipRenderer } from './pip-renderer';
import { Simulator, SimulatorCtx } from './combat/simulator';
import * as C from './const';
import { Enemy, EnemyAiCtx } from './enemy/enemy';
import { Input } from './input';
import { TouchControls } from './touch';
import { ChaseCamera } from './camera/chase-camera';
import { Hud } from '../hud/hud';
import { Sfx } from '../audio/sfx';
import { GameScene } from '../render/scene';
import { makeGlowTexture } from '../render/stars';
import { buildEnemyShip } from '../render/ships';
import { OrbitLine } from '../render/orbitline';
import { EnvironmentScene } from '../render/environment-scene';

type GamePhase = 'playing' | 'won' | 'lost' | 'timeup';

export class Game {
  private readonly scene: THREE.Scene;
  private readonly renderer: GameScene['renderer'];

  private readonly input: Input;
  // HudPanels が状態を直接参照するため public(下記 hud.panels.update 呼び出し参照)。
  touchControls: TouchControls | null = null;
  private readonly hud = new Hud();
  private readonly sfx = new Sfx();
  readonly chase = new ChaseCamera();


  readonly player: Player;
  // enemies / bullets / plasmaBullets / casings / debris の各エンティティ配列は
  // Simulator が所有する(this.simulator.enemies 等)。追加は simulator.addXxx 経由。
  private effects: FlashEffect[] = [];

  // ?perf=1 のデバッグ表示用エンティティ数(軽量化計画ステップ0)。挙動には影響しない。
  perfCounts(): { enemies: number; bullets: number; casings: number; debris: number; } {
    return {
      enemies: this.simulator.enemies.length,
      bullets: this.simulator.bullets.length + this.simulator.plasmaBullets.length,
      casings: this.simulator.casings.length,
      debris: this.simulator.debris.length,
    };
  }

  private readonly glowTex: THREE.Texture;
  private readonly environment: EnvironmentScene;
  // 軌道線もモノトーン + オレンジアクセントの配色: 自機 = 明るいグレー、
  // ターゲット = オレンジ(注目対象)、計画軌道 = 白(最も明るい = 未来)。
  private readonly playerOrbitLine = new OrbitLine(0xbfc9d4, 0.55);
  // ターゲット軌道は自機軌道とほぼ重なるケースが多い(近傍ランデブー狙いのため)。
  // 埋もれて「表示されていない」ように見えないよう強い不透明度にし、
  // renderOrder を自機軌道より上げて透明オブジェクトの描画順に依存せず必ず上に描く。
  private readonly targetOrbitLine = new OrbitLine(0xff6a00, 0.9);
  private readonly plannedOrbitLine = new OrbitLine(0xffffff, 0.9);
  private readonly geoOrbitLine = new OrbitLine(0x8b93a0, 0.2);
  private readonly moonOrbitLine = new OrbitLine(0xaab3c0, 0.2);

  //readonly stage: number;

  // シミュレーション速度(旧「ワープ」)の段階管理と、[N] キーによるノードへの自動ワープ
  readonly simSpeedManager = new SimSpeedManager(this.hud, this.sfx);

  // 軌道計画(ノード列+予測キャッシュ)。マップモードの有無と無関係なデータで、
  // Game が所有し、表示・編集は mapModeSystem へ、実施(噴射ガイド)は planGuide へ
  // それぞれ「注入」する — plan-mode/plan.ts 参照。
  private readonly plan = new Plan();
  // 直近ノードの噴射ガイド(戦闘ビューのみ、マップモード中は呼ばない — [M] で開いている
  // 間は WASDQE がΔv編集に使われるため)。
  private readonly planGuide = new PlanGuide(this.hud, this.sfx);

  // 軌道計画モード(map-mode/ フォルダの唯一の外部窓口)
  private readonly mapModeSystem = new MapModeSystem(
    this.hud,
    this.sfx,
    this.simSpeedManager,
    this.plan,
    (rel: Vec3) => this.hudProjection.project(rel),
    () => this.player.fineAttitude,
    () => this.planCtx(),
  );

  private phase: GamePhase = 'playing';
  // ステージ構成・ウェーブ生成・ステージ専用タイマー(stages.ts参照)。
  readonly stageDirector: StageDirector;
  simTime = 0;
  private lastSimDt = 0;
  paused = false;

  private zoomActive = false;

  // 天体暦(太陽・月の位置と日照率)は ephemeris.ts に切り出し済み。
  private readonly ephemeris = new EphemerisSystem();
  private lostReason = '大気圏に突入し機体を喪失した';

  // --- 弾薬・マガジン ---
  // マガジンベルト(表示メッシュ + Verlet 物理)は弾薬状態に密結合なため
  // player/player-fire.ts の PlayerFire が所有する(this.player.updateBelt 等)。
  // 発射・排莢・バレル交換の演出も PlayerFire が持つ(fireCtx 経由)。
  // 撃破の集計・勝敗判定(destroyShip)は combat/combat.ts の CombatSystem が持つ。
  // 発射カウンタ(shots/hits)・撃破カウンタ(kills)も CombatSystem が保持する。
  readonly combat = new CombatSystem(this.hud, this.sfx);
  // 弾の高度な衝突判定(トンネリング防止・被弾ダメージ)は combat/hit.ts の HitSystem に
  // 切り出し済み。撃破が発生したら CombatSystem.destroyShip を呼ぶ。
  private readonly hitSystem = new HitSystem(this.combat);
  // HUDマーカー(方向・敵/リード/AMMO/ノード/PIP/ボード)の同期は markers.ts の
  // MarkersSystem に切り出し済み。boardMarks(標的面通過点)もここが保持する
  // (combat/hit.ts の checkBoardCrossings が直接この配列へ push する)。
  // ステータスパネルは hud.panels が担う。
  private readonly markersSystem = new MarkersSystem(this.hud.markers);
  private readonly collisionPhysics = new CollisionPhysics();
  private readonly effectsSystem = new EffectsSystem();
  private readonly orbitLineSystem = new OrbitLineSystem();
  private readonly cameraSystem = new CameraSystem();
  readonly targeter = new Targeter(this.hud);
  private readonly hudProjection = new HudProjection(() => this.activeCamera);
  private readonly ammoResupply: AmmoResupplySystem;
  readonly simulator: Simulator;
  private readonly pipRenderer = new PipRenderer();

  constructor(gs: GameScene, stage = 1) {
    this.scene = gs.scene;
    this.renderer = gs.renderer;

    this.stageDirector = new StageDirector(
      this.hud,
      this.sfx,
      stage,
      (minDist?: number, maxDist?: number) => this.ammoResupply.spawnForPlayer(this.player, minDist, maxDist),
    );

    this.input = new Input(gs.renderer.domElement);
    this.input.onFirstGesture = () => this.sfx.unlock();
    if (TouchControls.isTouchDevice()) this.touchControls = new TouchControls(this.input);
    this.wireHudCallbacks();
    this.simulator = new Simulator(this.ephemeris, this.hitSystem);
    this.ammoResupply = new AmmoResupplySystem(
      this.hud,
      this.sfx,
      this.scene,
      this.simulator.magPickups,
      (mp) => this.simulator.addMagPickup(mp),
    );

    // 汎用発光テクスチャ
    this.glowTex = makeGlowTexture();

    // --- 環境 ---
    this.ephemeris.update(this.simTime);
    this.environment = new EnvironmentScene(this.scene, this.glowTex, this.ephemeris.sunDir, {
      sunIntensity: C.SUN_INTENSITY,
      ambientIntensity: C.AMBIENT_INTENSITY,
      shadowMinSun: C.SHADOW_MIN_SUN,
      shadowMinAmbient: C.SHADOW_MIN_AMBIENT,
    });

    this.addOrbitLines();

    // --- 自機: 高度420km・傾斜51.6°の円軌道 ---
    this.player = new Player(this.hud, this.sfx, this.scene, this.glowTex);

    // --- 敵機配置 ---
    this.spawnInitialEnemies(this.player.state);

    this.initStage();
  }

  private wireHudCallbacks(): void {
    this.hud.setBgmState(this.sfx.isBgmEnabled());
    this.hud.onBgmToggle = (on) => this.sfx.setBgmEnabled(on);
    // ⚙ギアクリック・[閉じる]・[Esc] いずれの経路で開閉しても一時停止フラグを同期する
    this.hud.onSettingsOpenChange = (open) => {
      this.paused = open;
    };
    // 「ゲームを中断してタイトル画面に戻る」— ?stage= クエリを落として選択画面へ
    this.hud.onQuitToTitle = () => {
      location.assign(location.pathname);
    };
  }

  private addOrbitLines(): void {
    this.scene.add(this.playerOrbitLine.line);
    this.targetOrbitLine.line.renderOrder = 2;
    this.scene.add(this.targetOrbitLine.line);
    this.plannedOrbitLine.line.renderOrder = 3;
    this.scene.add(this.plannedOrbitLine.line);
    this.geoOrbitLine.line.renderOrder = 0;
    this.scene.add(this.geoOrbitLine.line);
    this.moonOrbitLine.line.renderOrder = 0;
    this.scene.add(this.moonOrbitLine.line);
    this.scene.add(this.mapModeSystem.trajLineGroup);
  }

  private spawnInitialEnemies(playerState: OrbitState): void {
    for (const spec of this.stageDirector.makeEnemySpecs(playerState)) {
      const enemy = new Enemy(
        spec.name,
        spec.state,
        buildEnemyShip(spec.accent),
        {
          q: randomQuat(),
          w: v3(randSym(0.12), randSym(0.12), randSym(0.12)),
          inertia: v3(1, 1.1, 1.05),
        },
        spec.hp,
        spec.accent,
        undefined,
        this.scene,
      );
      this.addEnemy(enemy, 0x565b63);
    }
  }

  // 敵の追加は Simulator への登録(配列)と軌道線の生成・scene 登録を常に対で行う。
  // 軌道線は enemy 自身に持たせる(orbit-line-system.ts が enemy.orbitLine を直接参照)。
  private addEnemy(enemy: Enemy, orbitLineColor: number): void {
    enemy.orbitLine = new OrbitLine(orbitLineColor, 0.35);
    this.scene.add(enemy.orbitLine.line);
    this.simulator.addEnemy(enemy);
  }

  // ステージ別の初期弾薬・初期補給の配置と作戦目標のブリーフィング表示
  private initStage(): void {
    const data = resolveStageInitData(this.stageDirector.stage, this.simulator.totalEnemiesSpawned);
    const stageDef = getStageDefinition(this.stageDirector.stage);
    this.player.initAmmo(data.magsLeft, data.roundsInMag);
    if (stageDef.initAction === 'spawn-stage00-ammo') {
      this.stageDirector.spawnStage00InitialAmmo(this.stageCtx());
    } else if (stageDef.initAction === 'spawn-stage0-ammo') {
      this.stageDirector.spawnStage0InitialAmmo();
    }
    this.hud.toast(data.briefingHtml, 12000);
  }

  // 描画に使うカメラ(戦闘 / 軌道計画で切り替え)
  private get activeCamera(): THREE.PerspectiveCamera {
    return this.cameraSystem.activeCamera(this.mapModeSystem, this.chase);
  }

  private get mapMode(): boolean {
    return this.mapModeSystem.mapMode;
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
    for (const fx of this.effects) if (fx.muzzle) fx.mesh.visible = v;
  }

  // ---------------------------------------------------------------- update

  update(dtRaw: number): void {
    const dt = Math.min(dtRaw, 0.1);
    this.zoomActive = !this.mapMode && this.input.down('KeyZ');
    this.handleEdgeInput();
    this.mapModeSystem.syncMapModeWithPhase(this.phase, this.touchControls);

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
      mapMode: this.mapMode,
      combat: this.combat,
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

    if (this.mapMode) {
      this.mapModeSystem.updateEditing(dt, this.input);
    }
    else {
      this.targeter.updateCombatTargeting(
        {
          player: this.player,
          enemies: this.simulator.enemies,
          input: this.input,
          activeCamera: this.activeCamera,
          project: (rel) => this.hudProjection.project(rel),
        });
    }

    this.stageDirector.update(dt, this.stageCtx());
  }

  private handlePausedFrame(): void {
    this.lastSimDt = 0;
    this.sfx.setThrust(false);
    this.player.pause();
    this.input.takeClicks();
    this.input.takeRightClicks();
  }

  // [X] キー: マップモード中は選択中ノードのみ(mapModeSystem 側の責務)、
  // マップ外では計画全体を破棄する。Plan を直接持つのは Game なので、
  // 全破棄はここが受け持つ(mapModeSystem にマップ外の状態を持たせないため)。
  private clearPlanByKey(): void {
    if (this.mapMode) {
      this.mapModeSystem.deleteSelectedNode();
      return;
    }
    if (this.plan.nodes.length <= 0) return;
    this.plan.clear();
    this.planGuide.clearActiveTarget();
    this.simSpeedManager.cancelAutoWarp();
    this.hud.hint('マニューバ計画を破棄');
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
      case 'KeyG': this.chase.toggleFollowAttitude(this.hud); break;
      case 'Comma': this.simSpeedManager.shift(-1); break;
      case 'Period': this.simSpeedManager.shift(1); break;
      case 'KeyM':
        this.mapModeSystem.toggleMap(this.phase, this.touchControls);
        // マップを閉じた: 同じノードのままΔvだけ編集された可能性があり、
        // ノード時刻の一致だけでは検出できないため、噴射ガイドの凍結目標を作り直す。
        if (!this.mapMode) this.planGuide.clearActiveTarget();
        break;
      case 'KeyN': this.mapModeSystem.toggleAutoWarpToFirstNode(this.phase); break;
      case 'KeyX': this.clearPlanByKey(); break;
      case 'KeyH': this.hud.toggleHelp(); break;
      case 'Escape': this.hud.toggleSettings(); break;
      case 'KeyR': if (this.phase !== 'playing') location.reload(); break;
    }
  }

  // StageDirector の各メソッド呼び出しに渡す、現在状態のスナップショット
  // (敵の追加は addEnemy 経由、既存要素は参照渡しでミューテートされる)。
  private stageCtx(): StageCtx {
    return {
      phase: this.phase,
      player: this.player,
      enemies: this.simulator.enemies,
      totalEnemies: this.simulator.totalEnemiesSpawned,
      addEnemy: (enemy, orbitLineColor) => this.addEnemy(enemy, orbitLineColor),
      scene: this.scene,
      shots: this.combat.shots,
      hits: this.combat.hits,
      kills: this.combat.kills,
      magsLeft: this.player.magsLeft,
      roundsInMag: this.player.roundsInMag,
      setPhase: (p) => { this.phase = p; },
    };
  }

  // CombatSystem.destroyShip(撃破の集計・勝敗判定)が必要とする、現在状態のスナップショット。
  private combatCtx(simTime = this.simTime): CombatCtx {
    const ctx: CombatCtx = {
      simTime,
      player: this.player,
      totalEnemies: this.simulator.totalEnemiesSpawned,
      stage: this.stageDirector.stage,
      lostReason: this.lostReason,
      setLostReason: (reason) => {
        this.lostReason = reason;
        ctx.lostReason = reason;
      },
      setPhase: (p) => { this.phase = p; },
      sfx: this.sfx,
      fx: this.effectsCtx(),
    };
    return ctx;
  }

  // フラッシュ・破片のスポーン(effects-system.ts の spawnFlash/spawnFragments 等)が
  // 必要とする最小の受け皿。CombatCtx/FireCtx から共通して参照される。
  private effectsCtx(): EffectsCtx {
    return {
      scene: this.scene,
      glowTex: this.glowTex,
      effects: this.effects,
      addDebris: (piece) => this.simulator.addDebris(piece),
    };
  }

  // PlayerFire の発射・排莢・バレル交換が必要とする、現在状態のスナップショット。
  private fireCtx(): FireCtx {
    return {
      simTime: this.simTime,
      scene: this.scene,
      zoomActive: this.zoomActive,
      fx: this.effectsCtx(),
      addBullet: (bullet) => this.simulator.addBullet(bullet),
      addCasing: (casing) => this.simulator.addCasing(casing),
      addDebris: (piece) => this.simulator.addDebris(piece),
    };
  }

  // HitSystem(弾の衝突判定)が必要とする、現在状態のスナップショット。
  private hitCtx(simTime: number): HitCtx {
    return {
      combat: this.combatCtx(simTime),
      enemies: this.simulator.enemies,
      target: this.targeter.autoTarget,
      bullets: this.simulator.bullets,
      plasmaBullets: this.simulator.plasmaBullets,
      boardMarks: this.markersSystem.boardMarks,
    };
  }

  // Enemy.behave(敵 AI)が必要とする、現在状態のスナップショット。
  private enemyAiCtx(simTime: number): EnemyAiCtx {
    return {
      simTime,
      player: this.player,
      enemies: this.simulator.enemies,
      scene: this.scene,
      addPlasmaBullet: (bullet) => this.simulator.addPlasmaBullet(bullet),
    };
  }

  // MarkersSystem の各メソッド呼び出しに渡す、現在状態のスナップショット。
  private markerCtx(): MarkerCtx {
    return {
      mapMode: this.mapMode,
      player: this.player,
      enemies: this.simulator.enemies,
      target: this.targeter.autoTarget,
      magPickups: this.simulator.magPickups,
      mapLabelIds: this.mapModeSystem.mapLabelIds(),
      activeCamera: this.activeCamera,
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
    this.player.checkLoss({ dt, combat: this.combat, combatCtx: this.combatCtx() });

    this.ammoResupply.updateLogistics(this.simTime, this.stageDirector.stage, this.player);
    if (this.simSpeedManager.canResolvePhysicalCollisions) {
      this.collisionPhysics.resolve(dt, this.collisionCtx(), () => {
        this.sfx.clank();
      });
    }
    this.updateAttitudes(Math.min(simDt, 0.12));

    // シミュレーション配列から不要なものを消去
    this.simulator.cleanup({ dt, combat: this.combat, combatCtx: this.combatCtx() });

    if (this.stageDirector.stage === -1 && this.phase === 'playing' && this.simSpeedManager.canEnemyFire) {
      const ctx = this.enemyAiCtx(this.simTime);
      for (const e of this.simulator.enemies) {
        if (e.alive) e.behave(dt, ctx);
      }
    }
  }

  private updateAttitudes(attDt: number): void {
    this.player.updateAttitude(this.input, this.mapMode, attDt, () => {
      this.hud.hint('進行方向ホールド解除(手動操作)');
    });
    this.simulator.stepCoastingAttitudes(attDt);
  }

  // --------------------------------------------------------- render sync

  private syncRender(dt: number): void {
    const o = this.player.state.r;
    const pv = this.player.state.v;
    const displayTime = this.mapModeSystem.resolveDisplayTime();
    const cam = this.syncRenderCamera(dt, o, pv);
    this.environment.syncRenderEnvironment({
      dt,
      origin: o,
      displayTime,
      camera: cam,
      sunPhase0: this.ephemeris.sunPhase0,
      moonPhase0: this.ephemeris.moonPhase0,
      mapMode: this.mapMode,
      mapCameraFar: this.mapModeSystem.cameraFar,
      lit: this.mapMode ? 1.0 : this.ephemeris.shadowLitFactor(o),
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
      zoomActive: this.zoomActive,
      player: this.player,
      maneuver: this.mapModeSystem,
      chase: this.chase,
      mouse,
      keyYaw,
      keyPitch,
      dt,
      origin: o,
      playerVelocity: pv,
    });
  }

  private syncRenderThrust(): void {
    this.player.renderThrustEffects(this.activeCamera, this.zoomActive);
  }

  private syncRenderRcs(): void {
    this.sfx.setRcs(
      this.player.updateRcsEffects(
        this.input,
        this.activeCamera,
        this.zoomActive,
        this.phase === 'playing',
        this.paused,
        this.mapMode,
      ),
    );
  }

  private syncRenderDynamicObjects(dt: number, o: Vec3, pv: Vec3): void {
    this.player.render(this.zoomActive);
    for (const e of this.simulator.enemies) if (e.alive) e.syncTransform(o);
    for (const b of this.simulator.bullets) b.syncBulletTransform(o, pv);
    for (const pb of this.simulator.plasmaBullets) pb.syncBulletTransform(o, pv);
    for (const cs of this.simulator.casings) cs.syncTransform(o);
    for (const mp of this.simulator.magPickups) mp.syncTransform(o);
    this.player.updateBelt(dt);
    for (const d of this.simulator.debris) d.syncTransform(o);
  }

  private syncRenderEffects(dt: number, o: Vec3): void {
    this.effects = this.effectsSystem.updateFlashEffects(
      this.effects,
      dt,
      this.lastSimDt,
      o,
      this.activeCamera,
      this.scene,
    );
  }

  private syncRenderHud(dt: number, o: Vec3, pv: Vec3): void {
    const project = (rel: Vec3) => this.hudProjection.project(rel);
    this.mapModeSystem.updateDisplay();
    const { playerEl, tgtEl } = this.orbitLineSystem.update({
      simTime: this.simTime,
      origin: o,
      playerVelocity: pv,
      player: this.player,
      target: this.targeter.autoTarget,
      enemies: this.simulator.enemies,
      mapMode: this.mapMode,
      plannedEl: this.mapMode ? null : plannedOrbitElements(this.plan, this.planCtx()),
      playerOrbitLine: this.playerOrbitLine,
      targetOrbitLine: this.targetOrbitLine,
      plannedOrbitLine: this.plannedOrbitLine,
      geoOrbitLine: this.geoOrbitLine,
      moonOrbitLine: this.moonOrbitLine,
    });

    const markerCtx = this.markerCtx();
    this.markersSystem.updateMarkers(markerCtx, pv, project);
    this.markersSystem.updateNodeMarkers(markerCtx, playerEl, tgtEl, project);
    this.markersSystem.updateBoardMarkers(markerCtx, dt, project);
    if (this.mapMode) {
      this.hud.markers.hide('burn');
    } else {
      const { achieved } = this.planGuide.update(this.plan, this.planCtx(), o, pv, playerEl, this.player.alive, project);
      if (achieved) this.simSpeedManager.cancelAutoWarp();
    }

    this.hud.panels.update(this, dt, playerEl, tgtEl);
    this.hud.tick();
  }

  // ズームウィンドウ(PIP)のオーバーレイ更新。実処理は markers.ts へ委譲。
  private updatePipOverlay(rect: PipRect | null): void {
    this.markersSystem.updatePipOverlay(this.markerCtx(), rect);
  }

  public render(dtRaw: number): void {
    const dt = Math.min(dtRaw, 0.1);
    this.syncRender(dt);
    this.pipRenderer.renderFrame(this.renderer, this.scene, {
      firing: this.player.isFiring,
      mapMode: this.mapMode,
      camera: this.activeCamera,
      playerShipObj: this.player.obj,
      setMuzzleFlashesVisible: (visible) => this.setMuzzleFlashesVisible(visible),
      updateOverlay: (rect) => this.updatePipOverlay(rect),
    });
  }
}
