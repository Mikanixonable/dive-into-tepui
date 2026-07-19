// ゲーム全体のオーケストレーション: エンティティ管理、物理積分、
// 入力 → 推力/トルク変換、衝突判定、勝敗判定、描画同期。
//
// 座標系: ECI (慣性系)、Y軸 = 北極、単位 m / m/s。
// 描画は自機中心のフローティングオリジン(自機が常に (0,0,0))。
import * as THREE from 'three/webgpu';
import {
  Elements,
  ExtraAccel,
  OrbitState,
  R_EARTH,
  MU_EARTH,
  SIDEREAL_DAY,
  elementsFromState,
  stepOrbitRK4,
} from '../physics/orbital';
import {
  R_MOON,
  moonPosition,
  sunAzimuth,
  sunPosition,
} from '../physics/ephemeris';
import { sampleAt } from '../physics/predict';
import { MapPlanner, PlannerCtx } from './planner';
import { MapView } from './mapview';
import { BeltPhysics } from './belt';
import { CombatCtx, CombatSystem } from './combat';
import { StageCtx, StageDirector } from './stages';
import { EnvironmentSystem } from './environment';
import { MarkersCtx, MarkersSystem } from './markers';
import {
  Attitude,
  qRotate,
  randomQuat,
  stepAttitude,
} from '../physics/attitude';
import {
  Vec3,
  add,
  addScaled,
  clone,
  cross,
  dot,
  len,
  lenSq,
  norm,
  rotateAxis,
  scale,
  sub,
  v3,
} from '../physics/vec3';
import * as C from './const';
import { Bullet, Casing, DebrisPiece, FlashEffect, MagPickup, Ship, PlasmaBullet } from './entities';

import { Input } from './input';
import { TouchControls } from './touch';
import { ChaseCamera } from './camera';
import { Hud } from './hud';
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
  RCS_BLOCK_OFFSETS,
  buildEnemyShip,
  buildFlashMesh,
  buildMagazineMesh,
  buildMagPickup,
  buildPlayerShip,
} from '../render/ships';
import { OrbitLine } from '../render/orbitline';
import { TrajLine } from '../render/trajline';

type GamePhase = 'playing' | 'won' | 'lost' | 'timeup';

const tmpV = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const Z_AXIS = new THREE.Vector3(0, 0, 1);

function randSym(amp: number): number {
  return (Math.random() * 2 - 1) * amp;
}

function randVec(amp: number): Vec3 {
  return v3(randSym(amp), randSym(amp), randSym(amp));
}

export class Game {
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;

  private readonly input: Input;
  private touchControls: TouchControls | null = null;
  private readonly hud = new Hud();
  private readonly sfx = new Sfx();
  private readonly chase = new ChaseCamera();

  private readonly earth: Earth;
  private readonly sun: Sun;

  private readonly player: Ship;
  private readonly enemies: Ship[] = [];
  private bullets: Bullet[] = [];
  private plasmaBullets: PlasmaBullet[] = [];
  private casings: Casing[] = [];
  private debris: DebrisPiece[] = [];
  private effects: FlashEffect[] = [];


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
  private mapMode = false;
  private readonly starsMesh: THREE.Mesh;
  private readonly trajLine = new TrajLine();

  // マニューバ計画(ノード列)・予測軌道キャッシュ・ノード編集入力。詳細は planner.ts のコメント参照。
  private readonly planner = new MapPlanner(this.hud, this.sfx);
  // マップモードの視点・表示状態(マップカメラ・ラベル・フォーカス・太陽回転系・スライダー)。詳細は mapview.ts のコメント参照。
  private readonly mapView = new MapView(this.hud);
  // [N] または右クリックメニューの「この時刻まで自動ワープ」で設定する自動ワープの
  // 目標時刻(絶対 simTime)。null なら自動ワープ無効。任意のノード(2件目以降も可)や
  // 将来的には任意の時刻を対象にできるよう、真偽値ではなく時刻そのものを持つ。
  private autoWarpUntil: number | null = null;

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

  private rcsDamp = true;
  private target: Ship | null = null;
  private lockedTarget: Ship | null = null;
  private throttleIdx = C.THROTTLE_DEFAULT_IDX; // 並進出力の段(0:弱 1:中 2:強、全 6 方向で共通)
  private fineAttitude = false;
  private progradeHold = true; // [C] 機首をプログレードへ自動保持するオートパイロット
  // [G] 視点(チェイスカメラ)を自機の姿勢(RCS操作)に追従させるか。
  // デフォルト ON: 機首・機体の天頂面を基準に視点が回転し、姿勢操作と一体的に見える。
  // OFF にすると従来通り軌道基準(プログレード・動径outward)の独立した視点に戻る。
  private camFollowAttitude = true;
  private zoomActive = false;
  private wasFiring = false;
  // 前フレームの射撃状態(ズームウィンドウ/PIPの表示条件と同一)。立ち下がり検出用。
  private prevFiringForPip = false;

  // 環境モデル(大気抵抗+J2+第三体摂動)・自機の熱/動圧・高度警告・天体暦は
  // environment.ts の EnvironmentSystem に切り出し済み。
  private readonly environment = new EnvironmentSystem(this.hud, this.sfx);
  private lostReason = '大気圏に突入し機体を喪失した';


  private readonly plumeCore: THREE.Mesh;
  private readonly plumeOuter: THREE.Mesh;
  private thrustVizDir: Vec3 | null = null; // 現在の推力方向(ワールド、噴射エフェクト用)
  private thrustAccelVec: Vec3 = v3(); // 現在の推力加速度(ワールド、ベルト物理の慣性力用)
  private readonly rcsPuffs: THREE.Mesh[] = []; // RCS ブロック位置の噴射パフ(4基)
  private readonly sunLight: THREE.DirectionalLight;
  private readonly ambient: THREE.AmbientLight;
  private readonly moonMesh = createMoon();

  private fireCooldown = 0;
  private reloadTimer = 0;

  private rotationHoldTime = 0; // 手動回転の継続時間 [s]

  // --- 弾薬・マガジン ---
  private roundsInMag = C.MAG_ROUNDS; // 給弾中マガジンの残弾
  private magsLeft = C.INITIAL_MAGS - 1; // ベルトに連結された未使用マガジン数
  private magsConsumedSinceReload = 0; // 今回のバレルで消費したマガジン数
  private wasEmptyClick = false;
  private magPickups: MagPickup[] = [];
  private resupplyCheckAt = 0; // [sim s]
  private clankCd = 0; // 薬莢接触音のレート制限 [実 s]
  private beltFeed = 0; // 給弾の進み(0..1、表示用に平滑化)
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
  private readonly earthPhase0 = Math.random() * Math.PI * 2;

