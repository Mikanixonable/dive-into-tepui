// ゲーム全体のオーケストレーション: エンティティ管理、物理積分、
// 入力 → 推力/トルク変換、衝突判定、勝敗判定、描画同期。
//
// 座標系: ECI (慣性系)、Y軸 = 北極、単位 m / m/s。
// 描画は自機中心のフローティングオリジン(自機が常に (0,0,0))。
import * as THREE from 'three/webgpu';
import {
  OrbitState,
  SIDEREAL_DAY,
} from '../physics/orbital';
import {
  R_MOON,
  moonPosition,
  sunPosition,
} from '../physics/ephemeris';
import {
  randomQuat,
} from '../physics/attitude';
import {
  Vec3,
  norm,
  randSym,
  sub,
  v3,
} from '../physics/vec3';
import { PlannerCtx } from './map-mode/planner';
import { BeltPhysics } from './combat/belt';
import { Player } from './player';
import { CameraSystem } from './camera/camera-system';
import { CombatCtx, CombatSystem } from './combat/combat';
import { StageCtx, StageDirector } from './stage-director';
import { ThermalSystem } from './thermal';
import { EphemerisSystem } from './ephemeris';
import { MarkerCtx, MarkersSystem } from '../hud/markers';
import { HudPanelCtx } from '../hud/panel';
import { CollisionPhysics } from './combat/collision';
import { EffectsSystem, FlashEffect } from './effects-system';
import { OrbitLineSystem } from './orbit-line-system';
import { RenderDynamicsSystem } from './render-dynamics';
import { getStageDefinition, resolveStageInitData } from './stage-data';
import { Targeter } from './combat/targeter';
import { HudProjection } from './camera/projection';
import { AmmoResupplySystem } from './combat/ammo-resupply';
import { ManeuverSystem } from './map-mode/maneuver-system';
import { PipRect, PipRenderer } from './pip-renderer';
import { altitudeOf, Simulator, SimulatorCtx } from './simulator';
import * as C from './const';
import { Enemy } from './entities';
import { Input } from './input';
import { TouchControls } from './touch';
import { ChaseCamera } from './camera/chase-camera';
import { Hud } from '../hud/hud';
import { Sfx } from '../audio/sfx';
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
  buildMagazineMesh,
} from '../render/ships';
import { OrbitLine } from '../render/orbitline';

type GamePhase = 'playing' | 'won' | 'lost' | 'timeup';

