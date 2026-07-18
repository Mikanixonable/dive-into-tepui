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
  j2Accel,
  stateFromElements,
  stepOrbitRK4,
  thirdBodyAccel,
} from '../physics/orbital';
import {
  MU_MOON,
  MU_SUN,
  R_MOON,
  moonPosition,
  sunAzimuth,
  sunPosition,
  emLagrangePoints,
  seLagrangePoints,
} from '../physics/ephemeris';
import { PlannedNode, PredictOpts, TrajectorySample, dvToWorld, predictTrajectory, sampleAt } from '../physics/predict';
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
import { atmosphericDensity } from '../physics/atmosphere';
import * as C from './const';
import { Bullet, Casing, DebrisPiece, FlashEffect, MagPickup, Ship } from './entities';
import { Navball } from './navball';
import { Input } from './input';
import { TouchControls } from './touch';
import { AxisHandleSpec, MapGizmo, NodeHandleSpec } from './mapgizmo';
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
  MUZZLE_OFFSETS,
  RCS_BLOCK_OFFSETS,
  buildBulletMesh,
  buildCasingMesh,
  buildDebrisMesh,
  buildEnemyShip,
  buildFlashMesh,
  buildMagazineFrame,
  buildMagazineMesh,
  buildMagPickup,
  buildPlayerShip,
} from '../render/ships';
import { OrbitLine } from '../render/orbitline';
import { TrajLine } from '../render/trajline';

type GamePhase = 'playing' | 'won' | 'lost' | 'timeup';

interface EnemySpec {
  name: string;
  state: OrbitState;
  hp: number;
  accent: number;
}

type MapFocus = string;

const tmpV = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const Z_AXIS = new THREE.Vector3(0, 0, 1);
const X_AXIS = new THREE.Vector3(1, 0, 0);

// updateBeltPhysics 専用のスクラッチ変数(毎フレーム/リンクごとの new THREE.Vector3
// 割り当てを避けるため使い回す。同一フレーム内で再入・並行使用されないことが前提)。
const beltQInv = new THREE.Quaternion();
const beltAThrustBody = new THREE.Vector3();
const beltW = new THREE.Vector3();
const beltAlpha = new THREE.Vector3();
const beltAnchor = new THREE.Vector3();
const beltRootPos = new THREE.Vector3();
const beltVel = new THREE.Vector3();
const beltAccel = new THREE.Vector3();
const beltTmpA = new THREE.Vector3();
const beltTmpB = new THREE.Vector3();
const beltNext = new THREE.Vector3();
const beltDelta = new THREE.Vector3();
const beltDir = new THREE.Vector3();
const beltTmpVX = new THREE.Vector3();
const beltDirLocal = new THREE.Vector3(); // 前リンクのローカル系に変換した辺り方向（ピッチ/ヨー制限用）
const beltQInvPrev = new THREE.Quaternion(); // beltQPrev の逆四元数局所変数
const beltQPrev = new THREE.Quaternion();
const beltQDelta = new THREE.Quaternion();
const beltQBend = new THREE.Quaternion();
const beltQTwist = new THREE.Quaternion();

function randSym(amp: number): number {
  return (Math.random() * 2 - 1) * amp;
}

function randVec(amp: number): Vec3 {
  return v3(randSym(amp), randSym(amp), randSym(amp));
}