  constructor(gs: GameScene, stage = 1) {
    this.scene = gs.scene;
    this.camera = gs.camera;
    this.stage = stage;
    this.input = new Input(gs.renderer.domElement);
    this.input.onFirstGesture = () => this.sfx.unlock();
    if (TouchControls.isTouchDevice()) this.touchControls = new TouchControls(this.input);
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

    // --- 環境 ---
    this.ambient = new THREE.AmbientLight(0x8899bb, 0.25);
    this.scene.add(this.ambient);
    this.glowTex = makeGlowTexture();
    this.sun = createSun(this.glowTex);
    this.scene.add(this.sun.mesh);
    this.environment.updateEphemeris(this.simTime);
    this.sunLight = new THREE.DirectionalLight(0xfff4e0, C.SUN_INTENSITY);
    const sunDir0 = this.environment.sunDir;
    this.sunLight.position.set(sunDir0.x * 1e5, sunDir0.y * 1e5, sunDir0.z * 1e5);
    this.scene.add(this.sunLight);
    this.scene.add(this.moonMesh);
    this.starsMesh = createStars();
    this.scene.add(this.starsMesh);
    this.earth = createEarth();
    this.scene.add(this.earth.group);
    this.scene.add(this.playerOrbitLine.line);
    this.targetOrbitLine.line.renderOrder = 2;
    this.scene.add(this.targetOrbitLine.line);
    this.plannedOrbitLine.line.renderOrder = 3;
    this.scene.add(this.plannedOrbitLine.line);
    this.geoOrbitLine.line.renderOrder = 0;
    this.scene.add(this.geoOrbitLine.line);
    this.moonOrbitLine.line.renderOrder = 0;
    this.scene.add(this.moonOrbitLine.line);
    this.scene.add(this.trajLine.group);

    // マップモードのツールバー(予測期間・スライダー・座標系トグル)
    this.hud.onDurationSelect = (key) => {
      if (key === 'orbit' || key === 'day' || key === 'week' || key === 'month') {
        this.planner.predictDurationKey = key;
        this.planner.trajDirty = true;
      }
    };
    this.hud.onFrameToggle = () => {
      this.mapView.frameRotating = !this.mapView.frameRotating;
      this.planner.trajDirty = true;
    };
    this.hud.onMapFocusSelect = (focus) => {
      this.mapView.focus = focus;
      this.mapView.pan.set(0, 0, 0);
    };
    this.hud.onMapViewReset = () => this.mapView.reset();
    this.hud.onSliderChange = (t) => {
      this.mapView.sliderT = t;
    };

    // マップモードの DOM ギズモ(ノードハンドル・Δv アーム・コンテキストメニュー)
    this.planner.mapGizmo.onNodeSelect = (idx) => {
      this.planner.selectedNodeIdx = idx;
      this.planner.mapGizmo.closeMenu();
      this.sfx.warp();
    };
    this.planner.mapGizmo.onNodeDragMove = (idx, clientX, clientY) => {
      this.planner.mapGizmo.closeMenu();
      this.planner.dragNodeToNearestSample(idx, clientX, clientY, this.plannerCtx(), (rel) => this.project(rel));
    };
    this.planner.mapGizmo.onNodeContextMenu = (clientX, clientY) => {
      this.planner.handleMapRightClick(clientX, clientY, this.plannerCtx(), (rel) => this.project(rel), this.mapView.labels);
    };
    this.planner.mapGizmo.onAxisDrag = (axis, sign, deltaPx) => {
      this.planner.applyAxisDrag(axis, sign, deltaPx, this.fineAttitude);
    };
    this.planner.mapGizmo.onMenuWarpTo = (idx) => {
      const n = this.planner.planNodes[idx];
      if (n) {
        this.autoWarpUntil = n.time;
        this.hud.hint('指定時刻まで自動ワープ開始');
      }
    };
    this.planner.mapGizmo.onMenuDelete = (idx) => {
      if (this.planner.planNodes[idx]) {
        this.planner.planNodes.splice(idx, 1);
        if (this.planner.selectedNodeIdx === idx) this.planner.selectedNodeIdx = null;
        else if (this.planner.selectedNodeIdx !== null && this.planner.selectedNodeIdx > idx) this.planner.selectedNodeIdx--;
        this.planner.clearActiveTarget();
        this.planner.trajDirty = true;
        this.hud.hint('ノードを削除');
      }
    };
    this.planner.mapGizmo.onMenuFocus = (targetKey) => {
      this.mapView.focus = targetKey;
      const lbl = this.mapView.labels.find(l => l.id === targetKey);
      if (lbl) {
        this.hud.hint(`${lbl.name} にフォーカス`);
      }
    };

    // マヌーバ噴射プルーム(推力方向の逆側に置く発光ビルボード 2 枚)
    this.plumeCore = buildFlashMesh(this.glowTex, 0xaee6ff);
    this.plumeOuter = buildFlashMesh(this.glowTex, 0x4f9fff);
    this.plumeCore.visible = false;
    this.plumeOuter.visible = false;
    this.scene.add(this.plumeCore);
    this.scene.add(this.plumeOuter);

    // RCS パフ(機首側の 4 基のスラスタブロックに対応、ships.ts の配置と一致)
    for (let i = 0; i < 4; i++) {
      const puff = buildFlashMesh(this.glowTex, 0xcfeaff);
      puff.visible = false;
      this.rcsPuffs.push(puff);
      this.scene.add(puff);
    }

    // --- 自機: 高度420km・傾斜51.6°の円軌道 ---
    const r0 = R_EARTH + C.INITIAL_ALT;
    const vCirc = Math.sqrt(MU_EARTH / r0);
    const inc = (C.INITIAL_INC_DEG * Math.PI) / 180;
    const playerState: OrbitState = {
      r: v3(r0, 0, 0),
      v: v3(0, vCirc * Math.sin(inc), -vCirc * Math.cos(inc)),
    };
    this.player = {
      name: 'PLAYER',
      state: playerState,
      prevR: clone(playerState.r),
      att: this.progradeAttitude(playerState),
      obj: buildPlayerShip(),
      radius: C.PLAYER_RADIUS,
      hp: C.PLAYER_MAX_HP,
      maxHp: C.PLAYER_MAX_HP,
      alive: true,
    };
    this.scene.add(this.player.obj);

    // マガジンベルト(未使用の実弾入りマガジン): 機体左面(+X)に垂直に連結する。
    // 先頭リンクは機体に半分取り込まれた位置に置く(給弾中もベルトごと
    // 取り込まれている見た目)。ゲーム開始時は空のマガジンは一切表示されず、
    // 弾を撃ち尽くすたびに機体反対側(-X)からフレームだけの空マガジンが
    // デブリとして放出される(spawnEjectedMagazineFrame 参照)。
    for (let i = 0; i < C.BELT_MAX_VISIBLE; i++) {
      const link = buildMagazineMesh();
      link.position.x = 0.9 + i * MAG_BELT_PITCH;
      this.beltGroup.add(link);
      this.beltLinks.push(link);
    }
    this.player.obj.add(this.beltGroup);

    // --- 敵機配置 ---
    for (const spec of this.stageDirector.makeEnemySpecs(playerState, stage)) {
      const ship: Ship = {
        name: spec.name,
        state: spec.state,
        prevR: clone(spec.state.r),
        att: {
          q: randomQuat(),
          w: v3(randSym(0.12), randSym(0.12), randSym(0.12)),
          inertia: v3(1, 1.1, 1.05),
        },
        obj: buildEnemyShip(spec.accent),
        radius: C.ENEMY_RADIUS,
        hp: spec.hp,
        maxHp: spec.hp,
        alive: true,
      };
      ship.obj.scale.setScalar(C.ENEMY_SCALE);
      this.enemies.push(ship);
      this.scene.add(ship.obj);
      const line = new OrbitLine(0x565b63, 0.35);
      this.enemyOrbitLines.push(line);
      this.scene.add(line.line);
    }


    if (stage === -1) {
      this.magsLeft = C.INITIAL_MAGS - 1;
      this.roundsInMag = C.MAG_ROUNDS;
      this.stageDirector.spawnStage00InitialAmmo(this.stageCtx());
      this.hud.toast(
        `<b>サバイバル任務: 弾薬を回収し、無限の敵から生き残れ！</b><br>` +
        '敵は次々と波状攻撃を仕掛けてくる。<br>' +
        '補給マガジンが近くに浮いている — 弾切れ時は回収せよ<br>' +
        '[H] キーで操作方法を表示',
        12000,
      );
    } else if (stage === 0) {
      this.magsLeft = 0;
      this.roundsInMag = 0;
      this.stageDirector.spawnStage0InitialAmmo();
      this.hud.toast(
        `<b>訓練ステージ: 制限時間 ${Math.floor(C.STAGE0_TIME_LIMIT / 60)}分で何機撃墜できるか</b><br>` +
        '周囲5km以内の色分けされた集団を撃墜せよ — RCS並進(WSADQE)と回転(IKJLUO)の練習に最適<br>' +
        '補給マガジンが近くに浮いている — 弾切れ時は回収せよ<br>' +
        '[H] キーで操作方法を表示',
        12000,
      );
    } else {
      this.hud.toast(
        `<b>作戦目標: 敵機 ${this.enemies.length} 機を全機撃破せよ</b><br>` +
        (stage === 2
          ? '敵の一部はモルニヤ級の高楕円軌道上にいる — [M] 軌道計画モードで遷移を計画せよ<br>'
          : '[Tab] ターゲット選択 → [F] ターゲット基準推進で接近 → [,/.] タイムワープで会合を短縮<br>') +
        '[H] キーで操作方法を表示',
        12000,
      );
    }
  }

  // 描画に使うカメラ(戦闘 / 軌道計画で切り替え)
  public get isMapMode(): boolean { return this.mapMode; }
  public get isFiring(): boolean { return this.wasFiring; }
  public get playerShipObj(): THREE.Object3D { return this.player.obj; }
  public get activeCamera(): THREE.PerspectiveCamera {
    return this.mapMode ? this.mapView.camera : this.camera;
  }

  // ズームウィンドウ(PIP)描画中、マズルフラッシュを非表示にする(main.ts の PIP パスから
  // playerShipObj.visible=false と同じタイミングで呼ばれる)。this.effects には被弾スパーク・
  // 撃破爆発のフラッシュも入っているため、muzzle フラグ付きのものだけを切り替える
  // (ズーム中でも敵側の命中・爆発の閃光は照準フィードバックとして見せたい)。
  public setFlashesVisible(v: boolean): void {
    for (const fx of this.effects) if (fx.muzzle) fx.mesh.visible = v;
  }

  // 機首をプログレード、背を天頂に向けた初期姿勢
  private progradeAttitude(s: OrbitState): Attitude {
    const zAxis = norm(s.v);
    const yAxis = norm(s.r); // 天頂を背にする(地球が下になる)
    const xAxis = cross(yAxis, zAxis);
    const m = new THREE.Matrix4().makeBasis(
      new THREE.Vector3(xAxis.x, xAxis.y, xAxis.z),
      new THREE.Vector3(yAxis.x, yAxis.y, yAxis.z),
      new THREE.Vector3(zAxis.x, zAxis.y, zAxis.z),
    );
    tmpQ.setFromRotationMatrix(m);
    return {
      q: { x: tmpQ.x, y: tmpQ.y, z: tmpQ.z, w: tmpQ.w },
      w: v3(),
      inertia: v3(1, 1, 1),
    };
  }

  // ---------------------------------------------------------------- update

  update(dtRaw: number): void {
    const dt = Math.min(dtRaw, 0.1);
    this.zoomActive = !this.mapMode && this.input.down('KeyZ');
    this.handleEdgeInput();

    // HP自動回復 (1秒間に1回復)。一時停止メニュー表示中は回復も止める。
    if (!this.paused && this.phase === 'playing' && this.player.alive && this.player.hp > 0 && this.player.hp < this.player.maxHp) {
      this.player.hp = Math.min(this.player.maxHp, this.player.hp + dt * C.HP_REGEN_RATE);
    }
    if (this.phase !== 'playing' && this.mapMode) {
      // ゲーム終了時はマップモードを強制解除する
      this.mapMode = false;
      this.hud.setPlanPanel(null);
      this.hud.setMapToolbarVisible(false);
      this.planner.closeMenu();
      this.touchControls?.setMapMode(false);
    }
    if (!this.paused && this.phase === 'playing') {
      // 軌道計画モード中も時間を進め、ワープできるようにする(手動推進・射撃のみ
      // simulate() 内部で無効化する)。ノード編集は同じフレームの現在軌道に対して行う。
      this.simulate(dt);
      if (this.mapMode) {
        this.planner.updateEditing(dt, this.plannerCtx(), this.input, (rel) => this.project(rel), {
          fineAttitude: this.fineAttitude,
          mapSliderT: this.mapView.sliderT,
          mapFocus: this.mapView.focus,
          labels: this.mapView.labels,
        });
      } else {
        // 戦闘中の左クリックは射撃・カメラ用として消費(キューは捨てる)
        this.input.takeClicks();

        // 右クリックによるターゲット固定・解除
        const rClicks = this.input.takeRightClicks();
        if (rClicks.length > 0 && this.player.alive) {
          const rc = rClicks[rClicks.length - 1]!;
          let hit: Ship | null = null;
          let minDistSq = C.TARGET_LOCK_PICK_PX_SQ;
          for (const e of this.enemies) {
            if (!e.alive) continue;
            const p = this.project(sub(e.state.r, this.player.state.r));
            if (p.front) {
              const dx = p.x - rc.x;
              const dy = p.y - rc.y;
              const distSq = dx * dx + dy * dy;
              if (distSq < minDistSq) {
                minDistSq = distSq;
                hit = e;
              }
            }
          }
          if (hit) {
            if (this.lockedTarget === hit) {
              this.lockedTarget = null; // Toggle off
              this.hud.hint(`ターゲット固定解除`);
            } else {
              this.lockedTarget = hit;
              this.hud.hint(`ターゲット固定: ${hit.name}`);
            }
          } else {
            if (this.lockedTarget !== null) {
              this.lockedTarget = null;
              this.hud.hint(`ターゲット固定解除`);
            }
          }
        }

        // 自動ターゲット更新 (ロックされていればそれ、そうでなければ画面中央に一番近い敵)
        if (this.lockedTarget && this.lockedTarget.alive) {
          this.target = this.lockedTarget;
        } else {
          this.lockedTarget = null;
          let bestTarget: Ship | null = null;
          let bestDot = -1;
          const camFwdW = new THREE.Vector3();
          this.activeCamera.getWorldDirection(camFwdW);
          const camFwdVec = v3(camFwdW.x, camFwdW.y, camFwdW.z);
          for (const e of this.enemies) {
            if (!e.alive) continue;
            const dir = norm(sub(e.state.r, this.player.state.r));
            const d = dot(camFwdVec, dir);
            if (d > bestDot) {
              bestDot = d;
              bestTarget = e;
            }
          }
          this.target = bestTarget;
        }
      }
      if (this.stage === -1) this.stageDirector.updateStage00(dt, this.stageCtx());
      if (this.stage === 0) this.stageDirector.updateStage0Timer(dt, this.stageCtx());
    } else {
      this.lastSimDt = 0;
      this.sfx.setThrust(false);
      this.thrustVizDir = null;
      this.thrustAccelVec = v3();
      this.input.takeClicks();
      this.input.takeRightClicks();
      // ポーズ中/非プレイ中はズームウィンドウ(PIP)を閉じ、連動する微動モードも解除する
      this.wasFiring = false;
    }
    if (this.phase !== 'playing') {
      // 撃破後もデブリ等は流し続ける(演出)
      this.coastWorld(dt);
    }
    // ズームウィンドウ(PIP)は isFiring(=wasFiring) の間だけ表示される。その立ち下がりで
    // 微動モードも自動解除する(射撃開始時の自動 fineAttitude=true と対になる挙動)。
    if (this.prevFiringForPip && !this.wasFiring) this.fineAttitude = false;
    this.prevFiringForPip = this.wasFiring;
    this.syncRender(dt);
  }