interface EnvironmentScene {
  ambient: THREE.AmbientLight;
  sun: Sun;
  sunLight: THREE.DirectionalLight;
  starsMesh: THREE.Mesh;
  moonMesh: THREE.Mesh;
  earth: Earth;
}

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
  private readonly enemyOrbitLines: OrbitLine[] = [];
  private readonly geoOrbitLine = new OrbitLine(0x8b93a0, 0.2);
  private readonly moonOrbitLine = new OrbitLine(0xaab3c0, 0.2);

  //readonly stage: number;

  // 軌道計画モード
  private readonly maneuver = new ManeuverSystem(
    this.hud,
    this.sfx,
    (rel) => this.hudProjection.project(rel),
    () => this.player.fineAttitude,
  );

  private phase: GamePhase = 'playing';
  // ステージ構成・ウェーブ生成・ステージ専用タイマー(stages.ts参照)。
  private readonly stageDirector: StageDirector;
  private simTime = 0;
  private lastSimDt = 0;
  private warpIdx = 0;
  private paused = false;

  private target: Enemy | null = null;
  private zoomActive = false;

  // 天体暦(太陽・月の位置と日照率)は ephemeris.ts、自機の熱/動圧・高度警告は
  // thermal.ts に切り出し済み。
  private readonly ephemeris = new EphemerisSystem();
  private readonly thermal = new ThermalSystem(this.hud, this.sfx);
  private lostReason = '大気圏に突入し機体を喪失した';

  // --- 弾薬・マガジン ---
  private readonly beltGroup = new THREE.Group();
  private readonly beltLinks: THREE.Group[] = [];
  // ベルトのたわみ・ねじれの物理演算(Verlet 積分 + 距離拘束)は belt.ts の
  // BeltPhysics に切り出し済み。beltLinks(表示メッシュ)を注入して構築する
  // (メッシュ自体は下の constructor で beltGroup に積む)。
  private readonly belt = new BeltPhysics(this.beltLinks);
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
  private readonly renderDynamicsSystem = new RenderDynamicsSystem();
  private readonly cameraSystem = new CameraSystem();
  private readonly targeter = new Targeter(this.hud);
  private readonly hudProjection = new HudProjection(() => this.activeCamera);
  private readonly ammoResupply: AmmoResupplySystem;
  private readonly simulator: Simulator;
  private readonly pipRenderer = new PipRenderer();
  private readonly earthPhase0 = Math.random() * Math.PI * 2;

  private get planner() { return this.maneuver.planner; }
  private get mapView() { return this.maneuver.mapView; }
  private get trajOverlay() { return this.maneuver.trajOverlay; }

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
    this.ammoResupply = new AmmoResupplySystem(this.scene, this.hud, this.sfx);
    this.simulator = new Simulator(this.ephemeris, this.thermal, this.ammoResupply, this.combat, this.scene);

    // 汎用発光テクスチャ
    this.glowTex = makeGlowTexture();

    // --- 環境 ---
    this.environment = this.buildEnvironmentScene(this.glowTex);
    
    this.addOrbitLines();

    // --- 自機: 高度420km・傾斜51.6°の円軌道 ---
    this.player = new Player(this.hud, this.sfx, this.scene, this.glowTex);
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

  private buildEnvironmentScene(glowTex: THREE.Texture): EnvironmentScene {
    const ambient = new THREE.AmbientLight(0x8899bb, 0.25);
    this.scene.add(ambient);
    const sun = createSun(glowTex);
    this.scene.add(sun.mesh);
    this.ephemeris.update(this.simTime);
    const sunLight = new THREE.DirectionalLight(0xfff4e0, C.SUN_INTENSITY);
    const sunDir0 = this.ephemeris.sunDir;
    sunLight.position.set(sunDir0.x * 1e5, sunDir0.y * 1e5, sunDir0.z * 1e5);
    this.scene.add(sunLight);
    const moonMesh = createMoon();
    this.scene.add(moonMesh);
    const starsMesh = createStars();
    this.scene.add(starsMesh);
    const earth = createEarth();
    this.scene.add(earth.group);
    return { ambient, sun, sunLight, starsMesh, earth, moonMesh };
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
      );
      this.addEnemy(enemy, 0x565b63);
    }
  }

  // 敵の追加は Simulator への登録(配列 + scene)と軌道線の生成を常に対で行う
  // (enemyOrbitLines は enemies とインデックス対応の並行配列)。
  private addEnemy(enemy: Enemy, orbitLineColor: number): void {
    this.simulator.addEnemy(enemy);
    const line = new OrbitLine(orbitLineColor, 0.35);
    this.enemyOrbitLines.push(line);
    this.scene.add(line.line);
  }

  // ステージ別の初期弾薬・初期補給の配置と作戦目標のブリーフィング表示
  private initStage(): void {
    const data = resolveStageInitData(this.stageDirector.stage, this.simulator.enemies.length);
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
    this.maneuver.syncMapModeWithPhase(this.phase, this.touchControls);

    this.handleFrame(dt);

    this.pipRenderer.syncFineAttitude(
      this.player.isFiring,
      (prevFiring, nowFiring) => this.player.setFineAttitudeFromFiring(prevFiring, nowFiring),
    );
    this.syncRender(dt);
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
        this.warp(),
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
    // プレイヤーのアクション更新
    this.player.updateHpRegen(dt);
    this.updateAutoWarpTarget();
    const warp = this.warp();
    const simDt = dt * warp;
    const action = this.player.updateActionState({
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
      this.planner.updateEditing(
        dt,
        this.plannerCtx(),
        this.input,
        (rel) => this.hudProjection.project(rel), {
        fineAttitude: this.player.fineAttitude,
        mapSliderT: this.mapView.sliderT,
        mapFocus: this.mapView.focus,
        labels: this.mapView.labels,
      });
    }
    else {
      this.target = this.targeter.updateCombatTargeting(
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
      case 'KeyT': this.player.toggleRcsDamp(); break;
      case 'KeyF': this.player.enableProgradeReset(); break;
      case 'KeyV': this.player.toggleFineAttitude(); break;
      case 'KeyC': this.player.toggleProgradeHold(); break;
      case 'KeyG': this.chase.toggleFollowAttitude(this.hud); break;
      case 'Digit1': this.player.setThrottlePreset(0); break;
      case 'Digit2': this.player.setThrottlePreset(1); break;
      case 'Digit3': this.player.setThrottlePreset(2); break;
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
      this.ephemeris.sunPhase0,
      this.ephemeris.moonPhase0,
    );
  }

  // StageDirector の各メソッド呼び出しに渡す、現在状態のスナップショット
  // (敵の追加は addEnemy 経由、既存要素は参照渡しでミューテートされる)。
  private stageCtx(): StageCtx {
    return {
      phase: this.phase,
      player: this.player,
      enemies: this.simulator.enemies,
      enemyOrbitLines: this.enemyOrbitLines,
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
      target: this.target,
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
      target: this.target,
      magPickups: this.ammoResupply.list,
      mapLabelIds: this.mapView.labels.map((l) => l.id),
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
      target: this.target,
      touchControls: this.touchControls,
      simTime: this.simTime,
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
      alt: altitudeOf(this.player.state.r),
      altDescending: this.thermal.altDescendWarned,
      qdyn: this.thermal.qdyn,
      hullTemp: this.thermal.hullTemp,
      shots: this.combat.shots,
      kills: this.combat.kills,
      totalEnemies: this.simulator.enemies.length,
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
      magPickups: this.ammoResupply.list,
      debris: this.simulator.debris,
      belt: this.belt,
    };
  }

  private simulatorCtx(): SimulatorCtx {
    return {
      player: this.player,
      combatCtx: (simTime) => this.combatCtx(simTime),
    };
  }

  // ------------------------------------------------------------- simulate

  private updateAutoWarpTarget(): void {
    const result = this.maneuver.updateAutoWarp(this.simTime, this.warpIdx);
    this.warpIdx = result.warpIdx;
    if (result.hint) this.hud.hint(result.hint, 5000);
  }

  private handlePostSimulation(dt: number, simDt: number, warp: number, canAct: boolean): void {
    this.applyThermalLimitLoss(this.thermal.checkThermalLimits(this.player.alive));
    this.thermal.updateAltitudeAlarm(dt, this.player.alive, altitudeOf(this.player.state.r));
    this.ammoResupply.updateLogistics(this.simTime, this.player);
    if (warp <= C.MAX_PHYS_WARP) {
      this.collisionPhysics.resolve(dt, this.collisionCtx(), () => {
        this.sfx.clank();
      });
    }
    this.updateAttitudes(Math.min(simDt, 0.12));

    this.simulator.cleanup(this.player, this.combatCtx(), this.simTime);

    this.ammoResupply.cleanup(this.stageDirector.stage, this.player, (r) => altitudeOf(r));
    if (this.stageDirector.stage === -1 && this.phase === 'playing' && canAct) {
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
    this.simulator.stepCoastingAttitudes(attDt);
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
    this.environment.earth.group.position.set(-o.x, -o.y, -o.z);
    this.environment.earth.setRotation(this.earthPhase0 + (2 * Math.PI * displayTime) / SIDEREAL_DAY);
    this.environment.earth.tick(dt, displayTime);
  }

  private syncRenderCamera(dt: number, o: Vec3, pv: Vec3): THREE.PerspectiveCamera {
    const mouse = this.input.consumeMouse();
    const keyYaw = (this.input.down('ArrowLeft') ? 1 : 0) + (this.input.down('ArrowRight') ? -1 : 0);
    const keyPitch = (this.input.down('ArrowDown') ? 1 : 0) + (this.input.down('ArrowUp') ? -1 : 0);
    return this.cameraSystem.updateActiveCamera({
      mapMode: this.mapMode,
      zoomActive: this.zoomActive,
      simTime: this.simTime,
      sunPhase0: this.ephemeris.sunPhase0,
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
    const visSunPos = sunPosition(displayTime, this.ephemeris.sunPhase0);
    const sd = norm(visSunPos);
    this.environment.earth.setSunDir(sd.x, sd.y, sd.z);
    this.environment.starsMesh.position.copy(cam.position);
    this.environment.starsMesh.scale.setScalar(this.mapMode ? (this.mapView.camera.far * 0.9) / 3.5e7 : 1.0);
    this.environment.sun.mesh.position.set(
      cam.position.x + sd.x * SUN_DISTANCE,
      cam.position.y + sd.y * SUN_DISTANCE,
      cam.position.z + sd.z * SUN_DISTANCE,
    );
    this.environment.sun.mesh.quaternion.copy(cam.quaternion);
    this.environment.sunLight.position.set(sd.x * 1e5, sd.y * 1e5, sd.z * 1e5);
    const visMoonPos = moonPosition(displayTime, this.ephemeris.moonPhase0);
    const moonRel = sub(visMoonPos, o);
    if (this.mapMode) {
      this.environment.moonMesh.position.set(moonRel.x, moonRel.y, moonRel.z);
      this.environment.moonMesh.scale.setScalar(R_MOON);
    } else {
      this.cameraSystem.placeCombatMoon(this.environment.moonMesh, cam, moonRel, R_MOON, MOON_VIS_DIST);
    }
    this.environment.moonMesh.lookAt(
      this.environment.moonMesh.position.x - visMoonPos.x,
      this.environment.moonMesh.position.y - visMoonPos.y,
      this.environment.moonMesh.position.z - visMoonPos.z
    );
  }

  private syncRenderLighting(o: Vec3): void {
    const lit = this.mapMode ? 1.0 : this.ephemeris.shadowLitFactor(o);
    this.environment.sunLight.intensity = C.SUN_INTENSITY * (C.SHADOW_MIN_SUN + (1 - C.SHADOW_MIN_SUN) * lit);
    this.environment.ambient.intensity =
      C.AMBIENT_INTENSITY * (C.SHADOW_MIN_AMBIENT + (1 - C.SHADOW_MIN_AMBIENT) * lit);
  }

  private syncRenderThrust(): void {
    this.player.renderThrustEffects(this.camera, this.zoomActive);
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
    this.renderDynamicsSystem.render({
      dt,
      origin: o,
      playerVelocity: pv,
      player: this.player,
      enemies: this.simulator.enemies,
      bullets: this.simulator.bullets,
      plasmaBullets: this.simulator.plasmaBullets,
      casings: this.simulator.casings,
      magPickups: this.ammoResupply.list,
      debris: this.simulator.debris,
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
    const project = (rel: Vec3) => this.hudProjection.project(rel);
    const { playerEl, tgtEl } = this.orbitLineSystem.update({
      mapMode: this.mapMode,
      simTime: this.simTime,
      origin: o,
      playerVelocity: pv,
      player: this.player,
      target: this.target,
      enemies: this.simulator.enemies,
      enemyOrbitLines: this.enemyOrbitLines,
      ephemeris: this.ephemeris,
      planner: this.planner,
      plannerCtx: this.plannerCtx(),
      mapView: this.mapView,
      trajOverlay: this.trajOverlay,
      playerOrbitLine: this.playerOrbitLine,
      targetOrbitLine: this.targetOrbitLine,
      plannedOrbitLine: this.plannedOrbitLine,
      geoOrbitLine: this.geoOrbitLine,
      moonOrbitLine: this.moonOrbitLine,
      project,
    });

    const markerCtx = this.markerCtx();
    this.markersSystem.updateMarkers(markerCtx, pv, project);
    this.markersSystem.updateNodeMarkers(markerCtx, playerEl, tgtEl, project);
    this.markersSystem.updateBoardMarkers(markerCtx, dt, project);
    if (this.mapMode) {
      this.hud.markers.hide('burn');
    } else {
      const { achieved } = this.planner.updateGuide(
        this.plannerCtx(),
        o,
        pv,
        playerEl,
        this.player.alive,
        project,
      );
      if (achieved) this.maneuver.onGuideAchieved();
    }

    this.hud.panels.update(this.hudPanelCtx(), dt, playerEl, tgtEl);
    this.hud.tick();
  }

  // ズームウィンドウ(PIP)のオーバーレイ更新。実処理は markers.ts へ委譲。
  private updatePipOverlay(rect: PipRect | null): void {
    this.markersSystem.updatePipOverlay(this.markerCtx(), rect);
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
