// ゲーム全体のオーケストレーション: エンティティ管理、物理積分、
// 入力 → 推力/トルク変換、衝突判定、勝敗判定、描画同期。
//
// 座標系: ECI (慣性系)、Y軸 = 北極、単位 m / m/s。
// 描画は自機中心のフローティングオリジン(自機が常に (0,0,0))。
import * as THREE from 'three/webgpu';
import {
  ExtraAccel,
  OrbitState,
  SIDEREAL_DAY,
  stepOrbitRK4,
} from '../physics/orbital';
import {
  R_MOON,
  moonPosition,
  sunPosition,
} from '../physics/ephemeris';
import {
  randomQuat,
  stepAttitude,
} from '../physics/attitude';
import {
  Vec3,
  add,
  clone,
  norm,
  randSym,
  sub,
  v3,
} from '../physics/vec3';
import { PlannerCtx } from './planner';
import { BeltPhysics } from './belt';
import { Player } from './player';
import { CameraSystem } from './camera-system';
import { CombatCtx, CombatSystem } from './combat';
import { StageCtx, StageDirector } from './stages';
import { EnvironmentSystem } from './environment';
import { MarkersCtx, MarkersSystem } from '../hud/markers';
import { CollisionPhysics } from './collision';
import { EffectsSystem } from './effects-system';
import { OrbitLineSystem } from './orbit-line-system';
import { RenderDynamicsSystem } from './render-dynamics';
import { HudSyncSystem } from '../hud/hud-sync-system';
import { getStageDefinition, resolveStageInitData } from './stage-data';
import { PlayModes } from './play-modes';
import { HudProjection } from '../hud/hud-projection';
import { AmmoResupplySystem } from './ammo-resupply';
import { ManeuverSystem } from './maneuver-system';
import { PipRect, PipRenderer } from './pip-renderer';
import * as C from './const';
import { Bullet, Casing, DebrisPiece, FlashEffect, Enemy } from './entities';
import { Input } from './input';
import { TouchControls } from './touch';
import { ChaseCamera } from './camera';
import { Hud } from '../hud/hud';
import { Sfx } from './audio';
import { GameScene } from '../render/scene';
import { createEarth, Earth } from '../render/earth';
import {
  MOON_VIS_DIST,
  SUN_DISTANCE,
  createMoon,
  createStars,
  createSun,
  makeGlowTexture,
  Sun,
} from '../render/stars';
import {
  MAG_BELT_PITCH,
  buildEnemyShip,
  buildFlashMesh,
  buildMagazineMesh,
} from '../render/ships';
import { OrbitLine } from '../render/orbitline';

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

  private readonly earth: Earth;
  private readonly sun: Sun;

  private readonly player: Player;
  private readonly enemies: Enemy[] = [];
  private bullets: Bullet[] = [];
  private plasmaBullets: Bullet[] = [];
  private casings: Casing[] = [];
  private debris: DebrisPiece[] = [];
  private effects: FlashEffect[] = [];

  // ?perf=1 のデバッグ表示用エンティティ数(軽量化計画ステップ0)。挙動には影響しない。
  perfCounts(): { enemies: number; bullets: number; casings: number; debris: number; } {
    return {
      enemies: this.enemies.length,
      bullets: this.bullets.length + this.plasmaBullets.length,
      casings: this.casings.length,
      debris: this.debris.length,
    };
  }


  private readonly glowTex: THREE.Texture;
  // 軌道線もモノトーン + オレンジアクセントの配色: 自機 = 明るいグレー、
  // ターゲット = オレンジ(注目対象)、計画軌道 = 白(最も明るい = 未来)。
  private readonly playerOrbitLine = new OrbitLine(0xbfc9d4, 0.55);
  // ターゲット軌道は自機軌道とほぼ重なるケースが多い(近傍ランデブー狙いのため)。
  // 埋もれて「表示されていない」ように見えないよう強い不透明度にし、
  // renderOrder を自機軌道より上げて透明オブジェクトの描画順に依存せず必ず上に描く。
  private readonly targetOrbitLine = new OrbitLine(0xff6a00, 0.9);
  private readonly plannedOrbitLine = new OrbitLine(0xffffff, 0.9);
  private readonly enemyOrbitLines: OrbitLine[] = [];
  private readonly geoOrbitLine = new OrbitLine(0x8b93a0, 0.2);
  private readonly moonOrbitLine = new OrbitLine(0xaab3c0, 0.2);

  // 軌道計画モード
  readonly stage: number;
  private readonly starsMesh: THREE.Mesh;

  private readonly maneuver = new ManeuverSystem(
    this.hud,
    this.sfx,
    (rel) => this.hudProjection.project(rel),
    () => this.player.fineAttitude,
  );

  private phase: GamePhase = 'playing';
  // ステージ構成・ウェーブ生成・ステージ専用タイマー(stages.ts参照)。
  private readonly stageDirector = new StageDirector(
    this.hud,
    this.sfx,
    (minDist?: number, maxDist?: number) => this.spawnMagPickup(minDist, maxDist),
  );
  private simTime = 0;
  private lastSimDt = 0;
  private warpIdx = 0;
  private paused = false;

  private target: Enemy | null = null;
  private zoomActive = false;

  // 環境モデル(大気抵抗+J2+第三体摂動)・自機の熱/動圧・高度警告・天体暦は
  // environment.ts の EnvironmentSystem に切り出し済み。
  private readonly environment = new EnvironmentSystem(this.hud, this.sfx);
  private lostReason = '大気圏に突入し機体を喪失した';


  private readonly plumeCore: THREE.Mesh;
  private readonly plumeOuter: THREE.Mesh;
  private readonly rcsPuffs: THREE.Mesh[] = []; // RCS ブロック位置の噴射パフ(4基)
  private readonly sunLight: THREE.DirectionalLight;
  private readonly ambient: THREE.AmbientLight;
  private readonly moonMesh = createMoon();

  // --- 弾薬・マガジン ---
  private clankCd = 0; // 薬莢接触音のレート制限 [実 s]
  private readonly beltGroup = new THREE.Group();
  private readonly beltLinks: THREE.Group[] = [];
  // ベルトのたわみ・ねじれの物理演算(Verlet 積分 + 距離拘束)は belt.ts の
  // BeltPhysics に切り出し済み。beltLinks(表示メッシュ)を注入して構築する
  // (メッシュ自体は下の constructor で beltGroup に積む)。
  private readonly belt = new BeltPhysics(this.beltLinks);
  // 武器発射・被弾・撃破まわりの処理は combat.ts の CombatSystem に切り出し済み。
  // 発射カウンタ(shots/hits/kills)・砲口交互発射のインデックスも CombatSystem が保持する。
  private readonly combat = new CombatSystem(this.hud, this.sfx);
  // HUDマーカー(方向・敵/リード/AMMO/ノード/PIP/ボード)とステータスパネルの同期は
  // markers.ts の MarkersSystem に切り出し済み。boardMarks(標的面通過点)・
  // ステータス更新タイマーもここが保持する(combat.ts が boardMarks へ直接 push する)。
  private readonly markers = new MarkersSystem(this.hud);
  private readonly collisionPhysics = new CollisionPhysics();
  private readonly effectsSystem = new EffectsSystem();
  private readonly orbitLineSystem = new OrbitLineSystem();
  private readonly hudSyncSystem = new HudSyncSystem(this.hud, this.markers, this.orbitLineSystem);
  private readonly renderDynamicsSystem = new RenderDynamicsSystem();
  private readonly cameraSystem = new CameraSystem();
  private readonly playModes = new PlayModes(this.hud);
  private readonly hudProjection = new HudProjection(() => this.activeCamera);
  private readonly ammoResupply: AmmoResupplySystem;
  private readonly pipRenderer = new PipRenderer();
  private readonly earthPhase0 = Math.random() * Math.PI * 2;

  private get planner() { return this.maneuver.planner; }
  private get mapView() { return this.maneuver.mapView; }
  private get trajOverlay() { return this.maneuver.trajOverlay; }

  constructor(gs: GameScene, stage = 1) {
    this.scene = gs.scene;
    this.camera = gs.camera;
    this.renderer = gs.renderer;
    this.stage = stage;
    this.input = new Input(gs.renderer.domElement);
    this.input.onFirstGesture = () => this.sfx.unlock();
    if (TouchControls.isTouchDevice()) this.touchControls = new TouchControls(this.input);
    this.wireHudCallbacks();
    this.ammoResupply = new AmmoResupplySystem(this.scene, this.hud, this.sfx);

    // --- 環境 ---
    const env = this.buildEnvironmentScene();
    this.ambient = env.ambient;
    this.glowTex = env.glowTex;
    this.sun = env.sun;
    this.sunLight = env.sunLight;
    this.starsMesh = env.starsMesh;
    this.earth = env.earth;
    this.addOrbitLines();

    const plumes = this.buildThrustPlumes();
    this.plumeCore = plumes.core;
    this.plumeOuter = plumes.outer;
    this.buildRcsPuffs();

    // --- 自機: 高度420km・傾斜51.6°の円軌道 ---
    this.player = new Player();
    this.scene.add(this.player.obj);
    this.buildBeltLinks();
    this.maneuver.bindCallbacks(() => this.plannerCtx());

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

  private buildEnvironmentScene(): {
    ambient: THREE.AmbientLight;
    glowTex: THREE.Texture;
    sun: Sun;
    sunLight: THREE.DirectionalLight;
    starsMesh: THREE.Mesh;
    earth: Earth;
  } {
    const ambient = new THREE.AmbientLight(0x8899bb, 0.25);
    this.scene.add(ambient);
    const glowTex = makeGlowTexture();
    const sun = createSun(glowTex);
    this.scene.add(sun.mesh);
    this.environment.updateEphemeris(this.simTime);
    const sunLight = new THREE.DirectionalLight(0xfff4e0, C.SUN_INTENSITY);
    const sunDir0 = this.environment.sunDir;
    sunLight.position.set(sunDir0.x * 1e5, sunDir0.y * 1e5, sunDir0.z * 1e5);
    this.scene.add(sunLight);
    this.scene.add(this.moonMesh);
    const starsMesh = createStars();
    this.scene.add(starsMesh);
    const earth = createEarth();
    this.scene.add(earth.group);
    return { ambient, glowTex, sun, sunLight, starsMesh, earth };
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
    this.scene.add(this.trajOverlay.line.group);
  }

  // マヌーバ噴射プルーム(推力方向の逆側に置く発光ビルボード 2 枚)
  private buildThrustPlumes(): { core: THREE.Mesh; outer: THREE.Mesh; } {
    const core = buildFlashMesh(this.glowTex, 0xaee6ff);
    const outer = buildFlashMesh(this.glowTex, 0x4f9fff);
    core.visible = false;
    outer.visible = false;
    this.scene.add(core);
    this.scene.add(outer);
    return { core, outer };
  }

  // RCS パフ(機首側の 4 基のスラスタブロックに対応、ships.ts の配置と一致)
  private buildRcsPuffs(): void {
    for (let i = 0; i < 4; i++) {
      const puff = buildFlashMesh(this.glowTex, 0xcfeaff);
      puff.visible = false;
      this.rcsPuffs.push(puff);
      this.scene.add(puff);
    }
  }

  // マガジンベルト(未使用の実弾入りマガジン): 機体左面(+X)に垂直に連結する。
  // 先頭リンクは機体に半分取り込まれた位置に置く(給弾中もベルトごと
  // 取り込まれている見た目)。ゲーム開始時は空のマガジンは一切表示されず、
  // 弾を撃ち尽くすたびに機体反対側(-X)からフレームだけの空マガジンが
  // デブリとして放出される(spawnEjectedMagazineFrame 参照)。
  private buildBeltLinks(): void {
    for (let i = 0; i < C.BELT_MAX_VISIBLE; i++) {
      const link = buildMagazineMesh();
      link.position.x = 0.9 + i * MAG_BELT_PITCH;
      this.beltGroup.add(link);
      this.beltLinks.push(link);
    }
    this.player.obj.add(this.beltGroup);
  }

  private spawnInitialEnemies(playerState: OrbitState): void {
    for (const spec of this.stageDirector.makeEnemySpecs(playerState, this.stage)) {
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
      );
      this.enemies.push(enemy);
      this.scene.add(enemy.obj);
      const line = new OrbitLine(0x565b63, 0.35);
      this.enemyOrbitLines.push(line);
      this.scene.add(line.line);
    }
  }

  // ステージ別の初期弾薬・初期補給の配置と作戦目標のブリーフィング表示
  private initStage(): void {
    const data = resolveStageInitData(this.stage, this.enemies.length);
    const stageDef = getStageDefinition(this.stage);
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
    return this.mapMode ? this.mapView.camera : this.camera;
  }

  private get mapMode(): boolean {
    return this.maneuver.mapMode;
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
    this.player.updateHpRegen(dt, !this.paused && this.phase === 'playing');
    this.syncMapModeWithPhase();
    if (this.isFrameSimulating()) {
      this.runPlayingFrame(dt);
    } else {
      this.handleIdleFrame();
    }
    if (this.phase !== 'playing') {
      this.coastWorld(dt);
    }
    this.pipRenderer.syncFineAttitude(
      this.player.isFiring,
      (prevFiring, nowFiring) => this.player.setFineAttitudeFromFiring(prevFiring, nowFiring),
    );
    this.syncRender(dt);
  }

  private syncMapModeWithPhase(): void {
    this.maneuver.syncMapModeWithPhase(this.phase, this.touchControls);
  }

  private isFrameSimulating(): boolean {
    return !this.paused && this.phase === 'playing';
  }

  private runPlayingFrame(dt: number): void {
    this.simulate(dt);
    this.target = this.playModes.update(
      {
        mapMode: this.mapMode,
        player: this.player,
        enemies: this.enemies,
        planner: this.planner,
        plannerCtx: this.plannerCtx(),
        mapView: this.mapView,
        input: this.input,
        dt,
        activeCamera: this.activeCamera,
        fineAttitude: this.player.fineAttitude,
        project: (rel) => this.hudProjection.project(rel),
      },
      this.target,
    );
    if (this.stage === -1) this.stageDirector.updateStage00(dt, this.stageCtx());
    if (this.stage === 0) this.stageDirector.updateStage0Timer(dt, this.stageCtx());
  }

  private handleIdleFrame(): void {
    this.lastSimDt = 0;
    this.sfx.setThrust(false);
    this.player.clearTransientState();
    this.input.takeClicks();
    this.input.takeRightClicks();
    this.player.stopFiring();
  }

  private warp(): number {
    return C.WARP_LEVELS[this.warpIdx]!;
  }

  private handleEdgeInput(): void {
    for (const code of this.input.takePresses()) {
      this.handleEdgePress(code);
    }
  }

  private handleEdgePress(code: string): void {
    switch (code) {
      case 'KeyT': this.player.toggleRcsDamp(this.hud); break;
      case 'KeyF': this.player.enableProgradeReset(this.hud); break;
      case 'KeyV': this.player.toggleFineAttitude(this.hud); break;
      case 'KeyC': this.player.toggleProgradeHold(this.hud); break;
      case 'KeyG': this.chase.toggleFollowAttitude(this.hud); break;
      case 'Digit1': this.player.setThrottlePreset(0, this.hud); break;
      case 'Digit2': this.player.setThrottlePreset(1, this.hud); break;
      case 'Digit3': this.player.setThrottlePreset(2, this.hud); break;
      case 'Comma': this.warpIdx = this.maneuver.adjustWarp(this.warpIdx, -1); break;
      case 'Period': this.warpIdx = this.maneuver.adjustWarp(this.warpIdx, 1); break;
      case 'KeyM': this.maneuver.toggleMap(this.phase, this.touchControls); break;
      case 'KeyN': this.maneuver.toggleAutoWarpToFirstNode(this.phase); break;
      case 'KeyX': this.maneuver.clearPlanByKey(); break;
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
    this.sfx.playReload();
  }

  // ------------------------------------------------------- maneuver planning

  // 選択中ノードの Δv アーム(mapgizmo.ts)ドラッグを Δv 成分の変更へ変換する。
  // axis: 0=プログレード(dv.x) 1=法線(dv.y) 2=動径(dv.z)。sign はハンドル自身の向き
  // (mapgizmo.ts の AxisHandleSpec 参照)。deltaPx はポインタ移動のハンドル方向への射影量。
  // MapPlanner の各メソッド呼び出しに渡す、現在状態のスナップショット。
  private plannerCtx(): PlannerCtx {
    return this.maneuver.plannerCtx(
      this.simTime,
      this.player.state.r,
      this.player.state.v,
      this.environment.sunPhase0,
      this.environment.moonPhase0,
    );
  }

  // StageDirector の各メソッド呼び出しに渡す、現在状態のスナップショット
  // (enemies / enemyOrbitLines / scene は参照渡しでミューテートされる)。
  private stageCtx(): StageCtx {
    return {
      phase: this.phase,
      player: this.player,
      enemies: this.enemies,
      enemyOrbitLines: this.enemyOrbitLines,
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
  // (enemies / bullets / plasmaBullets / casings / debris / effects / boardMarks /
  private combatCtx(): CombatCtx {
    const ctx: CombatCtx = {
      simTime: this.simTime,
      player: this.player,
      enemies: this.enemies,
      target: this.target,
      stage: this.stage,
      zoomActive: this.zoomActive,
      scene: this.scene,
      glowTex: this.glowTex,
      bullets: this.bullets,
      plasmaBullets: this.plasmaBullets,
      casings: this.casings,
      debris: this.debris,
      effects: this.effects,
      boardMarks: this.markers.boardMarks,
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
  private markersCtx(): MarkersCtx {
    return {
      mapMode: this.mapMode,
      player: this.player,
      enemies: this.enemies,
      target: this.target,
      magPickups: this.ammoResupply.list,
      mapLabelIds: this.mapView.labels.map((l) => l.id),
      activeCamera: this.activeCamera,
      touchControls: this.touchControls,
      simTime: this.simTime,
      solveLeadTime: (relP, relV, s) => this.combat.solveLeadTime(relP, relV, s),
      warp: this.warp(),
      paused: this.paused,
      rcsDamp: this.player.rcsDamp,
      throttleIdx: this.player.throttleIdx,
      fineAttitude: this.player.fineAttitude,
      progradeHold: this.player.progradeHold,
      camFollowAttitude: this.chase.camFollowAttitude,
      roundsInMag: this.player.roundsInMag,
      magsLeft: this.player.magsLeft,
      reloadTimer: this.player.reloadTimer,
      alt: this.altitudeOf(this.player.state.r),
      altDescending: this.environment.altDescendWarned,
      qdyn: this.environment.qdyn,
      hullTemp: this.environment.hullTemp,
      shots: this.combat.shots,
      kills: this.combat.kills,
      totalEnemies: this.enemies.length,
      stage: this.stage,
      stage00WaveCount: this.stageDirector.stage00WaveCount,
      stage0TimeLeft: this.stageDirector.stage0TimeLeft,
    };
  }

  private collisionCtx() {
    return {
      player: this.player,
      enemies: this.enemies,
      casings: this.casings,
      magPickups: this.ammoResupply.list,
      debris: this.debris,
      belt: this.belt,
    };
  }

  // ------------------------------------------------------------- simulate

  private simulate(dt: number): void {
    this.updateAutoWarpTarget();
    const warp = this.warp();
    const simDt = dt * warp;
    const canAct = warp <= C.MAX_PHYS_WARP && this.player.alive && !this.mapMode;
    const rawWantFire = this.readRawWantFire(warp);
    this.player.updateFireState({
      dt,
      rawWantFire,
      warp,
      mapMode: this.mapMode,
      onEmptyClick: () => {
        this.sfx.emptyClick();
        this.hud.hint('弾薬切れ — 軌道上の補給マガジン ▣ を回収せよ', 3000);
      },
      onSpinUp: () => this.sfx.spinUp(),
      onFire: (ammoEvent) => {
        this.combat.fireGun(this.combatCtx());
        if (ammoEvent === 'mag') {
          this.combat.spawnEjectedMagazineFrame(this.combatCtx());
          this.sfx.magFeed();
        } else if (ammoEvent === 'reload') {
          this.combat.spawnEjectedMagazineFrame(this.combatCtx());
          this.combat.dropBarrel(this.combatCtx());
          this.sfx.playReload();
        }
      },
    });
    const thrustFn = this.updateThrustState(canAct);
    const playerAccel = this.buildPlayerAccel(thrustFn);
    this.integrateSimulation(simDt, warp, playerAccel);
    this.handlePostSimulation(dt, simDt, warp, canAct);
  }

  private updateAutoWarpTarget(): void {
    const result = this.maneuver.updateAutoWarp(this.simTime, this.warpIdx);
    this.warpIdx = result.warpIdx;
    if (result.hint) this.hud.hint(result.hint, 5000);
  }

  private readRawWantFire(warp: number): boolean {
    const rawWantFire = !this.mapMode && (this.input.down('Space') || this.input.mouseFiring);
    if (rawWantFire && this.player.alive && warp > C.MAX_PHYS_WARP) {
      this.hud.hint(`射撃・推進はワープ ×${C.MAX_PHYS_WARP} 以下でのみ可能`);
    }
    return rawWantFire;
  }

  private updateThrustState(canAct: boolean): ExtraAccel | null {
    const thrustFn = canAct ? this.player.buildThrustAccel(this.input, this.mapMode) : null;
    this.sfx.setThrust(thrustFn !== null);
    this.player.updateThrustVisual(thrustFn);
    return thrustFn;
  }

  private buildPlayerAccel(thrustFn: ExtraAccel | null): ExtraAccel {
    return thrustFn ? (r, v) => add(thrustFn(r, v), this.environment.envShip(r, v)) : this.environment.envShip;
  }

  private integrateSimulation(simDt: number, warp: number, playerAccel: ExtraAccel): void {
    const nSub = warp <= C.MAX_PHYS_WARP ? 1 : Math.min(64, Math.ceil(simDt / 20));
    const sub = simDt / nSub;
    for (let i = 0; i < nSub; i++) {
      this.integrateSimulationSubstep(sub, playerAccel);
    }
  }

  private integrateSimulationSubstep(sub: number, playerAccel: ExtraAccel): void {
    this.environment.updateEphemeris(this.simTime);
    this.player.prevR = clone(this.player.state.r);
    if (this.player.alive) {
      stepOrbitRK4(this.player.state, sub, playerAccel);
      this.environment.updateThermal(sub, this.player.state.r, this.player.state.v);
    }
    for (const e of this.enemies) {
      if (!e.alive) continue;
      e.prevR = clone(e.state.r);
      stepOrbitRK4(e.state, sub, this.environment.envShip);
    }
    for (const b of this.bullets) {
      if (!b.alive) continue;
      b.prevR = clone(b.state.r);
      stepOrbitRK4(b.state, sub, this.environment.envBullet);
    }
    for (const pb of this.plasmaBullets) {
      if (!pb.alive) continue;
      pb.prevR = clone(pb.state.r);
      stepOrbitRK4(pb.state, sub, this.environment.envBullet);
    }
    for (const cs of this.casings) stepOrbitRK4(cs.state, sub, this.environment.envSmall);
    for (const d of this.debris) stepOrbitRK4(d.state, sub, this.environment.envSmall);
    this.ammoResupply.stepOrbits(sub, this.environment.envSmall);
    this.simTime += sub;
    this.combat.checkBulletHits(this.combatCtx());
    this.combat.checkBoardCrossings(this.combatCtx());
  }

  private handlePostSimulation(dt: number, simDt: number, warp: number, canAct: boolean): void {
    this.lastSimDt = simDt;
    this.applyThermalLimitLoss(this.environment.checkThermalLimits(this.player.alive));
    this.environment.updateAltitudeAlarm(dt, this.player.alive, this.environment.altitudeOf(this.player.state.r));
    this.updateAmmoLogistics(dt);
    if (warp <= C.MAX_PHYS_WARP) {
      this.collisionPhysics.resolve(dt, this.collisionCtx(), () => {
        if (this.clankCd > 0) return;
        this.sfx.clank();
        this.clankCd = C.CASING_CLANK_COOLDOWN;
      });
    }
    this.updateAttitudes(Math.min(simDt, 0.12));
    this.cleanup();
    if (this.stage === -1 && this.phase === 'playing' && canAct) {
      this.combat.updateEnemyAI(dt, this.combatCtx());
    }
  }

  private applyThermalLimitLoss(limit: 'heat' | 'dynpressure' | null): void {
    const reason = this.player.lossReasonByThermalLimit(limit);
    if (!reason) return;
    this.lostReason = reason;
    this.combat.destroyShip(this.player, this.combatCtx());
  }

  private updateAttitudes(attDt: number): void {
    this.player.updateAttitude(this.input, this.mapMode, attDt, () => {
      this.hud.hint('進行方向ホールド解除(手動操作)');
    });
    for (const e of this.enemies) if (e.alive) stepAttitude(e.att, v3(), attDt);
    for (const cs of this.casings) stepAttitude(cs.att, v3(), attDt);
    for (const d of this.debris) stepAttitude(d.att, v3(), attDt);
    this.ammoResupply.stepAttitudes(attDt);
  }

  // 弾薬まわりの毎フレーム処理: 補給の取り込み・低残弾時の補給投入。
  // 薬莢の接触音は resolvePhysicalCollisions() の実衝突イベントから直接鳴らす
  // (このメソッドでは this.clankCd のレート制限だけを実時間 dt で減算する)。
  private updateAmmoLogistics(dt: number): void {
    this.clankCd -= dt;
    this.ammoResupply.updateLogistics(this.simTime, this.player);
  }

  // 自機軌道の少し先(同一軌道を位相シフト)に補給マガジンを投入する。
  // 既定は 1.25〜2.5km 先(通常ステージの残弾補給用、従来の半分の距離)。第零ステージの
  // 開始時配置ではより近い距離を明示的に渡す。
  private spawnMagPickup(minDist = C.AMMO_RESUPPLY_MIN_DIST, maxDist = C.AMMO_RESUPPLY_MAX_DIST): void {
    this.ammoResupply.spawnForPlayer(this.player, minDist, maxDist);
  }

  // 勝敗確定後もデブリ・薬莢・弾を漂わせる
  private coastWorld(dt: number): void {
    const simDt = dt * Math.min(this.warp(), 4);
    this.environment.updateEphemeris(this.simTime);
    for (const b of this.bullets) if (b.alive) stepOrbitRK4(b.state, simDt, this.environment.envBullet);
    for (const cs of this.casings) stepOrbitRK4(cs.state, simDt, this.environment.envSmall);
    for (const d of this.debris) stepOrbitRK4(d.state, simDt, this.environment.envSmall);
    for (const e of this.enemies) if (e.alive) stepOrbitRK4(e.state, simDt, this.environment.envShip);
    this.ammoResupply.stepOrbits(simDt, this.environment.envSmall);
    const attDt = Math.min(simDt, 0.12);
    for (const cs of this.casings) stepAttitude(cs.att, v3(), attDt);
    for (const d of this.debris) stepAttitude(d.att, v3(), attDt);
    this.ammoResupply.stepAttitudes(attDt);
    this.simTime += simDt;
    this.lastSimDt = simDt;
  }

  // ------------------------------------------------------------- cleanup

  private altitudeOf(r: Vec3): number {
    return this.environment.altitudeOf(r);
  }

  private cleanup(): void {
    // 自機の構造限界高度(通常は加熱・動圧で先に喪失する)
    const playerLossReason = this.player.lossReasonByAltitude(this.altitudeOf(this.player.state.r));
    if (playerLossReason) {
      this.lostReason = playerLossReason;
      this.combat.destroyShip(this.player, this.combatCtx());
    }
    for (const e of this.enemies) {
      if (e.alive && this.altitudeOf(e.state.r) < C.REENTRY_ALT) {
        // 再突入による空力分解はプレイヤーによる撃破ではないためカウントしない
        this.combat.destroyShip(e, this.combatCtx(), false);
      }
    }

    this.bullets = this.bullets.filter((b) => {
      const expired =
        !b.alive ||
        this.simTime - b.bornSim > C.BULLET_LIFETIME ||
        this.altitudeOf(b.state.r) < C.DEBRIS_REENTRY_ALT;
      if (expired) this.scene.remove(b.obj);
      return !expired;
    });

    this.plasmaBullets = this.plasmaBullets.filter((pb) => {
      const expired =
        !pb.alive ||
        this.simTime - pb.bornSim > C.PLASMA_LIFETIME ||
        this.altitudeOf(pb.state.r) < C.DEBRIS_REENTRY_ALT;
      if (expired) this.scene.remove(pb.obj);
      return !expired;
    });

    this.casings = this.casings.filter((cs) => {
      const expired =
        this.simTime - cs.bornSim > C.CASING_LIFETIME ||
        this.altitudeOf(cs.state.r) < C.DEBRIS_REENTRY_ALT;
      if (expired) this.scene.remove(cs.obj);
      return !expired;
    });

    this.debris = this.debris.filter((d) => {
      const expired = this.altitudeOf(d.state.r) < C.DEBRIS_REENTRY_ALT;
      if (expired) this.combat.removeDebrisObj(this.combatCtx(), d);
      return !expired;
    });

    this.ammoResupply.cleanup(this.stage, this.player, (r) => this.altitudeOf(r));
  }

  // --------------------------------------------------------- render sync

  private syncRender(dt: number): void {
    const o = this.player.state.r;
    const pv = this.player.state.v;
    const displayTime = this.resolveDisplayTime();
    this.syncRenderEarth(dt, o, displayTime);
    const cam = this.syncRenderCamera(dt, o, pv);
    this.syncRenderSkyBodies(displayTime, o, cam);
    this.syncRenderLighting(o);
    this.syncRenderThrust();
    this.syncRenderRcs();
    this.syncRenderDynamicObjects(dt, o, pv);
    this.syncRenderEffects(dt, o);
    this.syncRenderHud(dt, o, pv);
  }

  private resolveDisplayTime(): number {
    const duration = this.trajOverlay.predictDurationSec(this.plannerCtx());
    return this.mapMode && this.mapView.sliderT > 0 ? this.mapView.displayTime(this.simTime, duration) : this.simTime;
  }

  private syncRenderEarth(dt: number, o: Vec3, displayTime: number): void {
    this.earth.group.position.set(-o.x, -o.y, -o.z);
    this.earth.setRotation(this.earthPhase0 + (2 * Math.PI * displayTime) / SIDEREAL_DAY);
    this.earth.tick(dt, displayTime);
  }

  private syncRenderCamera(dt: number, o: Vec3, pv: Vec3): THREE.PerspectiveCamera {
    const mouse = this.input.consumeMouse();
    const keyYaw = (this.input.down('ArrowLeft') ? 1 : 0) + (this.input.down('ArrowRight') ? -1 : 0);
    const keyPitch = (this.input.down('ArrowDown') ? 1 : 0) + (this.input.down('ArrowUp') ? -1 : 0);
    return this.cameraSystem.updateActiveCamera({
      mapMode: this.mapMode,
      zoomActive: this.zoomActive,
      simTime: this.simTime,
      sunPhase0: this.environment.sunPhase0,
      player: this.player,
      mapView: this.mapView,
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

  private syncRenderSkyBodies(displayTime: number, o: Vec3, cam: THREE.PerspectiveCamera): void {
    const visSunPos = sunPosition(displayTime, this.environment.sunPhase0);
    const sd = norm(visSunPos);
    this.earth.setSunDir(sd.x, sd.y, sd.z);
    this.starsMesh.position.copy(cam.position);
    this.starsMesh.scale.setScalar(this.mapMode ? (this.mapView.camera.far * 0.9) / 3.5e7 : 1.0);
    this.sun.mesh.position.set(
      cam.position.x + sd.x * SUN_DISTANCE,
      cam.position.y + sd.y * SUN_DISTANCE,
      cam.position.z + sd.z * SUN_DISTANCE,
    );
    this.sun.mesh.quaternion.copy(cam.quaternion);
    this.sunLight.position.set(sd.x * 1e5, sd.y * 1e5, sd.z * 1e5);
    const visMoonPos = moonPosition(displayTime, this.environment.moonPhase0);
    const moonRel = sub(visMoonPos, o);
    if (this.mapMode) {
      this.moonMesh.position.set(moonRel.x, moonRel.y, moonRel.z);
      this.moonMesh.scale.setScalar(R_MOON);
    } else {
      this.cameraSystem.placeCombatMoon(this.moonMesh, cam, moonRel, R_MOON, MOON_VIS_DIST);
    }
    this.moonMesh.lookAt(
      this.moonMesh.position.x - visMoonPos.x,
      this.moonMesh.position.y - visMoonPos.y,
      this.moonMesh.position.z - visMoonPos.z
    );
  }

  private syncRenderLighting(o: Vec3): void {
    const lit = this.mapMode ? 1.0 : this.environment.shadowLitFactor(o);
    this.sunLight.intensity = C.SUN_INTENSITY * (C.SHADOW_MIN_SUN + (1 - C.SHADOW_MIN_SUN) * lit);
    this.ambient.intensity =
      C.AMBIENT_INTENSITY * (C.SHADOW_MIN_AMBIENT + (1 - C.SHADOW_MIN_AMBIENT) * lit);
  }

  private syncRenderThrust(): void {
    this.player.renderThrustEffects(this.plumeCore, this.plumeOuter, this.camera, this.zoomActive);
  }

  private syncRenderRcs(): void {
    this.sfx.setRcs(
      this.player.updateRcsEffects(
        this.input,
        this.rcsPuffs,
        this.activeCamera,
        this.zoomActive,
        this.phase === 'playing',
        this.paused,
        this.mapMode,
      ),
    );
  }

  private syncRenderDynamicObjects(dt: number, o: Vec3, pv: Vec3): void {
    this.renderDynamicsSystem.render({
      dt,
      origin: o,
      playerVelocity: pv,
      player: this.player,
      enemies: this.enemies,
      bullets: this.bullets,
      plasmaBullets: this.plasmaBullets,
      casings: this.casings,
      magPickups: this.ammoResupply.list,
      debris: this.debris,
      belt: this.belt,
      magsLeft: this.player.magsLeft,
      roundsInMag: this.player.roundsInMag,
      camera: this.camera,
      zoomActive: this.zoomActive,
    });
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
    this.hudSyncSystem.sync({
      dt,
      origin: o,
      playerVelocity: pv,
      mapMode: this.mapMode,
      playerAlive: this.player.alive,
      planner: this.planner,
      plannerCtx: this.plannerCtx(),
      markersCtx: this.markersCtx(),
      orbitLineCtx: {
        mapMode: this.mapMode,
        simTime: this.simTime,
        origin: o,
        playerVelocity: pv,
        player: this.player,
        target: this.target,
        enemies: this.enemies,
        enemyOrbitLines: this.enemyOrbitLines,
        environment: this.environment,
        planner: this.planner,
        plannerCtx: this.plannerCtx(),
        mapView: this.mapView,
        trajOverlay: this.trajOverlay,
        playerOrbitLine: this.playerOrbitLine,
        targetOrbitLine: this.targetOrbitLine,
        plannedOrbitLine: this.plannedOrbitLine,
        geoOrbitLine: this.geoOrbitLine,
        moonOrbitLine: this.moonOrbitLine,
        project: (rel) => this.hudProjection.project(rel),
      },
      project: (rel) => this.hudProjection.project(rel),
      onGuideAchieved: () => this.maneuver.onGuideAchieved(),
    });
  }

  // ズームウィンドウ(PIP)のオーバーレイ更新。実処理は markers.ts へ委譲。
  private updatePipOverlay(rect: PipRect | null): void {
    this.markers.updatePipOverlay(this.markersCtx(), rect);
  }

  public renderFrame(): void {
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