  private warp(): number {
    return C.WARP_LEVELS[this.warpIdx]!;
  }

  private handleEdgeInput(): void {
    for (const code of this.input.takePresses()) {
      switch (code) {
        case 'KeyT':
          this.rcsDamp = !this.rcsDamp;
          this.hud.hint(`RCS 回転制動: ${this.rcsDamp ? 'ON' : 'OFF'}`);
          break;
        case 'KeyF':
          this.progradeHold = true;
          this.hud.hint('プログレード姿勢リセット(機首を進行方向へ)');
          break;
        case 'KeyV':
          this.fineAttitude = !this.fineAttitude;
          this.hud.hint(`姿勢微調整モード: ${this.fineAttitude ? 'ON' : 'OFF'}`);
          break;
        case 'KeyC':
          this.progradeHold = !this.progradeHold;
          this.hud.hint(`進行方向ホールド: ${this.progradeHold ? 'ON (機首をプログレードへ保持)' : 'OFF'}`);
          break;
        case 'KeyG':
          this.camFollowAttitude = !this.camFollowAttitude;
          this.hud.hint(
            `視点のRCS追従: ${this.camFollowAttitude ? 'ON (視点が機体姿勢に追従)' : 'OFF (軌道基準の独立視点)'}`,
          );
          break;
        case 'Digit1':
          this.throttleIdx = 0;
          this.hud.hint(`並進出力: 弱 (${C.THROTTLE_LEVELS[0]!.toFixed(1)} m/s²)`);
          break;
        case 'Digit2':
          this.throttleIdx = 1;
          this.hud.hint(`並進出力: 中 (${C.THROTTLE_LEVELS[1]!.toFixed(1)} m/s²)`);
          break;
        case 'Digit3':
          this.throttleIdx = 2;
          this.hud.hint(`並進出力: 強 (${C.THROTTLE_LEVELS[2]!.toFixed(1)} m/s²)`);
          break;
        case 'Comma':
          this.autoWarpUntil = null;
          if (this.warpIdx > 0) {
            this.warpIdx--;
            this.sfx.warp();
            this.hud.hint(`TIME WARP ×${this.warp()}`);
          }
          break;
        case 'Period':
          this.autoWarpUntil = null;
          if (this.warpIdx < C.WARP_LEVELS.length - 1) {
            this.warpIdx++;
            this.sfx.warp();
            this.hud.hint(`TIME WARP ×${this.warp()}`);
          }
          break;
        case 'KeyM':
          this.toggleMap();
          break;
        case 'KeyN':
          if (this.mapMode) break;
          if (this.planner.planNodes.length > 0 && this.phase === 'playing') {
            this.autoWarpUntil = this.autoWarpUntil !== null ? null : this.planner.firstNode()!.time;
            this.hud.hint(this.autoWarpUntil !== null ? 'ノードへ自動ワープ開始' : '自動ワープ解除');
          } else {
            this.hud.hint('マニューバノードがありません ([M] で計画)');
          }
          break;
        case 'KeyX':
          // 右クリックはコンテキストメニュー(この時刻まで自動ワープ / ノードを削除)に
          // 置き換えたので、キーボード [X] は従来どおりのフォールバック操作として残す:
          // マップモード中は選択中ノードを削除、戦闘ビューでは計画全体を破棄する。
          if (this.mapMode) {
            if (this.planner.selectedNodeIdx !== null) {
              this.planner.planNodes.splice(this.planner.selectedNodeIdx, 1);
              this.planner.selectedNodeIdx = null;
              this.planner.clearActiveTarget();
              this.planner.trajDirty = true;
              this.hud.hint('ノードを削除');
            }
          } else if (this.planner.planNodes.length > 0) {
            this.planner.planNodes = [];
            this.planner.selectedNodeIdx = null;
            this.planner.clearActiveTarget();
            this.autoWarpUntil = null;
            this.planner.trajDirty = true;
            this.hud.hint('マニューバ計画を破棄');
          }
          break;
        case 'KeyH':
          this.hud.toggleHelp();
          break;
        case 'Escape':
          this.toggleEscMenu();
          break;
        case 'KeyR':
          if (this.phase !== 'playing') {
            location.reload();
          } else {
            // 手動リロード(残弾がある場合のみ)
            if (this.reloadTimer <= 0 && (this.roundsInMag < C.MAG_ROUNDS || this.magsConsumedSinceReload > 0) && this.magsLeft > 0) {
              this.magsLeft--; // 残弾ごと捨てる
              this.roundsInMag = C.MAG_ROUNDS;
              this.magsConsumedSinceReload = 0;
              this.reloadTimer = C.RELOAD_TIME;
              this.combat.dropBarrel(this.combatCtx());
              this.sfx.playReload();
            }
          }
          break;
      }
    }
  }

  // 一時停止メニュー(旧 [P] 一時停止と [Esc] 設定パネルを統合)。force を渡すと
  // その開閉状態に固定する(⚙ギアクリック等、hud 側の操作でも paused を同期させるため
  // onSettingsOpenChange 経由でも呼ばれる — 実際の開閉状態変更はそちらが担う)。
  private toggleEscMenu(force?: boolean): void {
    this.hud.toggleSettings(force);
  }

  // ------------------------------------------------------- maneuver planning

  private toggleMap(): void {
    if (this.phase !== 'playing') return;
    if (!this.mapMode) {
      this.mapMode = true;
      this.planner.selectedNodeIdx = null;
      this.planner.trajDirty = true;
      this.hud.setMapToolbarVisible(true);
      this.touchControls?.setMapMode(true);
      this.hud.hint(
        '軌道計画モード: 軌道をクリックしてノード配置 → ドラッグで移動・矢印ハンドルでΔv調整 → 右クリックでメニュー → [M] で確定',
        5000,
      );
    } else {
      this.mapMode = false;
      this.planner.onMapClosed();
      this.hud.setMapToolbarVisible(false);
      this.hud.setPlanPanel(null);
      this.planner.closeMenu();
      this.touchControls?.setMapMode(false);
      if (this.planner.planNodes.length > 0) {
        this.hud.hint(`マニューバ計画 ${this.planner.planNodes.length} 件確定 — [N] で直近ノードへ自動ワープ`, 4500);
      }
    }
  }