// スクリーン投影マーカーのラベル用コンパクトな距離表記(例: "420m" / "2.2km")
function fmtMarkerDist(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1)}km` : `${m.toFixed(0)}m`;
}

const EARTH_OMEGA = (2 * Math.PI) / SIDEREAL_DAY; // 地球自転角速度 [rad/s](Y軸=北極まわり)

// 地球と共回転する大気に対する対気速度: v - ω×r, ω = (0, ω, 0)
function airspeed(r: Vec3, v: Vec3): Vec3 {
  return v3(v.x - EARTH_OMEGA * r.z, v.y, v.z + EARTH_OMEGA * r.x);
}

// fwd に直交するランダム単位ベクトル(散布界用)
function randPerp(fwd: Vec3): Vec3 {
  for (; ;) {
    const r = randVec(1);
    const p = sub(r, scale(fwd, dot(r, fwd)));
    if (lenSq(p) > 1e-6) return norm(p);
  }
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
  private casings: Casing[] = [];
  private debris: DebrisPiece[] = [];
  private effects: FlashEffect[] = [];
  // ターゲット標的面の通過点(ターゲット相対オフセットで保持し、的に貼り付いて見せる)
  private boardMarks: { off: Vec3; age: number }[] = [];

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
  private mapYaw = 0.7;
  private mapPitch = 0.45;
  private mapDist = 4.5e7;
  private mapFocus: MapFocus = 'earth';
  // Stored in the floating-origin render frame. It is applied to both the
  // camera and its target, so middle-drag is a true parallel translation.
  private readonly mapPan = new THREE.Vector3();
  private readonly mapCamera: THREE.PerspectiveCamera;
  private readonly starsMesh: THREE.Mesh;
  private readonly trajLine = new TrajLine();

  // 複数ノード・時間ベースの軌道計画(絶対 simTime を持つノードの列。時刻順)。
  // 各ノードの Δv はノード実行時点の(その時点までの計画を反映した)速度を基準に
  // プログレード/ノーマル/ラジアルアウト成分で保持する — ワープで時間が進んでも
  // ノード自体の実行時刻は絶対時刻なのでドリフトしない。
  private planNodes: PlannedNode[] = [];
  private selectedNodeIdx: number | null = null;
  // 数値予測(predict.ts)の結果キャッシュ。マップモードのポリライン描画・
  // クリックピッキング・戦闘ビューの噴射ガイドの双方で共有する。
  private trajSamples: TrajectorySample[] = [];
  private trajDirty = true; // ノード変更等で再計算が必要
  private trajGeomDirty = true; // trajLine のジオメトリ再構築が必要(refreshTrajectory 後に立てる)
  private trajLastRefreshMs = -Infinity; // performance.now() 基準
  // マップモードの「太陽回転系」表示で、予測サンプルを t_now 時点の太陽方位へ
  // 揃えるための回転角。再計算(refreshTrajectory)のたびに固定し、次の
  // 再計算まではクリック判定・描画とも同じ値を使う(表示と判定の整合を取るため)。
  private trajYawRef = 0;
  private predictDurationKey: 'orbit' | 'day' | 'week' | 'month' = 'day';
  private mapFrameRotating = false;
  private mapSliderT = 0; // 0..1(0 でゴーストマーカー非表示)
  // [N] または右クリックメニューの「この時刻まで自動ワープ」で設定する自動ワープの
  // 目標時刻(絶対 simTime)。null なら自動ワープ無効。任意のノード(2件目以降も可)や
  // 将来的には任意の時刻を対象にできるよう、真偽値ではなく時刻そのものを持つ。
  private autoWarpUntil: number | null = null;
  private readonly mapGizmo = new MapGizmo();
  // 直近ノードの「実行目標」(実行後の目標位置・速度・軌道要素)。
  // 遠方(残り NODE_TARGET_FREEZE_S 超)では予測リフレッシュのたびに追従更新するが、
  // ノード接近後は凍結する。予測は毎回「現在状態にノードの全Δvを適用」して
  // 作られるため、噴射中に目標を再計算し続けると目標が噴射分だけ先へ逃げて
  // 収束しない(さらにノード時刻超過後は予測から除外されて目標が現在状態に
  // 一致し、噴射せずとも達成判定が誤成立する)——凍結はその両方を防ぐ。
  private activeTarget: { nodeTime: number; rNode: Vec3; vPlanned: Vec3; targetEl: Elements } | null = null;

  private phase: GamePhase = 'playing';
  // 第零ステージ専用: 制限時間内の撃墜数を競うスコアアタックの残り時間(実秒)
  private stage0TimeLeft = C.STAGE0_TIME_LIMIT;
  private simTime = 0;
  private lastSimDt = 0;
  private warpIdx = 0;
  private paused = false;

  private rcsDamp = false;
  private target: Ship | null = null;
  private throttleIdx = C.THROTTLE_DEFAULT_IDX; // 並進出力の段(0:弱 1:中 2:強、全 6 方向で共通)
  private fineAttitude = false;
  private progradeHold = true; // [C] 機首をプログレードへ自動保持するオートパイロット
  // [G] 視点(チェイスカメラ)を自機の姿勢(RCS操作)に追従させるか。
  // デフォルト ON: 機首・機体の天頂面を基準に視点が回転し、姿勢操作と一体的に見える。
  // OFF にすると従来通り軌道基準(プログレード・動径outward)の独立した視点に戻る。
  private camFollowAttitude = true;
  private zoomActive = false;
  private wasFiring = false;

  private hullTemp = C.HULL_START_TEMP;
  private qdyn = 0;
  private heatWarned = false;
  private lostReason = '大気圏に突入し機体を喪失した';

  private readonly navball = new Navball();
  private readonly plumeCore: THREE.Mesh;
  private readonly plumeOuter: THREE.Mesh;
  private thrustVizDir: Vec3 | null = null; // 現在の推力方向(ワールド、噴射エフェクト用)
  private thrustAccelVec: Vec3 = v3(); // 現在の推力加速度(ワールド、ベルト物理の慣性力用)
  private prevBodyW = v3(); // 前フレームの機体角速度(ベルト物理の角加速度推定用)
  private readonly rcsPuffs: THREE.Mesh[] = []; // RCS ブロック位置の噴射パフ(4基)
  private readonly sunLight: THREE.DirectionalLight;
  private readonly ambient: THREE.AmbientLight;
  private sunDirV: Vec3 = v3(1, 0, 0);

  // 天体暦(初期位相はゲームごとにランダム)
  private readonly sunPhase0 = 0; // 昼(太陽が+X側)から開始するように固定
  private readonly moonPhase0 = Math.random() * Math.PI * 2;
  private sunPos: Vec3 = v3(1.496e11, 0, 0);
  private moonPos: Vec3 = v3(3.844e8, 0, 0);
  private readonly moonMesh = createMoon();

  // 環境加速度 = 大気抵抗(種別ごとの弾道係数) + J2 + 月・太陽の第三体摂動
  private readonly envShip = this.makeEnvAccel(C.SHIP_BCINV);
  private readonly envBullet = this.makeEnvAccel(C.BULLET_BCINV);
  private readonly envSmall = this.makeEnvAccel(C.SMALL_DEBRIS_BCINV);

  private fireCooldown = 0;
  private shots = 0;
  private hits = 0;
  private kills = 0;

  // --- 弾薬・マガジン ---
  private muzzleIdx = 0; // 縦二連砲口の交互発射用
  private roundsInMag = C.MAG_ROUNDS; // 給弾中マガジンの残弾
  private magsLeft = C.INITIAL_MAGS - 1; // ベルトに連結された未使用マガジン数
  private wasEmptyClick = false;
  private magPickups: MagPickup[] = [];
  private resupplyCheckAt = C.RESUPPLY_CHECK_INTERVAL; // [sim s]
  private clankCd = 0; // 薬莢接触音のレート制限 [実 s]
  private beltFeed = 0; // 給弾の進み(0..1、表示用に平滑化)
  private readonly beltGroup = new THREE.Group();
  private readonly beltLinks: THREE.Group[] = [];
  // ベルトのたわみは物理演算(Verlet 積分 + 距離拘束)で行う。位置は機体座標系
  // (機体原点基準)。無重力(自由落下軌道)なので重力そのものは効かず、
  // 自機の推力加速度とスピン(角速度・角加速度)による慣性力(擬似力)だけが
  // ベルトを揺らす。
  private readonly beltPos: THREE.Vector3[] = [];
  private readonly beltPrevPos: THREE.Vector3[] = [];
  private beltInit = false;
  // 各リンクのチェーン軸まわりのねじれ角 [rad](機関銃ベルト同様、上下方向の
  // 折れ曲がりは距離拘束のみで自由に許容する一方、ロールはここで角度上限を掛けて
  // 制限する)。機体のロール角速度を発生源に、リンクからリンクへ位相遅れつつ
  // 伝播させ、常に ±MAG_CHAIN_MAX_ROLL_DEG に収まるよう追従・クランプする。
  private readonly beltTwist: number[] = [];
  private hudTimer = 0;
  private listTimer = 0;
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

    // 軌道計画モード用の地球中心カメラ(モルニヤ級軌道全体が収まる遠方まで)
    this.mapCamera = new THREE.PerspectiveCamera(
      50,
      window.innerWidth / window.innerHeight,
      1e4,
      C.MAP_CAMERA_FAR,
    );

    // --- 環境 ---
    this.ambient = new THREE.AmbientLight(0x8899bb, 0.25);
    this.scene.add(this.ambient);
    this.glowTex = makeGlowTexture();
    this.sun = createSun(this.glowTex);
    this.scene.add(this.sun.mesh);
    this.updateEphemeris();
    this.sunLight = new THREE.DirectionalLight(0xfff4e0, C.SUN_INTENSITY);
    this.sunLight.position.set(this.sunDirV.x * 1e5, this.sunDirV.y * 1e5, this.sunDirV.z * 1e5);
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
        this.predictDurationKey = key;
        this.trajDirty = true;
      }
    };
    this.hud.onFrameToggle = () => {
      this.mapFrameRotating = !this.mapFrameRotating;
      this.trajDirty = true;
    };
    this.hud.onMapFocusSelect = (focus) => {
      this.mapFocus = focus;
      this.mapPan.set(0, 0, 0);
    };
    this.hud.onMapViewReset = () => this.resetMapView();
    this.hud.onSliderChange = (t) => {
      this.mapSliderT = t;
    };

    // マップモードの DOM ギズモ(ノードハンドル・Δv アーム・コンテキストメニュー)
    this.mapGizmo.onNodeSelect = (idx) => {
      this.selectedNodeIdx = idx;
      this.mapGizmo.closeMenu();
      this.sfx.warp();
    };
    this.mapGizmo.onNodeDragMove = (idx, clientX, clientY) => {
      this.mapGizmo.closeMenu();
      this.dragNodeToNearestSample(idx, clientX, clientY);
    };
    this.mapGizmo.onNodeContextMenu = (clientX, clientY) => {
      this.handleMapRightClick(clientX, clientY, this.player.state.r);
    };
    this.mapGizmo.onAxisDrag = (axis, sign, deltaPx) => {
      this.applyAxisDrag(axis, sign, deltaPx);
    };
    this.mapGizmo.onMenuWarpTo = (idx) => {
      const n = this.planNodes[idx];
      if (n) {
        this.autoWarpUntil = n.time;
        this.hud.hint('指定時刻まで自動ワープ開始');
      }
    };
    this.mapGizmo.onMenuDelete = (idx) => {
      if (this.planNodes[idx]) {
        this.planNodes.splice(idx, 1);
        if (this.selectedNodeIdx === idx) this.selectedNodeIdx = null;
        else if (this.selectedNodeIdx !== null && this.selectedNodeIdx > idx) this.selectedNodeIdx--;
        this.activeTarget = null;
        this.trajDirty = true;
        this.hud.hint('ノードを削除');
      }
    };
    this.mapGizmo.onMenuFocus = (targetKey) => {
      this.mapFocus = targetKey;
      const lbl = this.mapLabels.find(l => l.id === targetKey);
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
      hp: 1,
      maxHp: 1,
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
    for (const spec of this.makeEnemySpecs(playerState, stage)) {
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
    this.retargetNearest();

    if (stage === 0) {
      this.spawnStage0InitialAmmo();
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
  get activeCamera(): THREE.PerspectiveCamera {
    return this.mapMode ? this.mapCamera : this.camera;
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

  // ステージごとの敵軌道。ステージ0は自機周囲 5km 以内に密集する近接戦闘訓練、
  // ステージ1は自機軌道の近傍、ステージ2は低軌道 2 機 + モルニヤ級高楕円軌道 3 機。
  private makeEnemySpecs(base: OrbitState, stage: number): EnemySpec[] {
    const r0 = len(base.r);
    const hHat = norm(cross(base.r, base.v));

    if (stage === 0) return this.makeStage0Specs(base, hHat);

    const phased = (dAlong: number): OrbitState => {
      const ang = dAlong / r0;
      return {
        r: rotateAxis(base.r, hHat, ang),
        v: rotateAxis(base.v, hHat, ang),
      };
    };

    if (stage === 2) {
      // モルニヤ軌道: 近地点 1,200km / 遠地点 39,400km, i=63.4°(近地点引数が歳差しない臨界傾斜),
      // ω=-90°(遠地点が北半球上空)。RAAN と位相を散らして配置。
      const molniya = (raan: number, nu: number, name: string, accent: number): EnemySpec => {
        const rp = R_EARTH + 1200e3;
        const ra = R_EARTH + 39400e3;
        const a = (rp + ra) / 2;
        const e = (ra - rp) / (ra + rp);
        return {
          name,
          state: stateFromElements(a, e, (63.4 * Math.PI) / 180, raan, -Math.PI / 2, nu),
          hp: 3,
          accent,
        };
      };
      const beta = phased(-2600);
      const betaAlt = r0 + 3000;
      beta.r = scale(norm(beta.r), betaAlt);
      beta.v = scale(norm(beta.v), Math.sqrt(MU_EARTH / betaAlt));
      return [
        { name: 'HOSTILE-α', state: phased(1800), hp: 2, accent: 0xff4a3d },
        { name: 'HOSTILE-β', state: beta, hp: 2, accent: 0xff7a2d },
        molniya(0.4, 2.6, 'MOLNIYA-γ', 0xe0409f),
        molniya(2.5, 0.9, 'MOLNIYA-δ', 0xbf3dff),
        molniya(4.6, 3.8, 'MOLNIYA-ε', 0xff2d6b),
      ];
    }

    // β: コエリプティック(少し高い円軌道)
    const beta = phased(-2800);
    const betaAlt = r0 + 2500;
    beta.r = scale(norm(beta.r), betaAlt);
    beta.v = scale(norm(beta.v), Math.sqrt(MU_EARTH / betaAlt));

    // γ: 相対傾斜 0.4° の交差軌道
    const gamma = phased(2200);
    gamma.v = rotateAxis(gamma.v, norm(gamma.r), (0.4 * Math.PI) / 180);

    // δ: 楕円軌道(遠地点が高く、毎周期近傍へ戻る)
    const delta = phased(5000);
    delta.v = scale(delta.v, 1.006);

    return [
      { name: 'HOSTILE-α', state: phased(1400), hp: 2, accent: 0xff4a3d },
      { name: 'HOSTILE-β', state: beta, hp: 2, accent: 0xff7a2d },
      { name: 'HOSTILE-γ', state: gamma, hp: 2, accent: 0xe0409f },
      { name: 'HOSTILE-δ', state: delta, hp: 3, accent: 0xbf3dff },
      { name: 'HOSTILE-ε', state: phased(60000), hp: 3, accent: 0xff2d6b },
    ];
  }

  // 第零ステージ: 色分けされた 5 グループ(各 10 機)を自機周囲 5km 以内に配置する。
  // ローカル基底(動径 r̂・進行方向 v̂・軌道法線 ĥ)上でクラスタ中心を円周状に散らし、
  // 各機はクラスタ中心の近傍にさらにジッタを加える。速度は自機と同一(概ね等速の
  // フォーメーション)にすることで、ヒルの方程式に従うゆるやかな相対運動だけが残り、
  // 静止した的にならず適度に動き続ける近接戦闘訓練場になる。
  private makeStage0Specs(base: OrbitState, hHat: Vec3): EnemySpec[] {
    const vHat = norm(base.v);
    const rHat = norm(base.r);
    const specs: EnemySpec[] = [];
    const groupCount = C.STAGE0_GROUP_ACCENTS.length;
    const safeRange = C.STAGE0_MAX_RANGE * 0.94; // マージンを残して確実に5km以内に収める

    for (let gi = 0; gi < groupCount; gi++) {
      const theta = (gi / groupCount) * Math.PI * 2;
      const centerDist = safeRange * (0.52 + Math.random() * 0.14);
      const cAlong = Math.cos(theta) * centerDist;
      const cNormal = Math.sin(theta) * centerDist;
      const cRadial = randSym(safeRange * 0.1);

      for (let i = 0; i < C.STAGE0_PER_GROUP; i++) {
        const jAlong = cAlong + randSym(500);
        const jNormal = cNormal + randSym(500);
        const jRadial = cRadial + randSym(350);
        let off = add(scale(vHat, jAlong), scale(hHat, jNormal));
        off = add(off, scale(rHat, jRadial));
        const offLen = len(off);
        if (offLen > safeRange) off = scale(off, safeRange / offLen);

        specs.push({
          name: `${C.STAGE0_GROUP_LABELS[gi]}-${i + 1}`,
          state: { r: add(base.r, off), v: clone(base.v) },
          hp: C.STAGE0_ENEMY_HP,
          accent: C.STAGE0_GROUP_ACCENTS[gi]!,
        });
      }
    }
    return specs;
  }

  // 第零ステージ開始時: 自機の近く(1km 以内)に補給マガジンを複数浮かべておく
  private spawnStage0InitialAmmo(): void {
    for (let i = 0; i < C.STAGE0_AMMO_PICKUPS; i++) {
      this.spawnMagPickup(C.STAGE0_AMMO_MIN_DIST, C.STAGE0_AMMO_MAX_DIST);
    }
  }

  // 第零ステージの制限時間(実秒。タイムワープの影響を受けない)を減算し、
  // 0 になったらスコアアタック終了として結果画面を表示する。
  private updateStage0Timer(dt: number): void {
    this.stage0TimeLeft -= dt;
    if (this.stage0TimeLeft <= 0) {
      this.stage0TimeLeft = 0;
      this.phase = 'timeup';
      this.sfx.setThrust(false);
      this.sfx.stopBgm();
      const acc = this.shots > 0 ? ((this.hits / this.shots) * 100).toFixed(1) : '0.0';
      this.hud.showEnd(
        true,
        `撃墜 ${this.kills} / ${this.enemies.length} 機<br>` +
        `発射 ${this.shots} 発 / 命中 ${this.hits} 発 (命中率 ${acc}%)`,
        'TIME UP',
      );
    }
  }

  // ---------------------------------------------------------------- update

  update(dtRaw: number): void {
    const dt = Math.min(dtRaw, 0.1);
    this.zoomActive = !this.mapMode && this.input.down('KeyZ');
    this.handleEdgeInput();
    if (this.phase !== 'playing' && this.mapMode) {
      // ゲーム終了時はマップモードを強制解除する
      this.mapMode = false;
      this.hud.setPlanPanel(null);
      this.hud.setMapToolbarVisible(false);
      this.mapGizmo.closeMenu();
      this.touchControls?.setMapMode(false);
    }
    if (!this.paused && this.phase === 'playing') {
      // 軌道計画モード中も時間を進め、ワープできるようにする(手動推進・射撃のみ
      // simulate() 内部で無効化する)。ノード編集は同じフレームの現在軌道に対して行う。
      this.simulate(dt);
      if (this.mapMode) this.updateMapPlanning(dt);
      else {
        // 戦闘中のクリック・右クリックは射撃扱いのみ(座標キューは捨てる)
        this.input.takeClicks();
        this.input.takeRightClicks();
      }
      if (this.stage === 0) this.updateStage0Timer(dt);
    } else {
      this.lastSimDt = 0;
      this.sfx.setThrust(false);
      this.thrustVizDir = null;
      this.thrustAccelVec = v3();
      this.input.takeClicks();
      this.input.takeRightClicks();
    }
    if (this.phase !== 'playing') {
      // 撃破後もデブリ等は流し続ける(演出)
      this.coastWorld(dt);
    }
    this.syncRender(dt);
  }

  private warp(): number {
    return C.WARP_LEVELS[this.warpIdx]!;
  }

  private handleEdgeInput(): void {
    for (const code of this.input.takePresses()) {
      switch (code) {
        case 'Tab':
          this.cycleTarget();
          break;

        case 'KeyT':
          this.rcsDamp = !this.rcsDamp;
          this.hud.hint(`RCS 回転制動: ${this.rcsDamp ? 'ON' : 'OFF'}`);
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
          if (this.planNodes.length > 0 && this.phase === 'playing') {
            this.autoWarpUntil = this.autoWarpUntil !== null ? null : this.planNodes[0]!.time;
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
            if (this.selectedNodeIdx !== null) {
              this.planNodes.splice(this.selectedNodeIdx, 1);
              this.selectedNodeIdx = null;
              this.activeTarget = null;
              this.trajDirty = true;
              this.hud.hint('ノードを削除');
            }
          } else if (this.planNodes.length > 0) {
            this.planNodes = [];
            this.selectedNodeIdx = null;
            this.activeTarget = null;
            this.autoWarpUntil = null;
            this.trajDirty = true;
            this.hud.hint('マニューバ計画を破棄');
          }
          break;
        case 'KeyP':
          this.paused = !this.paused;
          break;
        case 'KeyH':
          this.hud.toggleHelp();
          break;
        case 'Escape':
          this.hud.toggleSettings();
          break;
        case 'KeyR':
          if (this.phase !== 'playing') location.reload();
          break;
      }
    }
  }

  private cycleTarget(): void {
    const alive = this.enemies
      .filter((e) => e.alive)
      .sort((a, b) => lenSq(sub(a.state.r, this.player.state.r)) - lenSq(sub(b.state.r, this.player.state.r)));
    if (alive.length === 0) return;
    const idx = this.target ? alive.indexOf(this.target) : -1;
    this.target = alive[(idx + 1) % alive.length]!;
    this.hud.hint(`ターゲット: ${this.target.name}`);
  }

  private retargetNearest(): void {
    const alive = this.enemies.filter((e) => e.alive);
    if (alive.length === 0) {
      this.target = null;
      return;
    }
    alive.sort(
      (a, b) => lenSq(sub(a.state.r, this.player.state.r)) - lenSq(sub(b.state.r, this.player.state.r)),
    );
    this.target = alive[0]!;
  }

  // ------------------------------------------------------- maneuver planning

  private toggleMap(): void {
    if (this.phase !== 'playing') return;
    if (!this.mapMode) {
      this.mapMode = true;
      this.selectedNodeIdx = null;
      this.trajDirty = true;
      this.hud.setMapToolbarVisible(true);
      this.touchControls?.setMapMode(true);
      this.hud.hint(
        '軌道計画モード: 軌道をクリックしてノード配置 → ドラッグで移動・矢印ハンドルでΔv調整 → 右クリックでメニュー → [M] で確定',
        5000,
      );
    } else {
      this.mapMode = false;
      // Δv がほぼゼロのまま放置されたノード(クリックしただけで調整しなかった等)は破棄する。
      this.planNodes = this.planNodes.filter((n) => len(n.dv) >= C.NODE_MIN_DV);
      this.selectedNodeIdx = null;
      // マップで Δv・ノード構成が変わった可能性があるので凍結済み目標は作り直す
      // (時刻が同じままΔvだけ編集されたケースは nodeTime 比較では検出できない)。
      this.activeTarget = null;
      this.trajDirty = true;
      this.hud.setMapToolbarVisible(false);
      this.hud.setPlanPanel(null);
      this.mapGizmo.closeMenu();
      this.touchControls?.setMapMode(false);
      if (this.planNodes.length > 0) {
        this.hud.hint(`マニューバ計画 ${this.planNodes.length} 件確定 — [N] で直近ノードへ自動ワープ`, 4500);
      }
    }
  }

  // マップモードの右クリック処理: 既存ノードマーカー近傍(NODE_PICK_PX 以内)なら
  // そのノードを選択してコンテキストメニューを開く。それ以外なら開いているメニューを閉じるだけ
  // (右クリックの元の「即削除」動作はメニュー経由に置き換えた。[X] キーは従来どおり残す)。
  private resetMapView(): void {
    this.mapFocus = 'earth';
    this.mapYaw = 0.7;
    this.mapPitch = 0.45;
    this.mapDist = 4.5e7;
    this.mapPan.set(0, 0, 0);
    this.hud.hint('マップ視点をリセット');
  }

  private handleMapRightClick(mx: number, my: number, o: Vec3): void {
    let bestIdx: number | null = null;
    let bestD = C.NODE_PICK_PX * C.NODE_PICK_PX;
    for (let i = 0; i < this.planNodes.length; i++) {
      const p = this.nodeScreenPos(this.planNodes[i]!, o);
      if (!p || !p.front) continue;
      const d = (p.x - mx) * (p.x - mx) + (p.y - my) * (p.y - my);
      if (d < bestD) {
        bestD = d;
        bestIdx = i;
      }
    }

    let bestTargetKey: string | null = null;
    let bestTargetD = 20 * 20;
    for (const lbl of this.mapLabels) {
      const wp = sub(lbl.pos, o);
      const p = this.project(wp);
      if (!p || !p.front) continue;
      const d = (p.x - mx) * (p.x - mx) + (p.y - my) * (p.y - my);
      if (d < bestTargetD) {
        bestTargetD = d;
        bestTargetKey = lbl.id;
      }
    }

    if (bestIdx !== null) {
      this.selectedNodeIdx = bestIdx;
      this.mapGizmo.openMenu(mx, my, { idx: bestIdx });
    } else if (bestTargetKey !== null) {
      this.mapGizmo.openMenu(mx, my, { targetKey: bestTargetKey });
    } else {
      this.mapGizmo.closeMenu();
    }
  }

  // ノードハンドルのドラッグ移動: ポインタ最寄りの予測サンプル時刻へノードを移動する
  // (handleMapClick の第二段(軌道クリック配置)と同じピッキング方式)。
  // 移動後は時刻順を保つよう再ソートし、同一ノードオブジェクトを選択し直す
  // (この結果、後続ノードは絶対時刻を保ったままになる=並び順が変わり得る)。
  private dragNodeToNearestSample(idx: number, clientX: number, clientY: number): void {
    const node = this.planNodes[idx];
    if (!node || this.trajSamples.length === 0) return;
    const o = this.player.state.r;
    let bestT: number | null = null;
    let bestD = Infinity;
    for (const s of this.trajSamples) {
      const p = this.project(sub(this.toDisplayFrame(s.r, s.t), o));
      if (!p.front) continue;
      const d = (p.x - clientX) * (p.x - clientX) + (p.y - clientY) * (p.y - clientY);
      if (d < bestD) {
        bestD = d;
        bestT = s.t;
      }
    }
    if (bestT !== null && bestT !== node.time) {
      node.time = bestT;
      this.planNodes.sort((a, b) => a.time - b.time);
      this.selectedNodeIdx = this.planNodes.indexOf(node);
      this.trajDirty = true;
    }
  }

  // 選択中ノードの Δv アーム(mapgizmo.ts)ドラッグを Δv 成分の変更へ変換する。
  // axis: 0=プログレード(dv.x) 1=法線(dv.y) 2=動径(dv.z)。sign はハンドル自身の向き
  // (mapgizmo.ts の AxisHandleSpec 参照)。deltaPx はポインタ移動のハンドル方向への射影量。
  private applyAxisDrag(axis: 0 | 1 | 2, sign: 1 | -1, deltaPx: number): void {
    if (this.selectedNodeIdx === null) return;
    const node = this.planNodes[this.selectedNodeIdx];
    if (!node) return;
    const rate = (this.fineAttitude ? C.NODE_DV_RATE_FINE : C.NODE_DV_RATE) / 200;
    const d = deltaPx * sign * rate;
    if (axis === 0) node.dv = v3(node.dv.x + d, node.dv.y, node.dv.z);
    else if (axis === 1) node.dv = v3(node.dv.x, node.dv.y + d, node.dv.z);
    else node.dv = v3(node.dv.x, node.dv.y, node.dv.z + d);
    this.trajDirty = true;
  }

  // 選択中ノードの Δv アーム 6 個(プログレード/レトログレード・ノーマル/アンチノーマル・
  // アウト/イン)の画面方向を求める。トラジェクトリサンプルの r, v からその時点の
  // プログレード・軌道法線・動径アウト方向を求め、toDisplayFrame で表示座標系へ回転した
  // 上でノード位置との画面上の差分を取ることで、3D 回転行列を介さず画面方向を得る。
  private computeAxisScreenDirs(
    node: PlannedNode,
    o: Vec3,
  ): { pro: { x: number; y: number }; nrm: { x: number; y: number }; rad: { x: number; y: number } } | null {
    const s = sampleAt(this.trajSamples, node.time);
    if (!s) return null;
    const pro = norm(s.v);
    const h = norm(cross(s.r, s.v));
    const radOut = cross(pro, h);
    const L = this.mapDist * 0.05;
    const p0 = this.project(sub(this.toDisplayFrame(s.r, node.time), o));
    const dirFor = (axisVec: Vec3): { x: number; y: number } => {
      const p1 = this.project(sub(this.toDisplayFrame(add(s.r, scale(axisVec, L)), node.time), o));
      const dx = p1.x - p0.x;
      const dy = p1.y - p0.y;
      const m = Math.hypot(dx, dy);
      return m > 1e-6 ? { x: dx / m, y: dy / m } : { x: 0, y: -1 };
    };
    return { pro: dirFor(pro), nrm: dirFor(h), rad: dirFor(radOut) };
  }

  private buildAxisHandles(
    nx: number,
    ny: number,
    dirs: { pro: { x: number; y: number }; nrm: { x: number; y: number }; rad: { x: number; y: number } },
  ): AxisHandleSpec[] {
    const R = C.NODE_GIZMO_HANDLE_PX;
    const mk = (axis: 0 | 1 | 2, sign: 1 | -1, d: { x: number; y: number }, label: string): AxisHandleSpec => ({
      axis,
      sign,
      x: nx + d.x * R * sign,
      y: ny + d.y * R * sign,
      dirx: d.x * sign,
      diry: d.y * sign,
      label,
    });
    return [
      mk(0, 1, dirs.pro, 'PRO'),
      mk(0, -1, dirs.pro, 'RET'),
      mk(1, 1, dirs.nrm, 'NRM'),
      mk(1, -1, dirs.nrm, 'ANM'),
      mk(2, 1, dirs.rad, 'OUT'),
      mk(2, -1, dirs.rad, 'IN'),
    ];
  }

  // 毎フレーム、マップモードの DOM ギズモ(ノードハンドル・選択中ノードの Δv アーム)を
  // 画面座標で更新する。マップモード外・ノードが背後(front=false)なら該当分を隠す。
  private updateMapGizmo(o: Vec3): void {
    if (!this.mapMode) {
      this.mapGizmo.update([], null);
      return;
    }
    const nodeSpecs: NodeHandleSpec[] = [];
    const limit = Math.min(this.planNodes.length, C.MAX_PLAN_NODE_MARKERS);
    for (let i = 0; i < limit; i++) {
      const node = this.planNodes[i]!;
      const p = this.nodeScreenPos(node, o);
      if (!p || !p.front) continue;
      nodeSpecs.push({ idx: i, x: p.x, y: p.y, selected: i === this.selectedNodeIdx, dvMag: len(node.dv) });
    }
    let axisSpecs: AxisHandleSpec[] | null = null;
    if (this.selectedNodeIdx !== null) {
      const node = this.planNodes[this.selectedNodeIdx];
      if (node) {
        const p = this.nodeScreenPos(node, o);
        if (p && p.front) {
          const dirs = this.computeAxisScreenDirs(node, o);
          if (dirs) axisSpecs = this.buildAxisHandles(p.x, p.y, dirs);
        }
      }
    }
    this.mapGizmo.update(nodeSpecs, axisSpecs);
  }

  // 数値予測(predict.ts)の再計算対象の期間 [s]。マップモードではツールバーで
  // 選んだ期間、戦闘ビューでは直近の未達成ノードをちょうど含む程度の短い期間だけ
  // 計算する(28日ぶんを毎回計算するのは無駄なコストになるため)。
  private predictDurationSec(): number {
    if (this.predictDurationKey === 'orbit') {
      const el = elementsFromState(this.player.state.r, this.player.state.v);
      if (el && isFinite(el.period) && el.period > 0) return el.period;
      return C.PREDICT_DUR_DAY; // 双曲線・放物線軌道では1日にフォールバック
    }
    if (this.predictDurationKey === 'week') return C.PREDICT_DUR_WEEK;
    if (this.predictDurationKey === 'month') return C.PREDICT_DUR_MONTH;
    return C.PREDICT_DUR_DAY;
  }

  private refreshTrajectory(): void {
    let duration: number;
    if (this.mapMode) {
      duration = this.predictDurationSec();
    } else {
      const first = this.planNodes[0];
      duration = first ? Math.max(60, first.time - this.simTime + 120) : 0;
    }
    if (duration <= 0) {
      this.trajSamples = [];
    } else {
      const opts: PredictOpts = {
        sunPhase0: this.sunPhase0,
        moonPhase0: this.moonPhase0,
        maxSamples: C.PREDICT_MAX_SAMPLES,
      };
      this.trajSamples = predictTrajectory(this.player.state, this.simTime, duration, this.planNodes, opts);
    }
    this.trajYawRef = this.mapFrameRotating ? sunAzimuth(this.simTime, this.sunPhase0) : 0;
    this.trajDirty = false;
    this.trajGeomDirty = true;
    this.trajLastRefreshMs = performance.now();
  }

  // dirty フラグが立っていれば ~5Hz、そうでなければ2秒ごとに予測を再計算する。
  // マップモードでもなくノードもなければ(表示・ガイドとも不要なので)何もしない。
  private updateTrajectoryRefresh(): void {
    const needed = this.mapMode || this.planNodes.length > 0;
    if (!needed) {
      if (this.trajSamples.length > 0) this.trajSamples = [];
      return;
    }
    const elapsed = performance.now() - this.trajLastRefreshMs;
    const threshold = this.trajDirty ? C.PREDICT_DIRTY_THROTTLE_MS : C.PREDICT_REFRESH_INTERVAL_MS;
    if (elapsed >= threshold) this.refreshTrajectory();
  }

  // ECI 座標 r(時刻 t のもの)をマップの「太陽回転系」表示用に回転させる
  // (非回転系なら無変換)。回転角は直近の refreshTrajectory 時点で固定した
  // trajYawRef を使うので、次回再計算までは描画とクリック判定が一致する。
  private toDisplayFrame(r: Vec3, t: number): Vec3 {
    if (!this.mapFrameRotating) return r;
    const phi = this.trajYawRef - sunAzimuth(t, this.sunPhase0);
    return rotateAxis(r, v3(0, 1, 0), phi);
  }

  private nodeScreenPos(node: PlannedNode, o: Vec3): { x: number; y: number; front: boolean } | null {
    const s = sampleAt(this.trajSamples, node.time);
    if (!s) return null;
    return this.project(sub(this.toDisplayFrame(s.r, node.time), o));
  }

  // マップ上のクリック処理: 既存ノードマーカー近傍なら選択、そうでなければ
  // 予測軌道(既存ノードの噴射も反映済みの折れ線)上の最近傍サンプル時刻に
  // 新規ノードを配置して選択する。
  private handleMapClick(mx: number, my: number, o: Vec3): void {
    this.mapGizmo.closeMenu();
    let bestNodeIdx: number | null = null;
    let bestNodeD = C.NODE_PICK_PX * C.NODE_PICK_PX;
    for (let i = 0; i < this.planNodes.length; i++) {
      const p = this.nodeScreenPos(this.planNodes[i]!, o);
      if (!p || !p.front) continue;
      const d = (p.x - mx) * (p.x - mx) + (p.y - my) * (p.y - my);
      if (d < bestNodeD) {
        bestNodeD = d;
        bestNodeIdx = i;
      }
    }
    if (bestNodeIdx !== null) {
      this.selectedNodeIdx = bestNodeIdx;
      this.sfx.warp();
      return;
    }

    if (this.trajSamples.length < 2) return;
    let bestT: number | null = null;
    let bestD = C.NODE_PICK_PX * C.NODE_PICK_PX;
    for (const s of this.trajSamples) {
      const p = this.project(sub(this.toDisplayFrame(s.r, s.t), o));
      if (!p.front) continue;
      const d = (p.x - mx) * (p.x - mx) + (p.y - my) * (p.y - my);
      if (d < bestD) {
        bestD = d;
        bestT = s.t;
      }
    }
    if (bestT !== null) {
      const newNode: PlannedNode = { time: bestT, dv: v3() };
      this.planNodes.push(newNode);
      this.planNodes.sort((a, b) => a.time - b.time);
      this.selectedNodeIdx = this.planNodes.indexOf(newNode);
      this.trajDirty = true;
      this.sfx.warp();
    }
  }

  // 未来位置ゴースト(スライダー)のラベル文字列
  private ghostLabel(): string {
    const duration = this.predictDurationSec();
    const t = this.simTime + this.mapSliderT * duration;
    const s = sampleAt(this.trajSamples, t);
    if (!s) return '';
    const tRel = t - this.simTime;
    const alt = len(s.r) - R_EARTH;
    const h = Math.floor(tRel / 3600);
    const m = Math.floor((tRel % 3600) / 60);
    return `T+${h}h${String(m).padStart(2, '0')}m 高度 ${(alt / 1000).toFixed(0)}km`;
  }

  // マップ表示中のノード編集(時間・物理は simulate() 側で通常どおり進み続ける。
  // ここではクリックによるノード配置・選択、選択中ノードの Δv 調整、
  // ツールバー・計画パネルの表示を行う)
  private updateMapPlanning(dt: number): void {
    const o = this.player.state.r;

    for (const c of this.input.takeClicks()) {
      this.handleMapClick(c.x, c.y, o);
    }
    for (const rc of this.input.takeRightClicks()) {
      this.handleMapRightClick(rc.x, rc.y, o);
    }

    // Δv 調整(推進キーを流用、[V] で微調整)。選択中ノードがあるときのみ。
    const selNode = this.selectedNodeIdx !== null ? this.planNodes[this.selectedNodeIdx] : undefined;
    if (selNode) {
      const i = this.input;
      const rate = (this.fineAttitude ? C.NODE_DV_RATE_FINE : C.NODE_DV_RATE) * dt;
      const dvx = ((i.down('KeyW') ? 1 : 0) + (i.down('KeyS') ? -1 : 0)) * rate;
      const dvy = ((i.down('KeyA') ? 1 : 0) + (i.down('KeyD') ? -1 : 0)) * rate;
      const dvz = ((i.down('KeyE') ? 1 : 0) + (i.down('KeyQ') ? -1 : 0)) * rate;
      if (dvx !== 0 || dvy !== 0 || dvz !== 0) {
        selNode.dv = v3(selNode.dv.x + dvx, selNode.dv.y + dvy, selNode.dv.z + dvz);
        this.trajDirty = true;
      }
    }

    this.hud.setMapToolbarState(
      this.predictDurationKey,
      this.mapFrameRotating,
      this.mapSliderT > 0 ? this.ghostLabel() : null,
      this.mapFocus,
    );

    this.drawMapLabels(o);

    const nodesInfo = this.planNodes.map((n, i) => ({
      tRel: n.time - this.simTime,
      dvMag: len(n.dv),
      selected: i === this.selectedNodeIdx,
    }));
    let selDv: Vec3 | null = null;
    let selEl: Elements | null = null;
    if (selNode) {
      selDv = selNode.dv;
      const s = sampleAt(this.trajSamples, selNode.time);
      if (s) selEl = elementsFromState(s.r, s.v);
    }
    this.hud.setPlanPanel(this.hud.planHtml(nodesInfo, selDv, selEl));
  }

  private mapLabels: { id: string; name: string; pos: Vec3 }[] = [];

  private drawMapLabels(o: Vec3): void {
    const t = this.simTime;
    const mPos = moonPosition(t, this.sunPhase0);
    const sPos = sunPosition(t, this.sunPhase0);
    const emL = emLagrangePoints(t, this.sunPhase0);
    const seL = seLagrangePoints(t, this.sunPhase0);

    this.mapLabels = [
      { id: 'earth', name: '地球', pos: v3(0, 0, 0) },
      { id: 'moon', name: '月', pos: mPos },
      { id: 'sun', name: '太陽', pos: sPos },
      { id: 'em-l1', name: '地球-月 L1', pos: emL.L1 },
      { id: 'em-l2', name: '地球-月 L2', pos: emL.L2 },
      { id: 'em-l3', name: '地球-月 L3', pos: emL.L3 },
      { id: 'em-l4', name: '地球-月 L4', pos: emL.L4 },
      { id: 'em-l5', name: '地球-月 L5', pos: emL.L5 },
      { id: 'se-l1', name: '太陽-地球 L1', pos: seL.L1 },
      { id: 'se-l2', name: '太陽-地球 L2', pos: seL.L2 },
    ];

    for (const lbl of this.mapLabels) {
      const wp = sub(lbl.pos, o);
      const p = this.project(wp);
      if (p && p.front) {
        this.hud.marker(lbl.id, 'poi', '●', p.x, p.y, true, lbl.name);
      } else {
        this.hud.marker(lbl.id, 'poi', '●', 0, 0, false, lbl.name);
      }
    }
  }

  // 噴射ガイドの達成判定と表示(戦闘ビュー)。直近(最も時刻が早い)未達成ノードを対象にする。
  private updateNodeGuide(o: Vec3, pv: Vec3, playerEl: Elements | null): void {
    const node = this.planNodes[0];
    if (!node || this.mapMode || !this.player.alive) {
      this.hud.hideMarker('nd');
      this.hud.hideMarker('burn');
      if (!this.mapMode) this.hud.setPlanPanel(null);
      return;
    }

    // 実行目標の構築・追従・凍結(凍結の理由は activeTarget フィールドのコメント参照)。
    const tRem = node.time - this.simTime;
    if (this.activeTarget && this.activeTarget.nodeTime !== node.time) this.activeTarget = null;
    if (!this.activeTarget || tRem > C.NODE_TARGET_FREEZE_S) {
      if (tRem > 0) {
        // 予測(ノードΔv適用済み)からノード実行直後の状態を取る
        const s = sampleAt(this.trajSamples, node.time);
        const el = s ? elementsFromState(s.r, s.v) : null;
        if (s && el) {
          this.activeTarget = { nodeTime: node.time, rNode: s.r, vPlanned: s.v, targetEl: el };
        }
      } else if (!this.activeTarget) {
        // ノード時刻を過ぎているのに目標が無い(過去時刻へのノード配置など)。
        // 「今すぐ全Δvを噴射する」目標として現在状態から一度だけ構築・凍結する。
        const vP = add(pv, dvToWorld(o, pv, node.dv));
        const el = elementsFromState(o, vP);
        if (el) {
          this.activeTarget = { nodeTime: node.time, rNode: clone(o), vPlanned: vP, targetEl: el };
        }
      }
    }
    const tgt = this.activeTarget;
    if (!tgt) {
      this.hud.hideMarker('nd');
      this.hud.hideMarker('burn');
      return;
    }

    // 達成判定: 現在軌道が(凍結済みの)ノード実行後の計画軌道に十分近い
    if (playerEl && this.orbitClose(playerEl, tgt.targetEl)) {
      this.planNodes.shift();
      this.selectedNodeIdx = null;
      this.activeTarget = null;
      this.autoWarpUntil = null;
      this.trajDirty = true;
      this.hud.hideMarker('nd');
      this.hud.hideMarker('burn');
      if (this.planNodes.length === 0) {
        this.hud.setPlanPanel(null);
        this.hud.hint('✓ マニューバ達成 — 計画軌道に到達', 5000);
      } else {
        this.hud.hint(`✓ ノード達成 — 残り ${this.planNodes.length} 件`, 4000);
      }
      this.sfx.warp();
      return;
    }

    // ノード位置マーカー(カウントダウン付き)
    const p = this.project(sub(tgt.rNode, o));
    const tLabel =
      tRem >= 0
        ? `T-${Math.floor(tRem / 60)}:${String(Math.floor(tRem % 60)).padStart(2, '0')}`
        : `T+${Math.floor(-tRem / 60)}:${String(Math.floor(-tRem % 60)).padStart(2, '0')}`;
    const more = this.planNodes.length > 1 ? ` (+${this.planNodes.length - 1})` : '';
    this.hud.marker('nd', 'mk-mnode', '◆', p.x, p.y, p.front, `NODE ${tLabel}${more}`);

    // 噴射ガイド: (凍結済みの)目標速度ベクトルとの差分方向へ加速する
    const dvRem = sub(tgt.vPlanned, pv);
    const mag = len(dvRem);
    const g = this.project(scale(norm(dvRem), 5e4));
    this.hud.marker(
      'burn',
      'mk-burn',
      '⬢',
      g.x,
      g.y,
      g.front,
      `BURN ${mag.toFixed(1)} m/s → ${(len(tgt.vPlanned) / 1000).toFixed(2)} km/s`,
    );
  }

  // 2 軌道の近さ判定(長半径・離心率・軌道面)
  private orbitClose(a: Elements, b: Elements): boolean {
    if (!isFinite(a.a) || !isFinite(b.a) || a.a <= 0 || b.a <= 0) return false;
    const planeCos = Math.max(-1, Math.min(1, dot(a.hHat, b.hHat)));
    return (
      Math.abs(a.a - b.a) / b.a < C.NODE_TOL_SMA &&
      Math.abs(a.e - b.e) < C.NODE_TOL_ECC &&
      (Math.acos(planeCos) * 180) / Math.PI < C.NODE_TOL_PLANE_DEG
    );
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
    const wantFire = rawWantFire && this.player.alive && warp <= C.MAX_PHYS_WARP && hasAmmo;
    if (wantFire && !this.wasFiring) {
      this.sfx.spinUp();
      this.fireCooldown = C.SPINUP_TIME;
    }
    this.wasFiring = wantFire;
    if (wantFire) {
      this.fireCooldown -= dt;
      if (this.fireCooldown <= 0) {
        this.fireGun();
        this.fireCooldown = C.FIRE_INTERVAL;
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
      ? (r, v) => add(thrustFn(r, v), this.envShip(r, v))
      : this.envShip;

    // 軌道積分(高ワープ時はサブステップ分割)
    const nSub = warp <= C.MAX_PHYS_WARP ? 1 : Math.min(64, Math.ceil(simDt / 20));
    const sub = simDt / nSub;
    for (let i = 0; i < nSub; i++) {
      this.updateEphemeris(); // 高ワープでも太陽・月の位置と摂動がサブステップ内で追従する
      this.player.prevR = clone(this.player.state.r);
      if (this.player.alive) {
        stepOrbitRK4(this.player.state, sub, playerAccel);
        this.updateThermal(sub);
      }
      for (const e of this.enemies) {
        if (!e.alive) continue;
        e.prevR = clone(e.state.r);
        stepOrbitRK4(e.state, sub, this.envShip);
      }
      for (const b of this.bullets) {
        if (!b.alive) continue;
        b.prevR = clone(b.state.r);
        stepOrbitRK4(b.state, sub, this.envBullet);
      }
      for (const cs of this.casings) stepOrbitRK4(cs.state, sub, this.envSmall);
      for (const d of this.debris) stepOrbitRK4(d.state, sub, this.envSmall);
      for (const mp of this.magPickups) if (mp.alive) stepOrbitRK4(mp.state, sub, this.envSmall);
      this.simTime += sub;
      this.checkBulletHits();
      this.checkBoardCrossings();
    }
    this.lastSimDt = simDt;
    this.checkThermalLimits();
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
  // 既定は 2.5〜5km 先(通常ステージの残弾補給用)。第零ステージの開始時配置では
  // より近い距離を明示的に渡す。
  private spawnMagPickup(minDist = 2500, maxDist = 5000): void {
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

  // 太陽・月の ECI 位置を simTime から更新する
  private updateEphemeris(): void {
    this.sunPos = sunPosition(this.simTime, this.sunPhase0);
    this.moonPos = moonPosition(this.simTime, this.moonPhase0);
    this.sunDirV = norm(this.sunPos);
  }

  // 大気抵抗 + J2(地球扁平) + 月・太陽の第三体(潮汐)摂動を合成した環境加速度。
  // 天体位置はサブステップ更新の this.sunPos / moonPos を閉包で参照する。
  // この関数は RK4 の全ステージ × 全エンティティ × サブステップで呼ばれるホット
  // パスなので、大気抵抗は(専用の Vec3 を作らず)直接数値演算でインライン化し、
  // 割り当てを 1 個(戻り値ぶんのみ)に抑える。J2・第三体項は共有の純関数
  // (physics/orbital.ts、テストで数値検証済み)をそのまま使う。
  private makeEnvAccel(bcInv: number): ExtraAccel {
    return (r: Vec3, v: Vec3): Vec3 => {
      const rho = atmosphericDensity(len(r) - R_EARTH);
      let ax = 0;
      let ay = 0;
      let az = 0;
      if (rho >= 1e-15) {
        const vrx = v.x - EARTH_OMEGA * r.z;
        const vry = v.y;
        const vrz = v.z + EARTH_OMEGA * r.x;
        const k = -0.5 * rho * Math.sqrt(vrx * vrx + vry * vry + vrz * vrz) * bcInv;
        ax = vrx * k;
        ay = vry * k;
        az = vrz * k;
      }
      const j = j2Accel(r);
      const s = thirdBodyAccel(r, this.sunPos, MU_SUN);
      const m = thirdBodyAccel(r, this.moonPos, MU_MOON);
      return v3(
        ax + j.x + s.x + m.x,
        ay + j.y + s.y + m.y,
        az + j.z + s.z + m.z,
      );
    };
  }

  // 対気速度から動圧と外殻温度を更新する。加熱はよどみ点熱流束の
  // Sutton–Graves 近似 q̇ = k·√(ρ/Rn)·v³、冷却はステファン・ボルツマン放射。
  private updateThermal(dtSub: number): void {
    const r = this.player.state.r;
    const v = this.player.state.v;
    const rho = atmosphericDensity(len(r) - R_EARTH);
    const vr = airspeed(r, v);
    const s = len(vr);
    this.qdyn = 0.5 * rho * s * s;
    const qdot = C.SG_CONST * Math.sqrt(rho / C.NOSE_RADIUS) * s * s * s;
    const cool =
      C.HULL_EMISS *
      C.STEFAN_BOLTZMANN *
      C.RAD_AREA *
      (Math.pow(C.ENV_TEMP, 4) - Math.pow(this.hullTemp, 4));
    this.hullTemp = Math.max(
      120,
      this.hullTemp + ((qdot * C.HEAT_ABSORB_AREA + cool) / C.HEAT_CAPACITY) * dtSub,
    );
  }

  // 熱防御の飽和・空力破壊の判定と警告表示
  private checkThermalLimits(): void {
    if (!this.player.alive) return;
    if (this.hullTemp > C.MAX_HULL_TEMP) {
      this.lostReason = '断熱圧縮による加熱で熱防御が飽和し、機体は焼失した';
      this.destroyShip(this.player);
      return;
    }
    if (this.qdyn > C.MAX_DYN_PRESSURE) {
      this.lostReason = '動圧が構造限界を超え、機体は空力的に分解した';
      this.destroyShip(this.player);
      return;
    }
    const hot = this.hullTemp > 0.7 * C.MAX_HULL_TEMP || this.qdyn > 0.5 * C.MAX_DYN_PRESSURE;
    if (hot && !this.heatWarned) {
      this.heatWarned = true;
      this.hud.hint('警告: 空力加熱・動圧が危険域 — 高度を上げよ', 4000);
    } else if (!hot && this.hullTemp < 0.6 * C.MAX_HULL_TEMP) {
      this.heatWarned = false;
    }
  }

  // 勝敗確定後もデブリ・薬莢・弾を漂わせる
  private coastWorld(dt: number): void {
    const simDt = dt * Math.min(this.warp(), 4);
    this.updateEphemeris();
    for (const b of this.bullets) if (b.alive) stepOrbitRK4(b.state, simDt, this.envBullet);
    for (const cs of this.casings) stepOrbitRK4(cs.state, simDt, this.envSmall);
    for (const d of this.debris) stepOrbitRK4(d.state, simDt, this.envSmall);
    for (const e of this.enemies) if (e.alive) stepOrbitRK4(e.state, simDt, this.envShip);
    for (const mp of this.magPickups) if (mp.alive) stepOrbitRK4(mp.state, simDt, this.envSmall);
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
    const axZ = ((i.down('KeyW') ? 1 : 0) + (i.down('KeyS') ? -1 : 0)) * manual; // 前/後 (W=前進, S=後進)

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

    if (this.progradeHold && (inX !== 0 || inY !== 0 || inZ !== 0)) {
      // 手動操作で自動保持を解除(SAS 的な挙動: 操作すると一旦解除される)
      this.progradeHold = false;
      this.hud.hint('進行方向ホールド解除(手動操作)');
    }

    // 微調整モード: 角加速度・角速度上限を絞り、小刻みな姿勢操作を可能にする
    const angScale = this.fineAttitude ? C.FINE_ATTITUDE_SCALE : 1;
    const maxAngAccel = C.MAX_ANG_ACCEL * angScale;
    const maxAngVel = C.MAX_ANG_VEL * angScale;

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

  // ------------------------------------------------------------ weapons

  private fireGun(): void {
    const p = this.player;
    const fwd = qRotate(p.att.q, v3(0, 0, 1));
    const right = qRotate(p.att.q, v3(1, 0, 0));
    const up = qRotate(p.att.q, v3(0, 1, 0));

    // 縦二連の砲口から交互に発射する
    const mo = MUZZLE_OFFSETS[this.muzzleIdx]!;
    this.muzzleIdx = (this.muzzleIdx + 1) % MUZZLE_OFFSETS.length;
    const muzzle = add(p.state.r, qRotate(p.att.q, v3(mo.x, mo.y, mo.z)));

    // 弾丸: 機首方向 + 散布界
    const dir = norm(addScaled(fwd, randPerp(fwd), Math.abs(randSym(C.BULLET_SPREAD))));
    const bullet: Bullet = {
      state: {
        r: addScaled(clone(muzzle), fwd, 1.5),
        v: addScaled(clone(p.state.v), dir, C.MUZZLE_SPEED),
      },
      prevR: v3(),
      bornSim: this.simTime,
      obj: buildBulletMesh(),
      alive: true,
    };
    bullet.prevR = clone(bullet.state.r);
    this.bullets.push(bullet);
    this.scene.add(bullet.obj);
    if (this.bullets.length > C.MAX_BULLETS) {
      const old = this.bullets.shift()!;
      this.scene.remove(old.obj);
    }

    // 反動(運動量保存の風味): 発射方向と逆に微小 Δv
    p.state.v = addScaled(p.state.v, fwd, -C.RECOIL_DV);

    // 薬莢: 機体右側(-X)へ排出(左側(+X)はマガジンベルトの給弾があるため)。
    // 初速・回転とも抑え、ゆっくり漂いながら緩やかに回転する見た目にする。
    const casing: Casing = {
      state: {
        r: add(muzzle, scale(right, -1.4)),
        v: add(
          p.state.v,
          add(scale(right, -(0.5 + Math.random() * 0.3)), add(scale(up, randSym(0.2)), randVec(0.1))),
        ),
      },
      att: {
        q: randomQuat(),
        w: v3(randSym(2.5), randSym(2.5), randSym(2.5)),
        inertia: v3(1, 0.3, 1), // 円筒: 長軸まわりが小さい
      },
      bornSim: this.simTime,
      obj: buildCasingMesh(),
    };
    this.casings.push(casing);
    this.scene.add(casing.obj);
    if (this.casings.length > C.MAX_CASINGS) {
      const old = this.casings.shift()!;
      this.scene.remove(old.obj);
    }

    // マズルフラッシュ: 発射した側の砲口に出す
    // (ズーム中は画面のちらつきを抑えるため大幅減光、完全には消さない)
    this.spawnFlash(
      addScaled(clone(muzzle), fwd, 1.2),
      clone(p.state.v),
      2.2,
      6,
      0.07,
      0xfff0b8,
      this.zoomActive ? C.ZOOM_MUZZLE_FLASH_SCALE : 1,
    );

    this.shots++;
    this.sfx.fire();

    // 弾薬消費: 16 発でマガジン 1 個を消費し、ベルトから次を自動給弾する
    this.roundsInMag--;
    if (this.roundsInMag <= 0 && this.magsLeft > 0) {
      this.magsLeft--;
      this.roundsInMag = C.MAG_ROUNDS;
      this.sfx.magFeed();
      this.spawnEjectedMagazineFrame();
    }
  }

  // マガジン1個を撃ち尽くした瞬間、機体右側(-X、薬莢と同じ側)の位置から
  // 空になったマガジンの外枠(弾なし)をデブリとして放出する。
  private spawnEjectedMagazineFrame(): void {
    const p = this.player;
    const right = qRotate(p.att.q, v3(1, 0, 0));
    const portWorld = add(p.state.r, qRotate(p.att.q, v3(-0.9, 0, 0)));
    const piece: DebrisPiece = {
      state: {
        r: portWorld,
        v: add(p.state.v, add(scale(right, -(0.5 + Math.random() * 0.3)), randVec(0.15))),
      },
      att: {
        // ランダムな向きではなく、給弾ベルトの根本と同じく機体に対して垂直な
        // 姿勢(=機体の姿勢そのまま)で排出する。そこにかすかなランダム回転
        // (角速度)だけを加え、漂いながらゆっくり回転する見た目にする。
        q: { x: p.att.q.x, y: p.att.q.y, z: p.att.q.z, w: p.att.q.w },
        w: v3(randSym(0.2), randSym(0.2), randSym(0.2)),
        inertia: v3(1, 1.2, 1.4),
      },
      obj: buildMagazineFrame(),
      collideRadius: C.EJECTED_MAG_PHYS_RADIUS,
    };
    this.debris.push(piece);
    this.scene.add(piece.obj);
    while (this.debris.length > C.MAX_DEBRIS) {
      const old = this.debris.shift()!;
      this.removeDebrisObj(old);
    }
  }

  // ターゲット位置に「自機の方を向いた的(標的面)」があると見なし、
  // 発射弾がその面を自機側から通過した点をターゲット相対で記録する。
  // 次弾の照準修正の目安になるマーカーとして一定時間表示する。
  private checkBoardCrossings(): void {
    const tgt = this.target;
    if (!tgt || !tgt.alive) return;
    const n = norm(sub(tgt.state.r, this.player.state.r)); // 的の法線 = 視線方向
    if (lenSq(n) < 0.5) return;

    for (const b of this.bullets) {
      if (!b.alive) continue;
      const d0 = dot(sub(b.prevR, tgt.state.r), n);
      const d1 = dot(sub(b.state.r, tgt.state.r), n);
      if (!(d0 < 0 && d1 >= 0)) continue; // 自機側 → 向こう側への通過のみ
      const t = d0 / (d0 - d1);
      const pos = addScaled(b.prevR, sub(b.state.r, b.prevR), t);
      const off = sub(pos, tgt.state.r);
      if (lenSq(off) > C.BOARD_RADIUS * C.BOARD_RADIUS) continue; // 的から外れすぎ
      this.boardMarks.push({ off, age: 0 });
      if (this.boardMarks.length > C.MAX_BOARD_MARKS) this.boardMarks.shift();
    }
  }

  // サブステップ間の相対運動を線分 vs 球でチェック(高速弾のトンネリング防止)
  private checkBulletHits(): void {
    for (const b of this.bullets) {
      if (!b.alive) continue;
      for (const ship of this.enemies) {
        if (!ship.alive) continue;
        if (this.segmentHit(b, ship)) {
          this.applyHit(b, ship);
          break;
        }
      }
      if (!b.alive) continue;
      // 自機被弾(軌道を一周して戻ってきた自弾)
      if (
        this.player.alive &&
        this.simTime - b.bornSim > C.SELF_HIT_GRACE &&
        this.segmentHit(b, this.player)
      ) {
        this.applyHit(b, this.player);
      }
    }
  }

  private segmentHit(b: Bullet, ship: Ship): boolean {
    const a = sub(b.prevR, ship.prevR);
    const bb = sub(b.state.r, ship.state.r);
    const d = sub(bb, a);
    const dd = lenSq(d);
    const t = dd > 1e-9 ? Math.max(0, Math.min(1, -dot(a, d) / dd)) : 0;
    const closest = addScaled(a, d, t);
    return lenSq(closest) <= ship.radius * ship.radius;
  }

  private applyHit(b: Bullet, ship: Ship): void {
    b.alive = false;
    ship.hp--;
    if (ship === this.player) this.lostReason = '自弾の被弾により機体を喪失した';
    this.hits++;
    this.sfx.hit();
    this.spawnFlash(clone(b.state.r), clone(ship.state.v), 1.5, 6, 0.25, 0xffe2a0);
    // 被弾時にも小さな欠片を飛散させる
    this.spawnFragments(clone(b.state.r), clone(ship.state.v), 3, 0x6a7078, 0.18, 0.5, 5.5);
    if (ship.hp <= 0) {
      this.destroyShip(ship);
    }
  }

  private destroyShip(ship: Ship): void {
    ship.alive = false;
    ship.obj.visible = false;
    this.sfx.explosion();
    // 敵機は自機の 10 倍サイズなので、爆発・破片も見合った大きさにする
    const sc = ship === this.player ? 1 : C.ENEMY_SCALE;
    this.spawnFlash(clone(ship.state.r), clone(ship.state.v), 10 * sc, 110 * sc, 1.1, 0xffb36b);
    this.spawnFlash(clone(ship.state.r), clone(ship.state.v), 6 * sc, 40 * sc, 0.5, 0xfffbe8);
    this.spawnDebris(ship, sc);

    if (ship === this.player) {
      this.phase = 'lost';
      this.sfx.setThrust(false);
      this.sfx.stopBgm();
      this.hud.showEnd(false, `${this.lostReason}<br>撃破 ${this.kills}/${this.enemies.length} 機`);
      return;
    }

    this.kills++;
    this.hud.hint(`${ship.name} 撃破`);
    if (this.target === ship) {
      this.retargetNearest();
    }
    if (this.enemies.every((e) => !e.alive)) {
      this.phase = 'won';
      this.sfx.setThrust(false);
      this.sfx.stopBgm();
      let unlockNote = '';
      if (this.stage === 1) {
        try {
          const first = localStorage.getItem(C.STAGE1_CLEARED_KEY) !== '1';
          localStorage.setItem(C.STAGE1_CLEARED_KEY, '1');
          if (first) unlockNote = '<br><span style="color:#ff6a00">第二ステージ(モルニヤ戦域)が解放された</span>';
        } catch {
          /* localStorage 不可なら解放なし */
        }
      }
      const acc = this.shots > 0 ? ((this.hits / this.shots) * 100).toFixed(1) : '0.0';
      this.hud.showEnd(
        true,
        `全 ${this.enemies.length} 機撃破<br>` +
        `ミッション時間 T+ ${Math.floor(this.simTime / 3600)}h ${Math.floor((this.simTime % 3600) / 60)}m ${Math.floor(this.simTime % 60)}s<br>` +
        `発射 ${this.shots} 発 / 命中 ${this.hits} 発 (命中率 ${acc}%)` +
        unlockNote,
      );
    }
  }

  // 撃破デブリ: 非対称な慣性テンソル + 中間軸まわり回転 → ジャニベコフ効果
  private spawnDebris(ship: Ship, sc = 1): void {
    const accent = ship === this.player ? 0x9fd8e8 : 0xff6a4a;
    this.spawnFragments(ship.state.r, ship.state.v, 11, accent, 0.5 * sc, 1.6 * sc, 2.8);
  }

  // 破片を飛散させる共通処理(撃破デブリ・被弾の欠片)
  private spawnFragments(
    origin: Vec3,
    baseVel: Vec3,
    count: number,
    accent: number,
    sizeMin: number,
    sizeMax: number,
    spread: number,
  ): void {
    for (let i = 0; i < count; i++) {
      const size = sizeMin + Math.random() * (sizeMax - sizeMin);
      const piece: DebrisPiece = {
        state: {
          r: add(origin, randVec(2.5)),
          v: add(baseVel, randVec(spread)),
        },
        att: {
          q: randomQuat(),
          w: v3(randSym(0.25), (1.4 + Math.random() * 1.2) * (Math.random() < 0.5 ? -1 : 1), randSym(0.25)),
          inertia: v3(1, 2.05, 3.0), // 中間軸 = y: ここに主回転を与えると周期的に反転する
        },
        obj: buildDebrisMesh(accent, size),
      };
      this.debris.push(piece);
      this.scene.add(piece.obj);
    }
    while (this.debris.length > C.MAX_DEBRIS) {
      const old = this.debris.shift()!;
      this.removeDebrisObj(old);
    }
  }

  // d.obj は単一 Mesh(通常の破片)の場合と、複数子メッシュを持つ Group
  // (排出された空マガジンのフレーム等)の場合がある。traverse して
  // 見つかった Mesh すべてのジオメトリ・マテリアルを破棄する。
  private removeDebrisObj(d: DebrisPiece): void {
    this.scene.remove(d.obj);
    d.obj.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry.dispose();
      if (Array.isArray(mesh.material)) mesh.material.forEach((m) => m.dispose());
      else mesh.material.dispose();
    });
  }

  private spawnFlash(
    pos: Vec3,
    vel: Vec3,
    size0: number,
    size1: number,
    duration: number,
    color: number,
    peakOpacity = 1,
  ): void {
    const mesh = buildFlashMesh(this.glowTex, color);
    const fx: FlashEffect = { mesh, pos, vel, age: 0, duration, size0, size1, peakOpacity };
    this.effects.push(fx);
    this.scene.add(mesh);
  }

  // ------------------------------------------------------------- cleanup

  private altitudeOf(r: Vec3): number {
    return len(r) - R_EARTH;
  }

  private cleanup(): void {
    // 自機の構造限界高度(通常は加熱・動圧で先に喪失する)
    if (this.player.alive && this.altitudeOf(this.player.state.r) < C.PLAYER_MIN_ALT) {
      this.lostReason = '濃密な大気に突入し機体は分解した';
      this.destroyShip(this.player);
    }
    for (const e of this.enemies) {
      if (e.alive && this.altitudeOf(e.state.r) < C.REENTRY_ALT) {
        this.destroyShip(e);
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

    this.casings = this.casings.filter((cs) => {
      const expired =
        this.simTime - cs.bornSim > C.CASING_LIFETIME ||
        this.altitudeOf(cs.state.r) < C.DEBRIS_REENTRY_ALT;
      if (expired) this.scene.remove(cs.obj);
      return !expired;
    });

    this.debris = this.debris.filter((d) => {
      const expired = this.altitudeOf(d.state.r) < C.DEBRIS_REENTRY_ALT;
      if (expired) this.removeDebrisObj(d);
      return !expired;
    });

    this.magPickups = this.magPickups.filter((mp) => {
      const expired = !mp.alive || this.altitudeOf(mp.state.r) < C.DEBRIS_REENTRY_ALT;
      if (expired) this.scene.remove(mp.obj);
      return !expired;
    });
  }

  // --------------------------------------------------------- render sync

  private syncRender(dt: number): void {
    const o = this.player.state.r; // フローティングオリジン
    const pv = this.player.state.v;

    // 地球・恒星・太陽(実寸で描画。フローティングオリジン設計により
    // カメラは常にワールド原点にあるため、地球側の平行移動量(|o| 〜 R_EARTH+高度)
    // は近地点侵入時でも 1e7 未満で、near=2m の深度バッファでも十分な精度が出る
    // (詳細は CLAUDE.md「フローティングオリジンの精度設計」参照)。
    this.earth.group.position.set(-o.x, -o.y, -o.z);
    this.earth.setRotation(this.earthPhase0 + (2 * Math.PI * this.simTime) / SIDEREAL_DAY);
    this.earth.tick(dt);

    // カメラ: 戦闘 = 自機中心チェイス / 計画 = 地球中心軌道ビュー
    const mouse = this.input.consumeMouse();
    // 矢印キーでも視点回転できるようにする(マウスドラッグと同じ換算式に合わせる)
    const keyYaw = (this.input.down('ArrowLeft') ? 1 : 0) + (this.input.down('ArrowRight') ? -1 : 0);
    const keyPitch = (this.input.down('ArrowDown') ? 1 : 0) + (this.input.down('ArrowUp') ? -1 : 0);
    if (this.mapMode) {
      // 戦闘ビューは yaw -= dx*0.005 なので、符号を反転させて左右の回転方向を揃える
      this.mapYaw += mouse.dx * 0.005 - keyYaw * C.CAM_KEY_YAW_RATE * dt;
      this.mapPitch = Math.max(
        -1.4,
        Math.min(1.4, this.mapPitch + mouse.dy * 0.005 + keyPitch * C.CAM_KEY_PITCH_RATE * dt),
      );
      this.mapDist = Math.max(C.MAP_MIN_DIST, Math.min(C.MAP_MAX_DIST, this.mapDist * Math.exp(mouse.wheel * 0.0012)));
      if (mouse.panDx !== 0 || mouse.panDy !== 0) {
        // Convert pixels to map-world metres at the current target plane.
        // The camera basis makes the gesture independent of orbit yaw/pitch.
        this.mapCamera.updateMatrixWorld();
        const right = new THREE.Vector3().setFromMatrixColumn(this.mapCamera.matrixWorld, 0).normalize();
        const up = new THREE.Vector3().setFromMatrixColumn(this.mapCamera.matrixWorld, 1).normalize();
        const metersPerPixel =
          (2 * this.mapDist * Math.tan(THREE.MathUtils.degToRad(this.mapCamera.fov * 0.5))) /
          Math.max(1, window.innerHeight);
        this.mapPan.addScaledVector(right, -mouse.panDx * metersPerPixel);
        this.mapPan.addScaledVector(up, mouse.panDy * metersPerPixel);
      }
      const cp = Math.cos(this.mapPitch);
      // 太陽回転系表示: 太陽の実際の方位ドリフトぶんカメラ方位を追従させ、
      // 画面上で太陽方向がほぼ固定されて見えるようにする(予測サンプルの回転補正と
      // 組み合わせて、t=simTime では回転量ゼロで整合する)。
      const displayYaw = this.mapYaw + (this.mapFrameRotating ? sunAzimuth(this.simTime, this.sunPhase0) : 0);
      // 地球中心はフローティングオリジンで -o
      let focusRel = v3(-o.x, -o.y, -o.z);
      if (this.mapFocus !== 'earth') {
        const lbl = this.mapLabels.find(l => l.id === this.mapFocus);
        if (lbl) {
          focusRel = sub(lbl.pos, o);
        }
      }
      const targetX = focusRel.x + this.mapPan.x;
      const targetY = focusRel.y + this.mapPan.y;
      const targetZ = focusRel.z + this.mapPan.z;
      this.mapCamera.position.set(
        targetX + cp * Math.cos(displayYaw) * this.mapDist,
        targetY + Math.sin(this.mapPitch) * this.mapDist,
        targetZ + cp * Math.sin(displayYaw) * this.mapDist,
      );
      this.mapCamera.up.set(0, 1, 0);
      this.mapCamera.lookAt(targetX, targetY, targetZ);
      const aspect = window.innerWidth / window.innerHeight;
      if (Math.abs(this.mapCamera.aspect - aspect) > 1e-6) {
        this.mapCamera.aspect = aspect;
        this.mapCamera.updateProjectionMatrix();
      }
      this.mapCamera.updateMatrixWorld();
    } else {
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
    const cam = this.activeCamera;

    // 太陽・月・星: カメラ位置基準で天体暦の方向に表示(マップの遠距離ズームでも
    // 背景として振る舞う。距離は視距離に圧縮、月の角直径は実距離から換算)
    const sd = this.sunDirV;
    this.starsMesh.position.copy(cam.position);
    if (this.mapMode) {
      // マップモードではカメラが遠く引かれるため、星が地球の手前にならないようにカメラの far の内側に押し込む
      this.starsMesh.scale.setScalar((this.mapCamera.far * 0.9) / 3.5e7);
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
    const moonRel = sub(this.moonPos, o); // フローティングオリジン座標(= true ECI - o)
    if (this.mapMode) {
      // マップモードは地球中心を実寸スケールで俯瞰するビューなので、月も
      // 圧縮せず実際の位置・実寸(R_MOON)で描く(シスルナ軌道の計画に、
      // 月との実際の位置関係が分かる必要があるため)。
      this.moonMesh.position.set(moonRel.x, moonRel.y, moonRel.z);
      this.moonMesh.scale.setScalar(R_MOON);
    } else {
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

    // 地球の影: 戦闘ビューでは自機周辺が影円柱内にあれば太陽光・環境光を減光する
    // マップモードでは全体像を見るため地球の昼側が常に明るくなるよう減光しない
    const lit = this.mapMode ? 1.0 : this.shadowLitFactor(o);
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
      this.shiftBeltNodes();
      this.beltFeed = targetFeed; // マガジン消費で巻き戻り(リンク減と同時なので連続)
    } else {
      this.beltFeed += (targetFeed - this.beltFeed) * Math.min(1, dt * 12);
    }
    this.updateBeltPhysics(dt, beltCount);
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
    this.updateMapGizmo(o);

    // 計画軌道(白、解析的な楕円): マップモード中は数値予測のポリライン(trajLine)が
    // 代わりを務めるので非表示にし、戦闘ビューでは直近ノードの噴射後サンプルから
    // 求めた軌道要素を表示する。
    let plannedEl: Elements | null = null;
    if (!this.mapMode && this.planNodes.length > 0) {
      const s = sampleAt(this.trajSamples, this.planNodes[0]!.time);
      if (s) plannedEl = elementsFromState(s.r, s.v);
    }
    this.plannedOrbitLine.update(this.mapMode ? null : plannedEl, o);

    if (this.mapMode) {
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
    } else {
      this.geoOrbitLine.update(null, o);
      this.moonOrbitLine.update(null, o);
    }

    this.updateMarkers(o, pv, tgt);
    this.updateNodeMarkers(playerEl, tgtEl, o);
    this.updateBoardMarkers(o, dt, tgt);
    if (!this.mapMode) this.updateNodeGuide(o, pv, playerEl);
    else this.hud.hideMarker('burn');
    this.updateNavball(o, pv, tgt);
    this.updateHudPanels(dt, playerEl, tgt, tgtEl);
    this.hud.tick();
  }

  // 自機位置の地表影(円柱近似 + 縁のぼかし)による日照率 0..1
  private shadowLitFactor(r: Vec3): number {
    const along = dot(r, this.sunDirV);
    if (along >= 0) return 1; // 太陽側
    const perp = len(addScaled(r, this.sunDirV, -along));
    return Math.min(1, Math.max(0, (perp - R_EARTH) / C.SHADOW_PENUMBRA));
  }

  // ターゲット標的面を通過した自弾の位置を、的に貼り付いた光点として表示する
  private updateBoardMarkers(o: Vec3, dt: number, tgt: Ship | null): void {
    if (!tgt) this.boardMarks.length = 0;
    this.boardMarks = this.boardMarks.filter((m) => {
      m.age += dt;
      return m.age < C.BOARD_MARK_LIFETIME;
    });
    for (let i = 0; i < C.MAX_BOARD_MARKS; i++) {
      const key = `bh${i}`;
      const m = this.boardMarks[i];
      if (!m || !tgt) {
        this.hud.hideMarker(key);
        continue;
      }
      const p = this.project(sub(add(tgt.state.r, m.off), o));
      const fade = 1 - m.age / C.BOARD_MARK_LIFETIME;
      this.hud.marker(key, 'mk-boardhit', '✦', p.x, p.y, p.front, '', 0.25 + 0.75 * fade);
    }
  }

  // Navball: 機体姿勢と各基準方向(ワールド)を渡して姿勢儀を描画する
  private updateNavball(o: Vec3, pv: Vec3, tgt: Ship | null): void {
    if (!this.player.alive || this.mapMode) {
      this.navball.setVisible(false);
      return;
    }
    this.navball.setVisible(true);
    const pro = norm(pv);
    const h = norm(cross(o, pv));
    this.navball.update(this.player.att.q, {
      earthDown: scale(norm(o), -1),
      prograde: pro,
      normal: h,
      radialOut: cross(pro, h),
      target: tgt ? norm(sub(tgt.state.r, o)) : null,
    });
  }

  private shiftBeltNodes(): void {
    const n = this.beltLinks.length;
    if (n < 2) return;

    // ノードを 1 つ前詰め (i=0 は消費済みマガジン、破棄)
    for (let i = 0; i < n - 1; i++) {
      this.beltPos[i]!.copy(this.beltPos[i + 1]!);
      this.beltPrevPos[i]!.copy(this.beltPrevPos[i + 1]!);
      this.beltTwist[i] = this.beltTwist[i + 1]!;
    }

    // 末尾に新ノードを追加(前の末尾から +X 方向へ PITCH 分延長)
    // このノードは直後に beltCount が 1 減って非表示になるので、
    // 位置精度はどうでもよい(次フレームで距離拘束に収束する)。
    const last = this.beltPos[n - 2]!;
    const lastPrev = this.beltPrevPos[n - 2]!;

    // 前のノードの速度ベクトルを引き継いで自然に延長
    beltTmpA.copy(last).sub(lastPrev);
    this.beltPos[n - 1]!.copy(last).add(beltTmpA).addScaledVector(X_AXIS, MAG_BELT_PITCH);
    this.beltPrevPos[n - 1]!.copy(this.beltPos[n - 1]!); // 新末尾は追加直後は速度ゼロ
    this.beltTwist[n - 1] = this.beltTwist[n - 2]!;
  }

  // マガジンベルトのたわみを物理演算(Verlet 積分 + 距離拘束)で解く。
  // 軌道上は自由落下(無重力)なので、通常の重力によるたわみは発生しない。
  // 代わりに、機体自身の推力加速度(並進)とスピン(角速度・角加速度)が
  // 生む慣性力(擬似力)——並進慣性 -a、遠心力 -ω×(ω×r)、オイラー力 -α×r、
  // コリオリ力 -2ω×v——だけがベルトを機体座標系の中で揺らす。
  // ベルトは「接合部で連結されているが曲げられる」チェーンとして、各リンクの
  // 節点を距離拘束(剛体棒)でつなぐ position-based dynamics で表現する。
  private updateBeltPhysics(dt: number, beltCount: number): void {
    const n = this.beltLinks.length;
    if (!this.beltInit) {
      this.beltInit = true;
      for (let i = 0; i < n; i++) {
        const p = new THREE.Vector3(0.9 + (i + 1) * MAG_BELT_PITCH, 0, 0);
        this.beltPos.push(p.clone());
        this.beltPrevPos.push(p.clone());
        this.beltTwist.push(0);
      }
    }

    // 機体の角加速度を前フレームとの差分から推定(body-frame ω の差分)
    const w = this.player.att.w;
    const invDt = dt > 1e-6 ? 1 / dt : 0;
    beltAlpha.set((w.x - this.prevBodyW.x) * invDt, (w.y - this.prevBodyW.y) * invDt, (w.z - this.prevBodyW.z) * invDt);
    this.prevBodyW = v3(w.x, w.y, w.z);

    // 推力加速度をワールド→機体座標系へ変換(擬似力は加速度と逆向き)
    beltQInv.set(this.player.att.q.x, this.player.att.q.y, this.player.att.q.z, this.player.att.q.w).invert();
    const aThrustWorld = this.thrustAccelVec;
    beltAThrustBody.set(aThrustWorld.x, aThrustWorld.y, aThrustWorld.z).applyQuaternion(beltQInv);

    const h = Math.min(dt, 0.05); // 積分刻みの上限(大きな dt でのはみ出し防止)
    const damping = 0.95; // 慣性を維持するため減衰を弱める
    // コリオリ力 -2ω×v の係数: beltVel = pos-prevPos = v*dt なので速度への変換に 2/dt を使う。
    // invH2(=2/h) ではなく実際の dt を使わないと dt > 0.05 のときコリオリ力が過大になる。
    const inv2Dt = invDt * 2;
    beltW.set(w.x, w.y, w.z);

    for (let i = 0; i < n; i++) {
      const pos = this.beltPos[i]!;
      const prev = this.beltPrevPos[i]!;
      beltVel.copy(pos).sub(prev); // 前フレームの変位(Verlet の速度相当)

      // 擬似力による加速度: -a_thrust - α×r - ω×(ω×r) - 2ω×v
      beltAccel.set(-beltAThrustBody.x, -beltAThrustBody.y, -beltAThrustBody.z);
      beltAccel.sub(beltTmpA.crossVectors(beltAlpha, pos));
      beltAccel.sub(beltTmpA.crossVectors(beltW, beltTmpB.crossVectors(beltW, pos)));
      beltAccel.sub(beltTmpA.crossVectors(beltW, beltVel).multiplyScalar(inv2Dt));

      beltNext.copy(pos).addScaledVector(beltVel, damping).addScaledVector(beltAccel, h * h);
      prev.copy(pos);
      pos.copy(beltNext);
    }

    // 距離拘束(剛体棒): 先頭はベルトの給弾進みに応じて動くアンカーに固定。
    // 数回反復して各リンク間隔を MAG_BELT_PITCH に収束させる。
    beltAnchor.set(0.9 - this.beltFeed * MAG_BELT_PITCH, 0, 0);

    // 根本(リンク0)は常に機体に対して垂直(ローカル+X方向)になるよう、
    // 揺動物理を経由させずアンカーから固定距離・固定方向の位置に毎フレーム
    // 強制する(速度もゼロにして慣性ドリフトを止める)。これにより根本の
    // 接合部は常に垂直のまま、リンク1以降だけが自由に揺れる。
    beltRootPos.copy(beltAnchor).addScaledVector(X_AXIS, MAG_BELT_PITCH);
    this.beltPos[0]!.copy(beltRootPos);
    this.beltPrevPos[0]!.copy(beltRootPos);

    for (let iter = 0; iter < 6; iter++) {
      for (let i = 0; i < n; i++) {
        const a = i === 0 ? beltAnchor : this.beltPos[i - 1]!;
        const b = this.beltPos[i]!;
        beltDelta.copy(b).sub(a);
        const dist = beltDelta.length();
        if (dist < 1e-6) continue;
        const corr = beltDelta.multiplyScalar((dist - MAG_BELT_PITCH) / dist);
        if (i <= 1) {
          // i===0: 参照点はアンカー(固定)。i===1: 参照点は根本(beltPos[0]、
          // 常に垂直固定)。どちらも a 側は動かさず b 側だけ補正する。
          b.sub(corr);
        } else {
          b.addScaledVector(corr, -0.5);
          a.addScaledVector(corr, 0.5);
        }
      }
      // かすかな直線復元力(曲げ剛性の簡易近似): 距離拘束をある程度収束させた
      // 中間で1回だけ、各リンクの継ぎ目をまっすぐ揃える方向へわずかに引き寄せる。
      // 直後に残りの距離拘束反復で生じた長さのずれを収束させ直す。

    }

    // 表示: 各リンクをその節点の手前(アンカー or 前リンクの節点)に置き、
    // 節点への方向へ向ける(ローカル +X = ベルト方向)。
    // 向きは「平行移動(parallel transport)」で求める: 前リンクの姿勢を基準に、
    // その進行方向(ローカル+X)を新しい節点方向へ向ける最小回転だけを加える。
    // 各つなぎ目で許容するピッチ/ヨーの角度上限を tan クランプで適用し、
    // クランプ後の方向を beltPos へ書き戻して物理とビジュアルを一致させる。
    // そこへ、機体のロールに由来する有限のねじれ角(this.beltTwist)を
    // 追加で載せることで、ロールにも独立した上限を課す。
    const maxRoll = (C.MAG_CHAIN_MAX_ROLL_DEG * Math.PI) / 180;
    // tan(最大角度) = ローカル座標系での横ずれ/前進量の上限
    const tanMaxPitch = Math.tan((C.MAG_CHAIN_MAX_PITCH_DEG * Math.PI) / 180);
    const tanMaxYaw = Math.tan((C.MAG_CHAIN_MAX_YAW_DEG * Math.PI) / 180);
    const rollLerp = Math.min(1, dt * C.MAG_CHAIN_ROLL_RATE);
    let prevPoint: THREE.Vector3 = beltAnchor;
    beltQPrev.identity(); // アンカー(機体)側の基準姿勢: ベルトは+X方向へ伸びる
    let prevTwist = this.player.att.w.z * C.MAG_CHAIN_ROLL_GAIN; // ねじれの発生源: 機体のロール角速度
    for (let i = 0; i < n; i++) {
      const link = this.beltLinks[i]!;
      link.visible = this.player.alive && i < beltCount;
      const pos = this.beltPos[i]!;
      link.position.copy(prevPoint);

      beltDir.copy(pos).sub(prevPoint);
      const segLen = beltDir.length(); // このリンクの実長(距離拘束で ≒ MAG_BELT_PITCH)
      if (segLen > 1e-6) {
        beltDir.multiplyScalar(1 / segLen); // 正規化

        // ---- ピッチ / ヨー クランプ ----
        // 前リンクのローカル座標系(+X = 進行方向)に変換し、
        // Y 成分(ヨー方向の横ずれ)と Z 成分(ピッチ方向の上下ずれ)を
        // それぞれ tan(上限角度) でクランプする。
        // 「X 成分 = 1 固定でロジカルに考えると tan θ = 横ずれ/前進量」
        // となるので、正規化ベクトルをローカル系に変換後 X を 1 として
        // Y/X と Z/X をクランプし、再正規化してワールドへ戻す。
        beltQInvPrev.copy(beltQPrev).invert();
        beltDirLocal.copy(beltDir).applyQuaternion(beltQInvPrev);
        // beltDirLocal.x は cos(折れ角) ≈ 1(小角度近似で正のはず)。
        // ゼロ割を避けるため最低 0.001 に制限。
        const lx = Math.max(beltDirLocal.x, 0.001);
        beltDirLocal.y = Math.max(-tanMaxYaw * lx, Math.min(tanMaxYaw * lx, beltDirLocal.y));
        beltDirLocal.z = Math.max(-tanMaxPitch * lx, Math.min(tanMaxPitch * lx, beltDirLocal.z));
        beltDirLocal.normalize();
        // クランプ後の方向をワールドへ戻す
        beltDir.copy(beltDirLocal).applyQuaternion(beltQPrev);
        // beltPos[i] を「前点 + クランプ済み方向 × 元の長さ」に更新して
        // 物理とビジュアルを一致させる(次フレームの Verlet 積分に反映)。
        // 【重要】beltPrevPos[i] も同量だけ平行移動して Verlet の速度 (pos - prevPos) を保つ。
        // 移動前の pos を beltNext に退避(物理ループ終了後なので安全に再利用できる)。
        beltNext.copy(pos);                                       // 移動前の pos を退避
        pos.copy(prevPoint).addScaledVector(beltDir, segLen);     // クランプ後の pos
        this.beltPrevPos[i]!.add(pos).sub(beltNext);             // prevPos += (pos_new - pos_old)

        beltTmpVX.copy(X_AXIS).applyQuaternion(beltQPrev); // 前リンクの進行方向(ワールド)
        beltQDelta.setFromUnitVectors(beltTmpVX, beltDir);  // 曲げぶんの最小回転
        beltQBend.copy(beltQDelta).multiply(beltQPrev);
      } else {
        beltQBend.copy(beltQPrev);
      }

      if (i === 0) {
        // 根本はロール方向も含めて完全固定(ねじれ0)。伝播用シード(prevTwist)
        // は機体のロール角速度由来のまま変えず、ねじれはリンク1から始める。
        this.beltTwist[0] = 0;
      } else {
        // ねじれ角を目標へ追従させつつ ±maxRoll にクランプ(常に上限内)
        const target = Math.max(-maxRoll, Math.min(maxRoll, prevTwist));
        const twist = this.beltTwist[i]! + (target - this.beltTwist[i]!) * rollLerp;
        this.beltTwist[i] = Math.max(-maxRoll, Math.min(maxRoll, twist));
        prevTwist = this.beltTwist[i]!; // 次のリンクへ位相遅れつつ伝播
      }

      beltQTwist.setFromAxisAngle(X_AXIS, this.beltTwist[i]!);
      link.quaternion.copy(beltQBend).multiply(beltQTwist);

      beltQPrev.copy(beltQBend);
      prevPoint = pos;
    }
  }

  // RCS 姿勢制御の噴射パフと音。4 基のスラスタブロック(配置は ships.ts の
  // RCS_BLOCK_OFFSETS と一致させる)
  // それぞれについて、要求トルク τ に寄与する接線力 F = τ × r を求め、
  // その反対方向(排気側)に小さな発光パフを出す。
  private updateRcsEffects(): void {
    const i = this.input;
    const rotating =
      this.player.alive &&
      this.phase === 'playing' &&
      !this.paused &&
      !this.mapMode &&
      (i.down('KeyI') || i.down('KeyK') || i.down('KeyJ') || i.down('KeyL') || i.down('KeyU') || i.down('KeyO'));
    this.sfx.setRcs(rotating);
    if (!rotating || this.zoomActive) {
      for (const p of this.rcsPuffs) p.visible = false;
      return;
    }

    // updatePlayerAttitude の inX/inY/inZ(実際のトルク方向)と符号を一致させる
    const tau = v3(
      (i.down('KeyI') ? 1 : 0) + (i.down('KeyK') ? -1 : 0), // ピッチ
      (i.down('KeyL') ? 1 : 0) + (i.down('KeyJ') ? -1 : 0), // ヨー
      (i.down('KeyO') ? 1 : 0) + (i.down('KeyU') ? -1 : 0), // ロール
    );
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
    if (this.trajGeomDirty) {
      this.rebuildTrajLineGeom();
      this.trajGeomDirty = false;
    }

    if (this.mapSliderT > 0 && this.trajSamples.length > 0) {
      const duration = this.predictDurationSec();
      const t = this.simTime + this.mapSliderT * duration;
      const s = sampleAt(this.trajSamples, t);
      if (s) {
        const p = this.project(sub(this.toDisplayFrame(s.r, t), o));
        this.hud.marker('ghost', 'mk-ghost', '⬡', p.x, p.y, p.front, this.ghostLabel());
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
    const nodeTimes = this.planNodes.map((n) => n.time);
    const segments: Vec3[][] = [];
    let seg: Vec3[] = [];
    let nodeIdx = 0;
    for (const s of this.trajSamples) {
      seg.push(this.toDisplayFrame(s.r, s.t));
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

  private updateMarkers(o: Vec3, pv: Vec3, tgt: Ship | null): void {
    // 方向マーカーは戦闘ビューのみ(マップでは意味を持たない)
    if (this.mapMode) {
      this.hud.hideMarker('pro');
      this.hud.hideMarker('retro');
      this.hud.hideMarker('bore');
      this.hud.hideMarker('lead');
      // 自機位置マーカー
      const sp = this.project(v3());
      this.hud.marker('self', 'mk-self', '▷', sp.x, sp.y, sp.front, 'PLAYER');
    } else {
      this.hud.hideMarker('self');
      for (const lbl of this.mapLabels) {
        this.hud.hideMarker(lbl.id);
      }
    }

    if (!this.mapMode) {
      // プログレード / レトログレード
      const proDir = norm(pv);
      const pro = this.project(scale(proDir, 5e4));
      this.hud.marker('pro', 'mk-pro', '⊙', pro.x, pro.y, pro.front, 'PRO');
      const ret = this.project(scale(proDir, -5e4));
      this.hud.marker('retro', 'mk-retro', '⊗', ret.x, ret.y, ret.front, 'RET');
    }

    // 機首方向(ボアサイト)
    if (this.player.alive && !this.mapMode) {
      const fwd = qRotate(this.player.att.q, v3(0, 0, 1));
      const bs = this.project(scale(fwd, 5e4));
      this.hud.marker('bore', 'mk-boresight', '┼', bs.x, bs.y, bs.front);
    } else {
      this.hud.hideMarker('bore');
    }

    // 敵マーカー
    for (let i = 0; i < this.enemies.length; i++) {
      const e = this.enemies[i]!;
      const key = `e${i}`;
      if (!e.alive) {
        this.hud.hideMarker(key);
        continue;
      }
      const rel = sub(e.state.r, o);
      const p = this.project(rel);
      const dist = len(rel);
      const isTgt = e === tgt;
      this.hud.marker(key, isTgt ? 'mk-target' : 'mk-enemy', '◇', p.x, p.y, p.front, `${e.name} ${fmtMarkerDist(dist)}`);
    }

    // 補給マガジンのマーカー
    for (let i = 0; i < C.MAX_MAG_PICKUPS; i++) {
      const key = `mg${i}`;
      const mp = this.magPickups[i];
      if (!mp || !mp.alive) {
        this.hud.hideMarker(key);
        continue;
      }
      const rel = sub(mp.state.r, o);
      const p = this.project(rel);
      const dist = len(rel);
      this.hud.marker(key, 'mk-ammo', '▣', p.x, p.y, p.front, `AMMO ${fmtMarkerDist(dist)}`);
    }

    // リード(見越し)マーカー: 相対等速近似で弾丸到達時刻を解く
    let leadShown = false;
    if (tgt && this.player.alive && !this.mapMode) {
      const relP = sub(tgt.state.r, o);
      const relV = sub(tgt.state.v, pv);
      const t = this.solveLeadTime(relP, relV, C.MUZZLE_SPEED);
      if (t !== null && t < 25) {
        const lead = addScaled(relP, relV, t);
        const p = this.project(lead);
        this.hud.marker('lead', 'mk-lead', '✛', p.x, p.y, p.front, 'LEAD');
        leadShown = true;
      }
    }
    if (!leadShown) this.hud.hideMarker('lead');
  }

  // ターゲットの軌道面との交線(相対昇交点・降交点)を自機の軌道上に表示する。
  // 面変更(ノーマル/アンチノーマル)burn を行うべき位置がひと目で分かる。
  private updateNodeMarkers(playerEl: Elements | null, tgtEl: Elements | null, o: Vec3): void {
    if (!playerEl || !tgtEl) {
      this.hud.hideMarker('an');
      this.hud.hideMarker('dn');
      return;
    }
    const lineDir = cross(playerEl.hHat, tgtEl.hHat);
    if (lenSq(lineDir) < 1e-6) {
      // 軌道面がほぼ一致 → 交線が定まらない
      this.hud.hideMarker('an');
      this.hud.hideMarker('dn');
      return;
    }

    const d = norm(lineDir);
    const thAsc = Math.atan2(dot(d, playerEl.qHat), dot(d, playerEl.pHat));
    const rAsc = playerEl.p / (1 + playerEl.e * Math.cos(thAsc));
    const rDesc = playerEl.p / (1 + playerEl.e * Math.cos(thAsc + Math.PI));

    const ascP = this.project(sub(scale(d, rAsc), o));
    const descP = this.project(sub(scale(d, -rDesc), o));
    this.hud.marker('an', 'mk-node', '▲', ascP.x, ascP.y, ascP.front, 'AN');
    this.hud.marker('dn', 'mk-node', '▽', descP.x, descP.y, descP.front, 'DN');
  }

  // |relP + relV t| = s t を満たす最小の正の t
  private solveLeadTime(relP: Vec3, relV: Vec3, s: number): number | null {
    const a = lenSq(relV) - s * s;
    const b = 2 * dot(relP, relV);
    const c = lenSq(relP);
    if (Math.abs(a) < 1e-6) {
      if (Math.abs(b) < 1e-9) return null;
      const t = -c / b;
      return t > 0 ? t : null;
    }
    const disc = b * b - 4 * a * c;
    if (disc < 0) return null;
    const sq = Math.sqrt(disc);
    const t1 = (-b - sq) / (2 * a);
    const t2 = (-b + sq) / (2 * a);
    let best: number | null = null;
    for (const t of [t1, t2]) {
      if (t > 0 && (best === null || t < best)) best = t;
    }
    return best;
  }

  private updateHudPanels(
    dt: number,
    playerEl: ReturnType<typeof elementsFromState>,
    tgt: Ship | null,
    tgtEl: ReturnType<typeof elementsFromState>,
  ): void {
    this.hudTimer -= dt;
    if (this.hudTimer <= 0) {
      this.hudTimer = 0.1;
      // タッチUIのトグルボタン(制動・微動・ホールド)の点灯状態を実際のモードに同期する。
      // progradeHold は手動回転で自動解除されることもあるため、専用のトグル時だけでなく
      // ここで毎回反映しておく。
      this.touchControls?.setActive('KeyT', this.rcsDamp);
      this.touchControls?.setActive('KeyV', this.fineAttitude);
      this.touchControls?.setActive('KeyC', this.progradeHold);
      this.hud.setStats({
        met: this.simTime,
        warpLabel: `×${this.warp()}`,
        paused: this.paused,
        rcsDamp: this.rcsDamp,
        throttleIdx: this.throttleIdx,
        fineAttitude: this.fineAttitude,
        progradeHold: this.progradeHold,
        camFollowAttitude: this.camFollowAttitude,
        roundsInMag: this.roundsInMag,
        magsLeft: this.magsLeft,
        alt: this.altitudeOf(this.player.state.r),
        spd: len(this.player.state.v),
        apAlt: playerEl ? playerEl.apAlt : NaN,
        peAlt: playerEl ? playerEl.peAlt : NaN,
        incDeg: playerEl ? playerEl.incDeg : NaN,
        period: playerEl ? playerEl.period : NaN,
        qdyn: this.qdyn,
        hullTemp: this.hullTemp,
        shots: this.shots,
        kills: this.kills,
        total: this.enemies.length,
        stage0TimeLeft: this.stage === 0 ? this.stage0TimeLeft : null,
      });

      if (tgt) {
        const relP = sub(tgt.state.r, this.player.state.r);
        const relV = sub(tgt.state.v, this.player.state.v);
        const dist = len(relP);
        const relIncDeg =
          playerEl && tgtEl
            ? (Math.acos(Math.max(-1, Math.min(1, dot(playerEl.hHat, tgtEl.hHat)))) * 180) / Math.PI
            : NaN;
        this.hud.setTarget({
          name: tgt.name,
          dist,
          closing: dist > 1e-6 ? -dot(relP, relV) / dist : 0,
          relSpeed: len(relV),
          hp: tgt.hp,
          maxHp: tgt.maxHp,
          apAlt: tgtEl ? tgtEl.apAlt : NaN,
          peAlt: tgtEl ? tgtEl.peAlt : NaN,
          incDeg: tgtEl ? tgtEl.incDeg : NaN,
          period: tgtEl ? tgtEl.period : NaN,
          relIncDeg,
        });
      } else {
        this.hud.setTarget(null);
      }
    }

    this.listTimer -= dt;
    if (this.listTimer <= 0) {
      this.listTimer = 0.25;
      const rows = this.enemies
        .filter((e) => e.alive)
        .map((e) => ({
          name: e.name,
          dist: len(sub(e.state.r, this.player.state.r)),
          targeted: e === tgt,
        }))
        .sort((a, b) => a.dist - b.dist);
      this.hud.setEnemyList(rows);
    }
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
      for (let i = 0; i < this.beltPos.length; i++) {
        const bp = this.beltPos[i]!;
        const bpPrev = this.beltPrevPos[i]!;
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
          this.clankCd = 0.07;
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
          this.beltPos[e.beltIdx]!.set(bpLocal.x, bpLocal.y, bpLocal.z);
          // bvLocal を加算して prevPos を逆算: pos - vel*dt
          this.beltPrevPos[e.beltIdx]!.set(
            bpLocal.x - bvLocal.x * dt,
            bpLocal.y - bvLocal.y * dt,
            bpLocal.z - bvLocal.z * dt
          );
        }
      }
    }
  }
}
