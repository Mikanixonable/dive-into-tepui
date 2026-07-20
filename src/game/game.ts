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
import { CameraSystem } from './camera/camera-system';
import { CombatCtx, CombatSystem } from './combat/combat';
import { StageCtx, StageDirector } from './stage-director';
import { EphemerisSystem } from './ephemeris';
import { MarkerCtx, MarkersSystem } from '../hud/markers';
import { HudPanelCtx } from '../hud/panel';
import { CollisionPhysics } from './combat/collision';
import { EffectsSystem, FlashEffect } from './effects-system';
import { OrbitLineSystem } from './orbit-line-system';
import { getStageDefinition, resolveStageInitData } from './stage-data';
import { Targeter } from './combat/targeter';
import { HudProjection } from './camera/projection';
import { AmmoResupplySystem } from './combat/ammo-resupply';
import { MapModeSystem } from './map-mode/map-mode-system';
import { PipRect, PipRenderer } from './pip-renderer';
import { altitudeOf, Simulator, SimulatorCtx } from './combat/simulator';
import * as C from './const';
import { Enemy } from './enemy/enemy';
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
  private readonly camera: THREE.PerspectiveCamera;
  private readonly renderer: GameScene['renderer'];

  private readonly input: Input;
  private touchControls: TouchControls | null = null;
  private readonly hud = new Hud();
  private readonly sfx = new Sfx();
  private readonly chase = new ChaseCamera();


  private readonly player: Player;
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

  // 軌道計画モード(map-mode/ フォルダの唯一の外部窓口)
  private readonly mapModeSystem = new MapModeSystem(
    this.hud,
    this.sfx,
    (rel: Vec3) => this.hudProjection.project(rel),
    () => this.player.fineAttitude,
    () => ({
      simTime: this.simTime,
      playerR: this.player.state.r,
      playerV: this.player.state.v,
      sunPhase0: this.ephemeris.sunPhase0,
      moonPhase0: this.ephemeris.moonPhase0,
    }),
  );

  private phase: GamePhase = 'playing';
  // ステージ構成・ウェーブ生成・ステージ専用タイマー(stages.ts参照)。
  private readonly stageDirector: StageDirector;
  private simTime = 0;
  private lastSimDt = 0;
  private paused = false;

  private zoomActive = false;

  // 天体暦(太陽・月の位置と日照率)は ephemeris.ts に切り出し済み。
  private readonly ephemeris = new EphemerisSystem();
  private lostReason = '大気圏に突入し機体を喪失した';

  // --- 弾薬・マガジン ---
  // マガジンベルト(表示メッシュ + Verlet 物理)は弾薬状態に密結合なため
  // player/player-fire.ts の PlayerFire が所有する(this.player.updateBelt 等)。
  // 武器発射・被弾・撃破まわりの処理は combat.ts の CombatSystem に切り出し済み。
  // 発射カウンタ(shots/hits/kills)・砲口交互発射のインデックスも CombatSystem が保持する。
  private readonly combat = new CombatSystem(this.hud, this.sfx);
  // HUDマーカー(方向・敵/リード/AMMO/ノード/PIP/ボード)の同期は markers.ts の
  // MarkersSystem に切り出し済み。boardMarks(標的面通過点)もここが保持する
  // (combat.ts が boardMarks へ直接 push する)。ステータスパネルは hud.panels が担う。
  private readonly markersSystem = new MarkersSystem(this.hud.markers);
  private readonly collisionPhysics = new CollisionPhysics();
  private readonly effectsSystem = new EffectsSystem();
  private readonly orbitLineSystem = new OrbitLineSystem();
  private readonly cameraSystem = new CameraSystem();
  private readonly targeter = new Targeter(this.hud);
  private readonly hudProjection = new HudProjection(() => this.activeCamera);
  private readonly ammoResupply: AmmoResupplySystem;
  private readonly simulator: Simulator;
  private readonly pipRenderer = new PipRenderer();

  constructor(gs: GameScene, stage = 1) {
    this.scene = gs.scene;
    this.camera = gs.camera;
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
    this.simulator = new Simulator(this.ephemeris, this.combat);
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
    return this.cameraSystem.activeCamera(this.mapModeSystem, this.camera);
  }

  private get mapMode(): boolean {
    return this.mapModeSystem.mapMode;
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
        this.mapModeSystem.warp(),
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
    this.mapModeSystem.updateAutoWarp();
    const warp = this.mapModeSystem.warp();
    const simDt = dt * warp;
    // プレイヤーの HP 回復・移動/発射の試行
    const action = this.player.behave({
      dt,
      input: this.input,
      warp,
      mapMode: this.mapMode,
      combat: this.combat,
      combatCtx: this.combatCtx(),
    });
    const playerAccel = this.simulator.buildPlayerAccel(action.thrustFn);

    const advanced = this.simulator.integrateSimulation(
      this.simTime,
      dt,
      warp,
      this.simulatorCtx(),
      true,
      true,
      playerAccel,
    );
    this.simTime = advanced.simTime;
    this.lastSimDt = advanced.simDt;

    this.handlePostSimulation(dt, simDt, warp, action.canAct);

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

  private handleEdgeInput(): void {
    for (const code of this.input.takePresses()) {
      this.handleEdgePress(code);
    }
  }

  private handleEdgePress(code: string): void {
    switch (code) {
      case 'KeyT': this.player.toggleRcsDamp(); break;
      case 'KeyF': this.player.enableProgradeReset(); break;
      case 'KeyV': this.player.toggleFineAttitude(); break;
      case 'KeyC': this.player.toggleProgradeHold(); break;
      case 'KeyG': this.chase.toggleFollowAttitude(this.hud); break;
      case 'Digit1': this.player.setThrottlePreset(0); break;
      case 'Digit2': this.player.setThrottlePreset(1); break;
      case 'Digit3': this.player.setThrottlePreset(2); break;
      case 'Comma': this.mapModeSystem.shiftWarp(-1); break;
      case 'Period': this.mapModeSystem.shiftWarp(1); break;
      case 'KeyM': this.mapModeSystem.toggleMap(this.phase, this.touchControls); break;
      case 'KeyN': this.mapModeSystem.toggleAutoWarpToFirstNode(this.phase); break;
      case 'KeyX': this.mapModeSystem.clearPlanByKey(); break;
      case 'KeyH': this.hud.toggleHelp(); break;
      case 'Escape': this.hud.toggleSettings(); break;
      case 'KeyR': this.handleReloadOrRestartKey(); break;
    }
  }

  private handleReloadOrRestartKey(): void {
    if (this.phase !== 'playing') {
      location.reload();
      return;
    }
    if (!this.player.manualReload()) return;
    this.combat.dropBarrel(this.combatCtx());
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

  // CombatSystem の各メソッド呼び出しに渡す、現在状態のスナップショット
  // (エンティティ配列は Simulator 所有の実体への参照。追加は addXxx 経由)。
  private combatCtx(simTime = this.simTime): CombatCtx {
    const ctx: CombatCtx = {
      simTime,
      player: this.player,
      enemies: this.simulator.enemies,
      totalEnemies: this.simulator.totalEnemiesSpawned,
      target: this.targeter.autoTarget,
      stage: this.stageDirector.stage,
      zoomActive: this.zoomActive,
      scene: this.scene,
      glowTex: this.glowTex,
      bullets: this.simulator.bullets,
      plasmaBullets: this.simulator.plasmaBullets,
      addBullet: (bullet) => this.simulator.addBullet(bullet),
      addPlasmaBullet: (bullet) => this.simulator.addPlasmaBullet(bullet),
      addCasing: (casing) => this.simulator.addCasing(casing),
      addDebris: (piece) => this.simulator.addDebris(piece),
      effects: this.effects,
      boardMarks: this.markersSystem.boardMarks,
      lostReason: this.lostReason,
      setLostReason: (reason) => {
        this.lostReason = reason;
        ctx.lostReason = reason;
      },
      setPhase: (p) => { this.phase = p; },
    };
    return ctx;
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
      solveLeadTime: (relP, relV, s) => this.combat.solveLeadTime(relP, relV, s),
    };
  }

  // hud.panels.update に渡す、ステータスパネル表示用のスナップショット。
  private hudPanelCtx(): HudPanelCtx {
    return {
      player: this.player,
      enemies: this.simulator.enemies,
      target: this.targeter.autoTarget,
      touchControls: this.touchControls,
      simTime: this.simTime,
      warp: this.mapModeSystem.warp(),
      paused: this.paused,
      rcsDamp: this.player.rcsDamp,
      throttleIdx: this.player.throttleIdx,
      fineAttitude: this.player.fineAttitude,
      progradeHold: this.player.progradeHold,
      camFollowAttitude: this.chase.camFollowAttitude,
      roundsInMag: this.player.roundsInMag,
      magsLeft: this.player.magsLeft,
      reloadTimer: this.player.reloadTimer,
      alt: altitudeOf(this.player.state.r),
      shots: this.combat.shots,
      kills: this.combat.kills,
      totalEnemies: this.simulator.totalEnemiesSpawned,
      stage: this.stageDirector.stage,
      stage00WaveCount: this.stageDirector.stage00WaveCount,
      stage0TimeLeft: this.stageDirector.stage0TimeLeft,
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
    };
  }

  // ------------------------------------------------------------- simulate

  private handlePostSimulation(dt: number, simDt: number, warp: number, canAct: boolean): void {
    this.player.checkLoss(dt, this.combat, this.combatCtx());

    this.ammoResupply.updateLogistics(this.simTime, this.stageDirector.stage, this.player);
    if (warp <= C.MAX_PHYS_WARP) {
      this.collisionPhysics.resolve(dt, this.collisionCtx(), () => {
        this.sfx.clank();
      });
    }
    this.updateAttitudes(Math.min(simDt, 0.12));

    // シミュレーション配列から不要なものを消去
    this.simulator.cleanup(this.combatCtx(), this.simTime);

    if (this.stageDirector.stage === -1 && this.phase === 'playing' && canAct) {
      this.combat.updateEnemyAI(dt, this.combatCtx());
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
      mapCameraFar: this.mapModeSystem.mapCameraFar,
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
      camera: this.camera,
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
    const { playerEl, tgtEl } = this.orbitLineSystem.update({
      simTime: this.simTime,
      origin: o,
      playerVelocity: pv,
      player: this.player,
      target: this.targeter.autoTarget,
      enemies: this.simulator.enemies,
      maneuver: this.mapModeSystem,
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
      this.mapModeSystem.updateGuide(playerEl, this.player.alive);
    }

    this.hud.panels.update(this.hudPanelCtx(), dt, playerEl, tgtEl);
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