  // 選択中ノードの Δv アーム(mapgizmo.ts)ドラッグを Δv 成分の変更へ変換する。
  // axis: 0=プログレード(dv.x) 1=法線(dv.y) 2=動径(dv.z)。sign はハンドル自身の向き
  // (mapgizmo.ts の AxisHandleSpec 参照)。deltaPx はポインタ移動のハンドル方向への射影量。
  // MapPlanner の各メソッド呼び出しに渡す、現在状態のスナップショット。
  private plannerCtx(): PlannerCtx {
    return {
      simTime: this.simTime,
      playerR: this.player.state.r,
      playerV: this.player.state.v,
      sunPhase0: this.environment.sunPhase0,
      moonPhase0: this.environment.moonPhase0,
      mapMode: this.mapMode,
      mapFrameRotating: this.mapView.frameRotating,
    };
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
      magsLeft: this.magsLeft,
      roundsInMag: this.roundsInMag,
      setPhase: (p) => { this.phase = p; },
    };
  }

  // CombatSystem の各メソッド呼び出しに渡す、現在状態のスナップショット
  // (enemies / bullets / plasmaBullets / casings / debris / effects / boardMarks /
  // scene は参照渡しでミューテートされる)。roundsInMag 等の弾薬フィールドは
  // fireGun 内で書き換えられるため、呼び出し側で戻り値を自身のフィールドへ
  // 書き戻す(呼び出し箇所を参照)。
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
      roundsInMag: this.roundsInMag,
      magsLeft: this.magsLeft,
      magsConsumedSinceReload: this.magsConsumedSinceReload,
      reloadTimer: this.reloadTimer,
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
      magPickups: this.magPickups,
      mapLabelIds: this.mapView.labels.map((l) => l.id),
      activeCamera: this.activeCamera,
      touchControls: this.touchControls,
      simTime: this.simTime,
      solveLeadTime: (relP, relV, s) => this.combat.solveLeadTime(relP, relV, s),
      warp: this.warp(),
      paused: this.paused,
      rcsDamp: this.rcsDamp,
      throttleIdx: this.throttleIdx,
      fineAttitude: this.fineAttitude,
      progradeHold: this.progradeHold,
      camFollowAttitude: this.camFollowAttitude,
      roundsInMag: this.roundsInMag,
      magsLeft: this.magsLeft,
      reloadTimer: this.reloadTimer,
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

  // 数値予測(predict.ts)の再計算対象の期間 [s]。マップモードではツールバーで
  // 選んだ期間、戦闘ビューでは直近の未達成ノードをちょうど含む程度の短い期間だけ
  // 計算する(28日ぶんを毎回計算するのは無駄なコストになるため)。
  private predictDurationSec(): number {
    return this.planner.predictDurationSec(this.plannerCtx());
  }

  // dirty フラグが立っていれば ~5Hz、そうでなければ2秒ごとに予測を再計算する。
  // マップモードでもなくノードもなければ(表示・ガイドとも不要なので)何もしない。
  private updateTrajectoryRefresh(): void {
    this.planner.maybeRefresh(this.plannerCtx());
  }

  // ------------------------------------------------------------- simulate

  private simulate(dt: number): void {
    // 自動ワープ: 目標時刻(autoWarpUntil、[N] なら直近ノード・メニューなら任意のノード)に
    // 向けてワープ段数を自動調整する。目標はノードの存在に依存しない単なる絶対時刻なので、
    // 2件目以降のノードや(削除済みでも)残った時刻をそのまま目指せる。
    if (this.autoWarpUntil !== null) {
      const tRem = this.autoWarpUntil - this.simTime;
      if (tRem <= C.AUTOWARP_STOP) {
        this.warpIdx = 0;
        this.autoWarpUntil = null;
        this.hud.hint('マニューバ実行点に接近 — BURN ガイドの方向へ加速せよ', 5000);
      } else {
        let idx = 0;
        for (let i = 0; i < C.WARP_LEVELS.length; i++) {
          if (C.WARP_LEVELS[i]! <= tRem / C.AUTOWARP_MARGIN) idx = i;
        }
        this.warpIdx = idx;
      }
    }
    const warp = this.warp();
    const simDt = dt * warp;
    const canAct = warp <= C.MAX_PHYS_WARP && this.player.alive && !this.mapMode;

    // 射撃(実時間ベースの連射間隔)。撃ち始めはレールが動き出す起動遅延を挟む。
    // マップモード中は WASDQE がノード Δv 編集に使われるため、射撃・推進とも無効。
    const rawWantFire = !this.mapMode && (this.input.down('Space') || this.input.mouseFiring);
    if (rawWantFire && this.player.alive && warp > C.MAX_PHYS_WARP) {
      this.hud.hint(`射撃・推進はワープ ×${C.MAX_PHYS_WARP} 以下でのみ可能`);
    }
    // 弾切れチェック(空撃ちクリックは押し直しごとに 1 回)
    const hasAmmo = this.roundsInMag > 0 || this.magsLeft > 0;
    if (rawWantFire && !hasAmmo && this.player.alive && !this.wasEmptyClick) {
      this.sfx.emptyClick();
      this.hud.hint('弾薬切れ — 軌道上の補給マガジン ▣ を回収せよ', 3000);
    }
    this.wasEmptyClick = rawWantFire && !hasAmmo;
    
    // リロード中は射撃不可
    if (this.reloadTimer > 0) {
      this.reloadTimer -= dt;
      this.wasFiring = false;
    } else {
      const wantFire = rawWantFire && this.player.alive && warp <= C.MAX_PHYS_WARP && hasAmmo;
      if (wantFire && !this.wasFiring) {
        this.sfx.spinUp();
        this.fireCooldown = C.SPINUP_TIME;
        this.fineAttitude = true; // 連射時に自動的に微動モードに入る
      }
      this.wasFiring = wantFire;
      if (wantFire) {
        this.fireCooldown -= dt;
        if (this.fireCooldown <= 0) {
          const ctx = this.combatCtx();
          this.combat.fireGun(ctx);
          this.roundsInMag = ctx.roundsInMag;
          this.magsLeft = ctx.magsLeft;
          this.magsConsumedSinceReload = ctx.magsConsumedSinceReload;
          this.reloadTimer = ctx.reloadTimer;
          this.fireCooldown = C.FIRE_INTERVAL;
        }
      }
    }

    // 推進入力(並進出力の段数選択は handleEdgeInput のエッジ入力で行う)
    const thrustFn = canAct ? this.buildThrustAccel() : null;
    this.sfx.setThrust(thrustFn !== null);
    if (thrustFn) {
      this.thrustAccelVec = thrustFn(this.player.state.r, this.player.state.v);
      this.thrustVizDir = norm(this.thrustAccelVec);
    } else {
      this.thrustAccelVec = v3();
      this.thrustVizDir = null;
    }

    // 自機の追加加速度 = 推力 + 環境(大気抵抗 + J2 + 月・太陽摂動)
    const playerAccel: ExtraAccel = thrustFn
      ? (r, v) => add(thrustFn(r, v), this.environment.envShip(r, v))
      : this.environment.envShip;

    // 軌道積分(高ワープ時はサブステップ分割)
    const nSub = warp <= C.MAX_PHYS_WARP ? 1 : Math.min(64, Math.ceil(simDt / 20));
    const sub = simDt / nSub;
    for (let i = 0; i < nSub; i++) {
      this.environment.updateEphemeris(this.simTime); // 高ワープでも太陽・月の位置と摂動がサブステップ内で追従する
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
      for (const mp of this.magPickups) if (mp.alive) stepOrbitRK4(mp.state, sub, this.environment.envSmall);
      this.simTime += sub;
      this.combat.checkBulletHits(this.combatCtx());
      this.combat.checkBoardCrossings(this.combatCtx());
    }
    this.lastSimDt = simDt;
    const limit = this.environment.checkThermalLimits(this.player.alive);
    if (limit) {
      this.lostReason =
        limit === 'heat'
          ? '断熱圧縮による加熱で熱防御が飽和し、機体は焼失した'
          : '動圧が構造限界を超え、機体は空力的に分解した';
      this.combat.destroyShip(this.player, this.combatCtx());
    }
    this.environment.updateAltitudeAlarm(dt, this.player.alive, this.environment.altitudeOf(this.player.state.r));
    this.updateAmmoLogistics(dt);
    // 剛体衝突(薬莢・マガジンベルト等)はワープ ×4 以下(操縦可能な範囲)でのみ解決する。
    // 高ワープ中はサブステップが最大20秒に及び、反発処理も薬莢多数だと O(N²) で
    // 高コストになる上、物理的な意味も薄いため。実時間 dt で 1 回だけ呼ぶ
    // (ベルト自体が実時間で動いているため、サブステップごとに複数回呼ぶ必要もない)。
    if (warp <= C.MAX_PHYS_WARP) {
      this.resolvePhysicalCollisions(dt);
    }

    // 姿勢力学(高ワープ時は見かけ上スローになるが数値的に安定)
    const attDt = Math.min(simDt, 0.12);
    this.updatePlayerAttitude(attDt);
    for (const e of this.enemies) if (e.alive) stepAttitude(e.att, v3(), attDt);
    for (const cs of this.casings) stepAttitude(cs.att, v3(), attDt);
    for (const d of this.debris) stepAttitude(d.att, v3(), attDt);
    for (const mp of this.magPickups) if (mp.alive) stepAttitude(mp.att, v3(), attDt);

    this.cleanup();

    if (this.stage === -1 && this.phase === 'playing' && canAct) {
      this.combat.updateEnemyAI(dt, this.combatCtx());
    }
  }

  // 弾薬まわりの毎フレーム処理: 補給の取り込み・低残弾時の補給投入。
  // 薬莢の接触音は resolvePhysicalCollisions() の実衝突イベントから直接鳴らす
  // (このメソッドでは this.clankCd のレート制限だけを実時間 dt で減算する)。
  private updateAmmoLogistics(dt: number): void {
    this.clankCd -= dt;

    // 補給マガジンの取り込み(回収判定距離 = MAG_PICKUP_RADIUS。これは物理サイズではなく
    // ゲームプレイ上の吸収距離なので、物理衝突 resolvePhysicalCollisions とは別に判定する)
    if (this.player.alive) {
      for (const mp of this.magPickups) {
        if (!mp.alive) continue;
        if (lenSq(sub(mp.state.r, this.player.state.r)) < C.MAG_PICKUP_RADIUS * C.MAG_PICKUP_RADIUS) {
          mp.alive = false;
          this.scene.remove(mp.obj);
          this.magsLeft += C.MAG_PICKUP_MAGS;
          if (this.roundsInMag <= 0) {
            this.magsLeft--;
            this.roundsInMag = C.MAG_ROUNDS;
          }
          this.sfx.pickup();
          this.hud.hint(`補給マガジン取り込み — ベルト +${C.MAG_PICKUP_MAGS} 連`, 3000);
        }
      }
      this.magPickups = this.magPickups.filter((mp) => mp.alive);
    }

    // 残弾が少なくなってきたら付近の軌道に補給を投入する
    if (this.simTime >= this.resupplyCheckAt) {
      this.resupplyCheckAt = this.simTime + C.RESUPPLY_CHECK_INTERVAL;
      if (this.magsLeft < C.AMMO_LOW_MAGS && this.magPickups.length < C.MAX_MAG_PICKUPS) {
        this.spawnMagPickup();
      }
    }
  }

  // 自機軌道の少し先(同一軌道を位相シフト)に補給マガジンを投入する。
  // 既定は 1.25〜2.5km 先(通常ステージの残弾補給用、従来の半分の距離)。第零ステージの
  // 開始時配置ではより近い距離を明示的に渡す。
  private spawnMagPickup(minDist = C.AMMO_RESUPPLY_MIN_DIST, maxDist = C.AMMO_RESUPPLY_MAX_DIST): void {
    const r = this.player.state.r;
    const v = this.player.state.v;
    const hHat = norm(cross(r, v));
    const ang = (minDist + Math.random() * (maxDist - minDist)) / len(r);
    const mp: MagPickup = {
      state: {
        r: rotateAxis(r, hHat, ang),
        v: add(rotateAxis(v, hHat, ang), randVec(1.5)),
      },
      att: {
        q: randomQuat(),
        w: v3(randSym(0.15), randSym(0.15), randSym(0.15)),
        inertia: v3(1, 1.4, 1.2),
      },
      obj: buildMagPickup(),
      alive: true,
    };
    this.magPickups.push(mp);
    this.scene.add(mp.obj);
    this.sfx.warp();
    this.hud.hint('付近の軌道に補給マガジンが投入された — ▣ AMMO マーカーへ接近して回収', 5000);
  }

  // 勝敗確定後もデブリ・薬莢・弾を漂わせる
  private coastWorld(dt: number): void {
    const simDt = dt * Math.min(this.warp(), 4);
    this.environment.updateEphemeris(this.simTime);
    for (const b of this.bullets) if (b.alive) stepOrbitRK4(b.state, simDt, this.environment.envBullet);
    for (const cs of this.casings) stepOrbitRK4(cs.state, simDt, this.environment.envSmall);
    for (const d of this.debris) stepOrbitRK4(d.state, simDt, this.environment.envSmall);
    for (const e of this.enemies) if (e.alive) stepOrbitRK4(e.state, simDt, this.environment.envShip);
    for (const mp of this.magPickups) if (mp.alive) stepOrbitRK4(mp.state, simDt, this.environment.envSmall);
    const attDt = Math.min(simDt, 0.12);
    for (const cs of this.casings) stepAttitude(cs.att, v3(), attDt);
    for (const d of this.debris) stepAttitude(d.att, v3(), attDt);
    for (const mp of this.magPickups) if (mp.alive) stepAttitude(mp.att, v3(), attDt);
    this.simTime += simDt;
    this.lastSimDt = simDt;
  }

  // 押下キーから推力加速度関数を構築。機体座標系(+Z前, +X右, +Y上)を基準とする。
  // 並進(WSADQE の 6 方向)とエンジンは統合されており、前後・左右・上下いずれの
  // 方向も同じ [1]/[2]/[3] 出力段(弱/中/強)の加速度で駆動する。
  private buildThrustAccel(): ExtraAccel | null {
    const i = this.input;
    const manual = this.mapMode ? 0 : 1;
    const axX = ((i.down('KeyA') ? 1 : 0) + (i.down('KeyD') ? -1 : 0)) * manual; // 左(X)/右(-X) => A(1)/D(-1)
    const axY = ((i.down('KeyQ') ? 1 : 0) + (i.down('KeyE') ? -1 : 0)) * manual; // 上/下 (Q=上昇, E=下降)
    // 前後: W/S に加え、CTRL=前進・SHIFT=後退を同義語として受け付ける
    const axZ =
      ((i.down('KeyW') || i.down('ControlLeft') || i.down('ControlRight') ? 1 : 0) +
        (i.down('KeyS') || i.down('ShiftLeft') || i.down('ShiftRight') ? -1 : 0)) *
      manual; // 前/後 (W/CTRL=前進, S/SHIFT=後進)

    if (axX === 0 && axY === 0 && axZ === 0) return null;

    const thrustAccel = C.THROTTLE_LEVELS[this.throttleIdx]!;
    const q = this.player.att.q;

    return (): Vec3 => {
      const dir = norm(v3(axX, axY, axZ));
      return qRotate(q, scale(dir, thrustAccel));
    };
  }

  private updatePlayerAttitude(attDt: number): void {
    if (!this.player.alive) return;
    const i = this.input;
    const att = this.player.att;
    const I = att.inertia;
    // 機体軸: +X 右, +Y 上, +Z 前(機首)。マップモード中は手動回転操作を無効化する
    const manual = this.mapMode ? 0 : 1;
    // IKJLUO による回転操作
    const inX = ((i.down('KeyI') ? 1 : 0) + (i.down('KeyK') ? -1 : 0)) * manual; // ピッチ
    const inY = ((i.down('KeyL') ? 1 : 0) + (i.down('KeyJ') ? -1 : 0)) * manual; // ヨー (L=左, J=右)
    const inZ = ((i.down('KeyO') ? 1 : 0) + (i.down('KeyU') ? -1 : 0)) * manual; // ロール (O=右, U=左)

    const isRotating = inX !== 0 || inY !== 0 || inZ !== 0;
    if (isRotating) {
      this.rotationHoldTime += attDt;
    } else {
      this.rotationHoldTime = 0;
    }

    if (this.progradeHold && isRotating) {
      // 手動操作で自動保持を解除(SAS 的な挙動: 操作すると一旦解除される)
      this.progradeHold = false;
      this.hud.hint('進行方向ホールド解除(手動操作)');
    }

    // 機体回転のRCS出力: 初期は30%、長押し3秒目で最大130%まで段階的に増加
    const rcsOutputFactor = C.RCS_MANUAL_OUTPUT_MIN + C.RCS_MANUAL_OUTPUT_RAMP * (Math.min(C.RCS_MANUAL_RAMP_TIME, this.rotationHoldTime) / C.RCS_MANUAL_RAMP_TIME);

    // 微調整モード: 角加速度・角速度上限を絞り、小刻みな姿勢操作を可能にする
    const angScale = this.fineAttitude ? C.FINE_ATTITUDE_SCALE : 1;
    const maxAngAccel = C.MAX_ANG_ACCEL * angScale * rcsOutputFactor;
    const maxAngVel = C.MAX_ANG_VEL * angScale; // 最高速度は変えないか、連動させるか。要望は「出力」なので加速度のみ絞る

    const tq = v3(
      inX * maxAngAccel * I.x,
      inY * maxAngAccel * I.y,
      inZ * maxAngAccel * I.z,
    );
    if (this.progradeHold && inX === 0 && inY === 0 && inZ === 0) {
      // 機首(+Z)をプログレード方向へ向ける PD 制御。天頂方向を基準ロールに使い、
      // 姿勢が一意に定まるようにする(progradeAttitude と同じ基底の作り方)。
      const auto = this.autoAlignTorque(this.player.state.v, this.player.state.r, att, I);
      tq.x += auto.x;
      tq.y += auto.y;
      tq.z += auto.z;
    } else if (this.rcsDamp) {
      // 入力のない軸のみ制動(手動操作を妨げない)
      if (inX === 0) tq.x -= C.RCS_DAMP_RATE * I.x * att.w.x;
      if (inY === 0) tq.y -= C.RCS_DAMP_RATE * I.y * att.w.y;
      if (inZ === 0) tq.z -= C.RCS_DAMP_RATE * I.z * att.w.z;
    }
    stepAttitude(att, tq, attDt);

    const wMag = len(att.w);
    if (wMag > maxAngVel) {
      att.w = scale(att.w, maxAngVel / wMag);
    }
  }

  // 機首(+Z)を desiredFwd へ、天頂基準(desiredUp)でロールも安定させる姿勢へ
  // 収束させる PD トルク(機体座標系)。progradeAttitude と同じ基底の作り方で
  // 目標姿勢を作り、クォータニオン誤差を軸角度に変換して比例減衰制御する。
  private autoAlignTorque(desiredFwd: Vec3, desiredUp: Vec3, att: Attitude, I: Vec3): Vec3 {
    const zAxis = norm(desiredFwd);
    const yAxisRaw = norm(desiredUp); // 180度裏返しを解除
    const xAxis = cross(yAxisRaw, zAxis);
    if (lenSq(xAxis) < 1e-9) return v3(); // 進行方向と天頂がほぼ平行(特異点)なら制御しない
    const yAxis = cross(zAxis, norm(xAxis));
    const m = new THREE.Matrix4().makeBasis(
      new THREE.Vector3(xAxis.x, xAxis.y, xAxis.z).normalize(),
      new THREE.Vector3(yAxis.x, yAxis.y, yAxis.z),
      new THREE.Vector3(zAxis.x, zAxis.y, zAxis.z),
    );
    const qDesired = new THREE.Quaternion().setFromRotationMatrix(m);
    const qCurrent = new THREE.Quaternion(att.q.x, att.q.y, att.q.z, att.q.w);
    const qCurInv = qCurrent.clone().invert();
    const qErr = qDesired.multiply(qCurInv); // ワールド系での誤差回転

    let w = Math.max(-1, Math.min(1, qErr.w));
    let angle = 2 * Math.acos(w);
    if (angle > Math.PI) angle -= 2 * Math.PI; // 最短経路
    const s = Math.sqrt(Math.max(0, 1 - w * w));
    const axisWorld =
      s > 1e-6 ? new THREE.Vector3(qErr.x / s, qErr.y / s, qErr.z / s) : new THREE.Vector3(1, 0, 0);
    // 回転軸をワールド系から機体座標系へ変換(トルクは機体座標系で表現するため)
    const axisBody = axisWorld.applyQuaternion(qCurInv);

    return v3(
      (C.PROGRADE_HOLD_KP * angle * axisBody.x - C.PROGRADE_HOLD_KD * att.w.x) * I.x,
      (C.PROGRADE_HOLD_KP * angle * axisBody.y - C.PROGRADE_HOLD_KD * att.w.y) * I.y,
      (C.PROGRADE_HOLD_KP * angle * axisBody.z - C.PROGRADE_HOLD_KD * att.w.z) * I.z,
    );
  }

  // ------------------------------------------------------------- cleanup

  private altitudeOf(r: Vec3): number {
    return this.environment.altitudeOf(r);
  }

  private cleanup(): void {
    // 自機の構造限界高度(通常は加熱・動圧で先に喪失する)
    if (this.player.alive && this.altitudeOf(this.player.state.r) < C.PLAYER_MIN_ALT) {
      this.lostReason = '濃密な大気に突入し機体は分解した';
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

    let ammoToRespawn = 0;
    this.magPickups = this.magPickups.filter((mp) => {
      const dist = len(sub(mp.state.r, this.player.state.r));
      const tooFar = dist > C.AMMO_DESPAWN_DIST;
      const expired = !mp.alive || this.altitudeOf(mp.state.r) < C.DEBRIS_REENTRY_ALT || tooFar;
      if (expired) {
        this.scene.remove(mp.obj);
        // Stage 00の場合、遠すぎてデスポーンした弾薬は別の場所へ再配置する
        if (this.stage === -1 && tooFar) {
          ammoToRespawn++;
        }
      }
      return !expired;
    });
    for (let i = 0; i < ammoToRespawn; i++) {
      this.spawnMagPickup(C.STAGE00_AMMO_MIN_DIST, C.STAGE00_AMMO_MAX_DIST);
    }
  }

  // --------------------------------------------------------- render sync

  private syncRender(dt: number): void {
    const o = this.player.state.r; // フローティングオリジン
    const pv = this.player.state.v;

    const duration = this.predictDurationSec();
    const displayTime = (this.mapMode && this.mapView.sliderT > 0)
      ? this.mapView.displayTime(this.simTime, duration)
      : this.simTime;

    // 地球・恒星・太陽(実寸で描画。フローティングオリジン設計により
    // カメラは常にワールド原点にあるため、地球側の平行移動量(|o| 〜 R_EARTH+高度)
    // は近地点侵入時でも 1e7 未満で、near=2m の深度バッファでも十分な精度が出る
    // (詳細は CLAUDE.md「フローティングオリジンの精度設計」参照)。
    this.earth.group.position.set(-o.x, -o.y, -o.z);
    this.earth.setRotation(this.earthPhase0 + (2 * Math.PI * displayTime) / SIDEREAL_DAY);
    this.earth.tick(dt);

    // カメラ: 戦闘 = 自機中心チェイス / 計画 = 地球中心軌道ビュー
    const mouse = this.input.consumeMouse();
    // 矢印キーでも視点回転できるようにする(マウスドラッグと同じ換算式に合わせる)
    const keyYaw = (this.input.down('ArrowLeft') ? 1 : 0) + (this.input.down('ArrowRight') ? -1 : 0);
    const keyPitch = (this.input.down('ArrowDown') ? 1 : 0) + (this.input.down('ArrowUp') ? -1 : 0);
    if (this.mapMode) {
      this.syncRenderMapCamera(mouse, keyYaw, keyPitch, dt, o);
    } else {
      this.syncRenderCombatCamera(mouse, keyYaw, keyPitch, dt, o, pv);
    }
    const cam = this.activeCamera;

    // 太陽・月・星: カメラ位置基準で天体暦の方向に表示(マップの遠距離ズームでも
    // 背景として振る舞う。距離は視距離に圧縮、月の角直径は実距離から換算)
    const visSunPos = sunPosition(displayTime, this.environment.sunPhase0);
    const sd = norm(visSunPos);
    this.earth.setSunDir(sd.x, sd.y, sd.z);
    this.starsMesh.position.copy(cam.position);
    if (this.mapMode) {
      // マップモードではカメラが遠く引かれるため、星が地球の手前にならないようにカメラの far の内側に押し込む
      this.starsMesh.scale.setScalar((this.mapView.camera.far * 0.9) / 3.5e7);
    } else {
      this.starsMesh.scale.setScalar(1.0);
    }
    this.sun.mesh.position.set(
      cam.position.x + sd.x * SUN_DISTANCE,
      cam.position.y + sd.y * SUN_DISTANCE,
      cam.position.z + sd.z * SUN_DISTANCE,
    );
    this.sun.mesh.quaternion.copy(cam.quaternion);
    this.sunLight.position.set(sd.x * 1e5, sd.y * 1e5, sd.z * 1e5);
    const visMoonPos = moonPosition(displayTime, this.environment.moonPhase0);
    const moonRel = sub(visMoonPos, o); // フローティングオリジン座標(= true ECI - o)
    if (this.mapMode) {
      // マップモードは地球中心を実寸スケールで俯瞰するビューなので、月も
      // 圧縮せず実際の位置・実寸(R_MOON)で描く(シスルナ軌道の計画に、
      // 月との実際の位置関係が分かる必要があるため)。
      this.moonMesh.position.set(moonRel.x, moonRel.y, moonRel.z);
      this.moonMesh.scale.setScalar(R_MOON);
    } else {
      this.syncRenderCombatMoon(cam, moonRel);
    }

    // 月は常に地球(真のECI座標の原点)へ+Z方向を向ける(潮汐ロック)
    this.moonMesh.lookAt(
      this.moonMesh.position.x - visMoonPos.x,
      this.moonMesh.position.y - visMoonPos.y,
      this.moonMesh.position.z - visMoonPos.z
    );

    // 地球の影: 戦闘ビューでは自機周辺が影円柱内にあれば太陽光・環境光を減光する
    // マップモードでは全体像を見るため地球の昼側が常に明るくなるよう減光しない
    const lit = this.mapMode ? 1.0 : this.environment.shadowLitFactor(o);
    this.sunLight.intensity = C.SUN_INTENSITY * (C.SHADOW_MIN_SUN + (1 - C.SHADOW_MIN_SUN) * lit);
    this.ambient.intensity =
      C.AMBIENT_INTENSITY * (C.SHADOW_MIN_AMBIENT + (1 - C.SHADOW_MIN_AMBIENT) * lit);

    // マヌーバ噴射プルーム: 推力方向の逆側に、明るい芯 + 淡い外殻の 2 枚を置く
    const showPlume = this.thrustVizDir !== null && this.player.alive && !this.zoomActive;
    this.plumeCore.visible = showPlume;
    this.plumeOuter.visible = showPlume;
    if (showPlume) {
      const d = this.thrustVizDir!;
      const flick = 0.8 + 0.2 * Math.random();
      const sc = (1.5 + 2.5 * (this.throttleIdx / 3.0)) * flick; // 出力に応じたサイズ
      this.plumeCore.position.set(-d.x * 3.4, -d.y * 3.4, -d.z * 3.4);
      this.plumeCore.scale.setScalar(sc * 1.6);
      this.plumeCore.quaternion.copy(this.camera.quaternion);
      (this.plumeCore.material as THREE.MeshBasicMaterial).opacity = 0.85 * flick;
      this.plumeOuter.position.set(-d.x * 5.6, -d.y * 5.6, -d.z * 5.6);
      this.plumeOuter.scale.setScalar(sc * 3.6);
      this.plumeOuter.quaternion.copy(this.camera.quaternion);
      (this.plumeOuter.material as THREE.MeshBasicMaterial).opacity = 0.32 * flick;
    }

    this.updateRcsEffects();

    // 機体(ズーム中は視界を妨げないよう自機を非表示にする)
    this.player.obj.position.set(0, 0, 0);
    this.setObjAttitude(this.player);
    this.player.obj.visible = this.player.alive && !this.zoomActive;
    for (const e of this.enemies) {
      if (!e.alive) continue;
      e.obj.position.set(e.state.r.x - o.x, e.state.r.y - o.y, e.state.r.z - o.z);
      this.setObjAttitude(e);
    }

    // 弾(自機から見た相対速度方向へ伸ばす)
    for (const b of this.bullets) {
      b.obj.position.set(b.state.r.x - o.x, b.state.r.y - o.y, b.state.r.z - o.z);
      tmpV.set(b.state.v.x - pv.x, b.state.v.y - pv.y, b.state.v.z - pv.z);
      if (tmpV.lengthSq() > 1e-6) {
        tmpQ.setFromUnitVectors(Z_AXIS, tmpV.normalize());
        b.obj.quaternion.copy(tmpQ);
      }
    }

    for (const pb of this.plasmaBullets) {
      pb.obj.position.set(pb.state.r.x - o.x, pb.state.r.y - o.y, pb.state.r.z - o.z);
      tmpV.set(pb.state.v.x - pv.x, pb.state.v.y - pv.y, pb.state.v.z - pv.z);
      if (tmpV.lengthSq() > 1e-6) {
        tmpQ.setFromUnitVectors(Z_AXIS, tmpV.normalize());
        pb.obj.quaternion.copy(tmpQ);
      }
    }

    for (const cs of this.casings) {
      cs.obj.position.set(cs.state.r.x - o.x, cs.state.r.y - o.y, cs.state.r.z - o.z);
      cs.obj.quaternion.set(cs.att.q.x, cs.att.q.y, cs.att.q.z, cs.att.q.w);
    }
    for (const mp of this.magPickups) {
      mp.obj.position.set(mp.state.r.x - o.x, mp.state.r.y - o.y, mp.state.r.z - o.z);
      mp.obj.quaternion.set(mp.att.q.x, mp.att.q.y, mp.att.q.z, mp.att.q.w);
    }

    // マガジンベルト: 残数ぶんだけ表示。給弾の進みに応じてベルト全体が
    // 連続的に機体側へスライドし(撃つたび 1/16 リンクずつ)、マガジンを
    // 消費し切ると feed が 1→0 に巻き戻ると同時にリンクが 1 つ減るので、
    // 見た目には途切れなくベルトが取り込まれ続ける。
    const beltCount = Math.min(this.magsLeft, C.BELT_MAX_VISIBLE);
    const targetFeed = 1 - this.roundsInMag / C.MAG_ROUNDS;
    if (targetFeed < this.beltFeed - 0.5) {
      this.belt.shiftBeltNodes();
      this.beltFeed = targetFeed; // マガジン消費で巻き戻り(リンク減と同時なので連続)
    } else {
      this.beltFeed += (targetFeed - this.beltFeed) * Math.min(1, dt * 12);
    }
    this.belt.updateBeltPhysics(dt, beltCount, this.player.att, this.thrustAccelVec, this.beltFeed, this.player.alive);
    for (const d of this.debris) {
      d.obj.position.set(d.state.r.x - o.x, d.state.r.y - o.y, d.state.r.z - o.z);
      d.obj.quaternion.set(d.att.q.x, d.att.q.y, d.att.q.z, d.att.q.w);
    }

    // エフェクト
    this.effects = this.effects.filter((fx) => {
      fx.age += dt;
      if (fx.age >= fx.duration) {
        this.scene.remove(fx.mesh);
        (fx.mesh.material as THREE.Material).dispose();
        fx.mesh.geometry.dispose();
        return false;
      }
      fx.pos = addScaled(fx.pos, fx.vel, this.lastSimDt);
      const t = fx.age / fx.duration;
      const size = fx.size0 + (fx.size1 - fx.size0) * Math.sqrt(t);
      fx.mesh.position.set(fx.pos.x - o.x, fx.pos.y - o.y, fx.pos.z - o.z);
      fx.mesh.scale.setScalar(size);
      fx.mesh.quaternion.copy(this.activeCamera.quaternion);
      (fx.mesh.material as THREE.MeshBasicMaterial).opacity = fx.peakOpacity * (1 - t);
      return true;
    });

    // 軌道線(推力中は要素が能動的に変化するので毎フレーム再生成させる)
    const playerEl = elementsFromState(o, pv);
    this.playerOrbitLine.update(this.player.alive ? playerEl : null, o, this.thrustVizDir !== null, true);
    const tgt = this.target && this.target.alive ? this.target : null;
    // ターゲットの軌道要素は1フレームに複数箇所で使うので一度だけ計算して使い回す
    const tgtEl = tgt ? elementsFromState(tgt.state.r, tgt.state.v) : null;
    this.targetOrbitLine.update(tgtEl, o);

    // マップモード: 全敵の軌道を表示して比較できるようにする
    for (let i = 0; i < this.enemies.length; i++) {
      const e = this.enemies[i]!;
      const line = this.enemyOrbitLines[i]!;
      if (this.mapMode && e.alive && e !== tgt) {
        line.update(elementsFromState(e.state.r, e.state.v), o);
      } else {
        line.update(null, o);
      }
    }

    // 数値予測(predict.ts)の再計算とポリライン描画・ノードマーカー
    this.updateTrajectoryRefresh();
    this.updateTrajLineAndMarkers(o);
    this.planner.updateMapGizmo(o, this.plannerCtx(), (rel) => this.project(rel), this.mapMode, this.mapView.dist);

    if (this.mapMode) {
      this.mapView.drawLabels(o, { simTime: this.simTime, sunPhase0: this.environment.sunPhase0, moonPhase0: this.environment.moonPhase0, duration: this.predictDurationSec() }, (rel) => this.project(rel));
    }

    // 計画軌道(白、解析的な楕円): マップモード中は数値予測のポリライン(trajLine)が
    // 代わりを務めるので非表示にし、戦闘ビューでは直近ノードの噴射後サンプルから
    // 求めた軌道要素を表示する。
    let plannedEl: Elements | null = null;
    if (!this.mapMode && this.planner.planNodes.length > 0) {
      const s = sampleAt(this.planner.trajSamples, this.planner.planNodes[0]!.time);
      if (s) plannedEl = elementsFromState(s.r, s.v);
    }
    this.plannedOrbitLine.update(this.mapMode ? null : plannedEl, o);

    if (this.mapMode) {
      this.syncRenderMapOrbitReferences(o);
    } else {
      this.geoOrbitLine.update(null, o);
      this.moonOrbitLine.update(null, o);
    }

    const mctx = this.markersCtx();
    this.markers.updateMarkers(mctx, pv, (rel) => this.project(rel));
    this.markers.updateNodeMarkers(mctx, playerEl, tgtEl, (rel) => this.project(rel));
    this.markers.updateBoardMarkers(mctx, dt, (rel) => this.project(rel));
    if (!this.mapMode) {
      const { achieved } = this.planner.updateGuide(this.plannerCtx(), o, pv, playerEl, this.player.alive, (rel) =>
        this.project(rel),
      );
      if (achieved) this.autoWarpUntil = null;
    } else this.hud.hideMarker('burn');

    this.markers.updateHudPanels(mctx, dt, playerEl, tgtEl);
    this.hud.tick();
  }

  // syncRender: マップモードのカメラ更新(太陽回転系の方位追従を含む)
  private syncRenderMapCamera(mouse: ReturnType<Input['consumeMouse']>, keyYaw: number, keyPitch: number, dt: number, o: Vec3): void {
    // 太陽回転系表示: 太陽の実際の方位ドリフトぶんカメラ方位を追従させ、
    // 画面上で太陽方向がほぼ固定されて見えるようにする(予測サンプルの回転補正と
    // 組み合わせて、t=simTime では回転量ゼロで整合する)。frameRotating が OFF なら
    // MapView 側で無視される。
    const sunAz = sunAzimuth(this.simTime, this.environment.sunPhase0);
    this.mapView.updateCamera(mouse, keyYaw, keyPitch, dt, o, sunAz);
  }

  // syncRender: 戦闘ビューのチェイスカメラ更新(矢印キー視点回転 + 姿勢/軌道基準フレーム選択)
  private syncRenderCombatCamera(mouse: ReturnType<Input['consumeMouse']>, keyYaw: number, keyPitch: number, dt: number, o: Vec3, pv: Vec3): void {
    // 矢印キーによる視点回転をマウスドラッグと同じ yaw -= dx*0.005 の換算式に合わせて加算
    if (!this.zoomActive) {
      this.chase.yaw -= keyYaw * C.CAM_KEY_YAW_RATE * dt;
      this.chase.pitch = Math.max(
        -1.35,
        Math.min(1.35, this.chase.pitch + keyPitch * C.CAM_KEY_PITCH_RATE * dt),
      );
    }
    const boreFwd = this.player.alive ? qRotate(this.player.att.q, v3(0, 0, 1)) : null;
    const boreUp = this.player.alive ? qRotate(this.player.att.q, v3(0, 1, 0)) : null;
    // [G] 視点のRCS追従が ON かつ自機が健在なら、軌道基準(プログレード/動径)ではなく
    // 機体姿勢(機首/天頂面)を基準フレームにして、RCS操作と視点回転が一体的に動くようにする。
    const useAttitudeFrame = this.camFollowAttitude && this.player.alive && boreFwd && boreUp;
    const camFwd = useAttitudeFrame ? boreFwd! : norm(pv);
    const camUp = useAttitudeFrame ? boreUp! : norm(o);
    this.chase.update(this.camera, mouse, camUp, camFwd, this.zoomActive, dt, boreFwd, boreUp);
    this.camera.updateMatrixWorld();
  }

  // syncRender: 戦闘ビューでの月描画(カメラ基準の一定視距離 MOON_VIS_DIST へ圧縮して表示)
  private syncRenderCombatMoon(cam: THREE.PerspectiveCamera, moonRel: Vec3): void {
    // 戦闘ビューは近距離の背景として、カメラ基準の一定視距離(MOON_VIS_DIST)へ
    // 圧縮して表示する(実距離のままだと far クリップや精度の問題が出るため)。
    const moonDist = len(moonRel);
    const md = scale(moonRel, 1 / moonDist);
    this.moonMesh.position.set(
      cam.position.x + md.x * MOON_VIS_DIST,
      cam.position.y + md.y * MOON_VIS_DIST,
      cam.position.z + md.z * MOON_VIS_DIST,
    );
    this.moonMesh.scale.setScalar(MOON_VIS_DIST * (R_MOON / moonDist));
  }

  // syncRender: マップモードの参照軌道線(静止軌道 + 月軌道)を表示する
  private syncRenderMapOrbitReferences(o: Vec3): void {
    const geoEl: Elements = {
      a: R_EARTH + 35786e3, e: 1e-6, p: R_EARTH + 35786e3, incDeg: 0, apAlt: 35786e3, peAlt: 35786e3, period: 86164,
      hHat: v3(0, 1, 0), pHat: v3(1, 0, 0), qHat: v3(0, 0, -1)
    };
    this.geoOrbitLine.update(geoEl, o, false, false);

    const dtMoon = 10;
    const mR1 = moonPosition(this.simTime, 0);
    const mR2 = moonPosition(this.simTime + dtMoon, 0);
    const mV = scale(sub(mR2, mR1), 1 / dtMoon);
    const moonEl = elementsFromState(mR1, mV);
    this.moonOrbitLine.update(moonEl, o, false, false);
  }



  // RCS 姿勢制御の噴射パフと音。4 基のスラスタブロック(配置は ships.ts の
  // RCS_BLOCK_OFFSETS と一致させる)
  // それぞれについて、要求トルク τ に寄与する接線力 F = τ × r を求め、
  // その反対方向(排気側)に小さな発光パフを出す。
  private updateRcsEffects(): void {
    const i = this.input;
    let tauX = (i.down('KeyI') ? 1 : 0) + (i.down('KeyK') ? -1 : 0);
    let tauY = (i.down('KeyL') ? 1 : 0) + (i.down('KeyJ') ? -1 : 0);
    let tauZ = (i.down('KeyO') ? 1 : 0) + (i.down('KeyU') ? -1 : 0);

    if (this.rcsDamp && this.player.alive && this.phase === 'playing' && !this.mapMode) {
      const w = this.player.att.w;
      const EPS = C.RCS_DAMP_PUFF_EPS; // 閾値を上げて、視覚/音響的な持続時間を短くする
      if (tauX === 0 && Math.abs(w.x) > EPS) tauX = -Math.sign(w.x);
      if (tauY === 0 && Math.abs(w.y) > EPS) tauY = -Math.sign(w.y);
      if (tauZ === 0 && Math.abs(w.z) > EPS) tauZ = -Math.sign(w.z);
    }

    const tau = v3(tauX, tauY, tauZ);
    const rotating =
      this.player.alive &&
      this.phase === 'playing' &&
      !this.paused &&
      !this.mapMode &&
      lenSq(tau) > 0.01;
    this.sfx.setRcs(rotating);
    if (!rotating || this.zoomActive) {
      for (const p of this.rcsPuffs) p.visible = false;
      return;
    }

    const q = this.player.att.q;
    const cam = this.activeCamera;
    for (let k = 0; k < 4; k++) {
      const puff = this.rcsPuffs[k]!;
      const ro = RCS_BLOCK_OFFSETS[k]!;
      const rb = v3(ro.x, ro.y, ro.z);
      const f = cross(tau, rb); // このブロックがトルクに寄与する力の方向
      if (lenSq(f) < 0.2) {
        puff.visible = false;
        continue;
      }
      const exhaust = scale(norm(f), -1); // 排気は力と逆向き
      const flick = 0.6 + Math.random() * 0.4;
      const pos = qRotate(q, addScaled(rb, exhaust, 0.55));
      puff.position.set(pos.x, pos.y, pos.z);
      puff.scale.setScalar(0.55 * flick);
      puff.quaternion.copy(cam.quaternion);
      (puff.material as THREE.MeshBasicMaterial).opacity = 0.75 * flick;
      puff.visible = true;
    }
  }

  private setObjAttitude(s: Ship): void {
    s.obj.quaternion.set(s.att.q.x, s.att.q.y, s.att.q.z, s.att.q.w);
  }

  // rel: 自機基準の相対位置 → スクリーン座標(アクティブカメラで投影)
  private project(rel: Vec3): { x: number; y: number; front: boolean } {
    const cam = this.activeCamera;
    tmpV2.set(rel.x, rel.y, rel.z).applyMatrix4(cam.matrixWorldInverse);
    const front = tmpV2.z < 0;
    tmpV2.applyMatrix4(cam.projectionMatrix);
    return {
      x: (tmpV2.x * 0.5 + 0.5) * window.innerWidth,
      y: (-tmpV2.y * 0.5 + 0.5) * window.innerHeight,
      front,
    };
  }

  // マップモードの数値予測ポリライン(trajLine)を必要なときだけ再構築し、
  // 毎フレームはフローティングオリジン補正だけを行う。あわせてスライダーの
  // ゴーストマーカーを更新する(マップモードのみ表示)。ノード自体のマーカーは
  // mapgizmo.ts の DOM ハンドル(updateMapGizmo)が担う — 1ノードにつき描画は1つだけにする。
  private updateTrajLineAndMarkers(o: Vec3): void {
    if (!this.mapMode) {
      this.trajLine.setVisible(false);
      this.hud.hideMarker('ghost');
      return;
    }

    this.trajLine.setVisible(true);
    this.trajLine.setOrigin(o);
    if (this.planner.trajGeomDirty) {
      this.rebuildTrajLineGeom();
      this.planner.trajGeomDirty = false;
    }

    if (this.mapView.sliderT > 0 && this.planner.trajSamples.length > 0) {
      const duration = this.predictDurationSec();
      const t = this.mapView.displayTime(this.simTime, duration);
      const s = sampleAt(this.planner.trajSamples, t);
      if (s) {
        const p = this.project(sub(this.planner.toDisplayFrame(s.r, t, this.plannerCtx()), o));
        this.hud.marker('ghost', 'mk-ghost', '⬡', p.x, p.y, p.front, this.planner.ghostLabel(this.plannerCtx(), this.mapView.sliderT));
      } else {
        this.hud.hideMarker('ghost');
      }
    } else {
      this.hud.hideMarker('ghost');
    }
  }

  // trajSamples をノード時刻で区切り、太陽回転系表示なら座標変換した上で
  // trajLine のジオメトリを再構築する(refreshTrajectory 後、内容が変わったときだけ)。
  private rebuildTrajLineGeom(): void {
    const nodeTimes = this.planner.planNodes.map((n) => n.time);
    const segments: Vec3[][] = [];
    let seg: Vec3[] = [];
    let nodeIdx = 0;
    for (const s of this.planner.trajSamples) {
      seg.push(this.planner.toDisplayFrame(s.r, s.t, this.plannerCtx()));
      if (nodeIdx < nodeTimes.length && s.t >= nodeTimes[nodeIdx]! - 1e-6) {
        segments.push(seg);
        // 次のセグメントはこの区切り点(ノード位置)から続ける(線が途切れないように)
        seg = [seg[seg.length - 1]!];
        nodeIdx++;
      }
    }
    if (seg.length > 1) segments.push(seg);
    this.trajLine.refresh(segments);
  }

  // ズームウィンドウ(PIP)のオーバーレイ更新。main.ts から公開 API として呼ばれる
  // (実処理は markers.ts の MarkersSystem.updatePipOverlay に委譲)。
  public updatePipOverlay(rect: { x: number; y: number; w: number; h: number } | null): void {
    this.markers.updatePipOverlay(this.markersCtx(), rect);
  }

  // ------------------------------------------------------------- physical collisions
  // 剛体反発(球体)処理。実時間 dt(syncRender と同じ実 dt。ベルト物理と同じ
  // 実時間ベースで動かすことで、時間ワープ中でも整合させる)。
  // ワープ ×4 以下(操縦可能な範囲)でのみ呼ばれる。高ワープ中の O(N²) 判定は
  // サブステップが最大20秒に及び物理的に無意味な上、薬莢260個程度が漂う状態では
  // 毎フレーム数百万ペアに達し得るため、呼び出し側(simulate)でゲートしている。
  private resolvePhysicalCollisions(dt: number): void {
    // A-B の衝突を解決し、実際に貫入(かつ接近方向の速度成分あり)が起きたら true を返す
    const resolvePair = (
      rA: Vec3, vA: Vec3, massA: number, radA: number,
      rB: Vec3, vB: Vec3, massB: number, radB: number,
      restitution = 0.4
    ): boolean => {
      const dx = rB.x - rA.x, dy = rB.y - rA.y, dz = rB.z - rA.z;
      const distSq = dx * dx + dy * dy + dz * dz;
      const minD = radA + radB;
      if (distSq > 0 && distSq < minD * minD) {
        const dist = Math.sqrt(distSq);
        const nx = dx / dist, ny = dy / dist, nz = dz / dist;
        const pen = minD - dist;
        const invMa = 1 / massA, invMb = 1 / massB;
        const invM = invMa + invMb;
        const pCorr = (pen / invM) * 0.8;
        rA.x -= nx * pCorr * invMa; rA.y -= ny * pCorr * invMa; rA.z -= nz * pCorr * invMa;
        rB.x += nx * pCorr * invMb; rB.y += ny * pCorr * invMb; rB.z += nz * pCorr * invMb;

        const dvx = vB.x - vA.x, dvy = vB.y - vA.y, dvz = vB.z - vA.z;
        const vn = dvx * nx + dvy * ny + dvz * nz;
        if (vn < 0) {
          const j = -(1 + restitution) * vn / invM;
          vA.x -= nx * j * invMa; vA.y -= ny * j * invMa; vA.z -= nz * j * invMa;
          vB.x += nx * j * invMb; vB.y += ny * j * invMb; vB.z += nz * j * invMb;
          return true;
        }
      }
      return false;
    };

    // エンティティリスト(ベルトのワールド座標化含む)
    const ents: {
      r: Vec3; v: Vec3; m: number; rad: number;
      isBelt?: boolean; beltIdx?: number; isPlayer?: boolean; isCasing?: boolean;
    }[] = [];

    if (this.player.alive) {
      // 物理接触には被弾判定用の PLAYER_RADIUS(大きめ)ではなく、実寸に近い
      // PLAYER_HULL_RADIUS を使う。砲口(機体中心から距離約2.9m)で生まれた
      // 薬莢が生成直後に弾き飛ばされるのを防ぐ。
      ents.push({ r: this.player.state.r, v: this.player.state.v, m: 1000, rad: C.PLAYER_HULL_RADIUS, isPlayer: true });
    }
    for (const e of this.enemies) {
      if (e.alive) ents.push({ r: e.state.r, v: e.state.v, m: 10000, rad: e.radius });
    }
    for (const c of this.casings) ents.push({ r: c.state.r, v: c.state.v, m: 1, rad: 0.2, isCasing: true });
    for (const m of this.magPickups) {
      // MAG_PICKUP_RADIUS は回収判定距離(60m)であり物理サイズではないため、
      // 物理接触には見た目に近い専用の半径を使う。
      if (m.alive) ents.push({ r: m.state.r, v: m.state.v, m: 50, rad: C.MAG_PICKUP_PHYS_RADIUS });
    }
    // デブリのうち collideRadius を持つもの(排出された空マガジン)だけ当たり判定を持つ。
    // 爆発破片・被弾の欠片など既存のデブリは従来どおりすり抜ける。
    for (const d of this.debris) {
      if (d.collideRadius !== undefined) {
        ents.push({ r: d.state.r, v: d.state.v, m: C.EJECTED_MAG_MASS, rad: d.collideRadius });
      }
    }

    // マガジンベルト(Verlet積分の位置・疑似速度)。ベルト自体は実時間(dt)で
    // 動いているため、ワールド化・書き戻しとも同じ実時間刻みを使う。
    if (this.player.alive && dt > 1e-6) {
      const q = this.player.att.q;
      const baseR = this.player.state.r;
      const baseV = this.player.state.v;
      for (let i = 0; i < this.belt.beltPos.length; i++) {
        const bp = this.belt.beltPos[i]!;
        const bpPrev = this.belt.beltPrevPos[i]!;
        // clone してワールド座標化する
        const localBp = new THREE.Vector3().copy(bp);
        const localBpPrev = new THREE.Vector3().copy(bpPrev);
        const wr = add(baseR, qRotate(q, localBp));
        const wv = add(baseV, qRotate(q, localBp.sub(localBpPrev).multiplyScalar(1 / dt)));
        ents.push({ r: wr, v: wv, m: 5, rad: 0.8, isBelt: true, beltIdx: i });
      }
    }

    // 衝突判定 O(N^2) (N<200)
    for (let i = 0; i < ents.length; i++) {
      for (let j = i + 1; j < ents.length; j++) {
        const A = ents[i]!;
        const B = ents[j]!;
        if (A.isBelt && B.isBelt) continue; // ベルト同士は距離拘束があるため省略
        if ((A.isPlayer && B.isBelt) || (B.isPlayer && A.isBelt)) continue; // 自機と自機のベルトは判定しない
        const impact = resolvePair(A.r, A.v, A.m, A.rad, B.r, B.v, B.m, B.rad);
        // 薬莢が機体に実際にぶつかったら、からんという金属音を鳴らす
        // (レート制限は updateAmmoLogistics で実時間 dt により減算される this.clankCd)
        if (impact && this.clankCd <= 0 && ((A.isPlayer && B.isCasing) || (B.isPlayer && A.isCasing))) {
          this.sfx.clank();
          this.clankCd = C.CASING_CLANK_COOLDOWN;
        }
      }
    }

    // ベルトの位置を自機ローカル座標に書き戻す
    if (this.player.alive && dt > 1e-6) {
      const pq = this.player.att.q;
      const qInv = { x: -pq.x, y: -pq.y, z: -pq.z, w: pq.w };
      const baseR = this.player.state.r;
      const baseV = this.player.state.v;
      for (const e of ents) {
        if (e.isBelt && e.beltIdx !== undefined) {
          const bpLocal = qRotate(qInv, sub(e.r, baseR));
          const bvLocal = qRotate(qInv, sub(e.v, baseV));
          // THREE.Vector3 にコピー
          this.belt.beltPos[e.beltIdx]!.set(bpLocal.x, bpLocal.y, bpLocal.z);
          // bvLocal を加算して prevPos を逆算: pos - vel*dt
          this.belt.beltPrevPos[e.beltIdx]!.set(
            bpLocal.x - bvLocal.x * dt,
            bpLocal.y - bvLocal.y * dt,
            bpLocal.z - bvLocal.z * dt
          );
        }
      }
    }
  }
}
