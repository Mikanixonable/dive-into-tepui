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
  positionOnOrbit,
  stateFromElements,
  stepOrbitRK4,
  thirdBodyAccel,
  tofBetween,
  trueAnomalyAt,
  velocityOnOrbit,
} from '../physics/orbital';
import {
  MU_MOON,
  MU_SUN,
  R_MOON,
  moonPosition,
  sunPosition,
} from '../physics/ephemeris';
import {
  Attitude,
  qIdentity,
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
  neg,
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
  buildMagazineMesh,
  buildMagPickup,
  buildPlayerShip,
} from '../render/ships';
import { OrbitLine } from '../render/orbitline';


type GamePhase = 'playing' | 'won' | 'lost';

interface EnemySpec {
  name: string;
  state: OrbitState;
  hp: number;
  accent: number;
}

// 確定済みマニューバノード(計画時の軌道で凍結)
interface ManeuverNode {
  nodeTime: number; // 実行予定時刻 [simTime]
  rNode: Vec3; // ノード点の ECI 位置
  vPlanned: Vec3; // 噴射完了後の目標速度(ワールド)
  targetEl: Elements; // 計画軌道の要素
  dvTotal: number; // 計画 Δv [m/s]
}

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

const EARTH_OMEGA = (2 * Math.PI) / SIDEREAL_DAY; // 地球自転角速度 [rad/s](Y軸=北極まわり)

// 大気抵抗の加速度関数。大気は地球と共回転するとし、対気速度で
// a = -½ρ|v_rel|·(Cd·A/m)·v_rel を返す。bcInv = Cd·A/m [m²/kg]。
function makeDragAccel(bcInv: number): ExtraAccel {
  return (r: Vec3, v: Vec3): Vec3 => {
    const rho = atmosphericDensity(len(r) - R_EARTH);
    if (rho < 1e-15) return v3();
    // v_atm = ω × r, ω = (0, ω, 0)
    const vr = v3(v.x - EARTH_OMEGA * r.z, v.y, v.z + EARTH_OMEGA * r.x);
    return scale(vr, -0.5 * rho * len(vr) * bcInv);
  };
}

// fwd に直交するランダム単位ベクトル(散布界用)
function randPerp(fwd: Vec3): Vec3 {
  for (;;) {
    const r = randVec(1);
    const p = sub(r, scale(fwd, dot(r, fwd)));
    if (lenSq(p) > 1e-6) return norm(p);
  }
}

export class Game {
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;

  private readonly input: Input;
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

  // 軌道計画モード
  readonly stage: number;
  private mapMode = false;
  private mapYaw = 0.7;
  private mapPitch = 0.45;
  private mapDist = 4.5e7;
  private readonly mapCamera: THREE.PerspectiveCamera;
  private readonly starsMesh: THREE.Mesh;
  private editNu: number | null = null; // 編集中ノードの真近点角(現在軌道上)
  private editDv = v3(); // 編集中 Δv (x=プログレード, y=ノーマル, z=ラジアルアウト) [m/s]
  private node: ManeuverNode | null = null;
  private autoWarp = false;

  private phase: GamePhase = 'playing';
  private simTime = 0;
  private lastSimDt = 0;
  private warpIdx = 0;
  private paused = false;

  private rcsDamp = true;
  private target: Ship | null = null;
  private throttleIdx = C.THROTTLE_DEFAULT_IDX;
  private fineAttitude = false;
  private progradeHold = false; // [C] 機首をプログレードへ自動保持するオートパイロット
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
  private beltPos: THREE.Vector3[] = [];
  private beltPrevPos: THREE.Vector3[] = [];
  private beltInit = false;
  private hudTimer = 0;
  private listTimer = 0;
  private readonly earthPhase0 = Math.random() * Math.PI * 2;

  constructor(gs: GameScene, stage = 1) {
    this.scene = gs.scene;
    this.camera = gs.camera;
    this.stage = stage;
    this.input = new Input(gs.renderer.domElement);
    this.input.onFirstGesture = () => this.sfx.unlock();

    // 軌道計画モード用の地球中心カメラ(モルニヤ級軌道全体が収まる遠方まで)
    this.mapCamera = new THREE.PerspectiveCamera(
      50,
      window.innerWidth / window.innerHeight,
      1e4,
      6e8,
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

    // マガジンベルト: 機体右舷から +X 方向へ連結。先頭リンクは機体に半分
    // 取り込まれた位置に置く(給弾中もベルトごと取り込まれている見た目)。
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

    this.hud.toast(
      `<b>作戦目標: 敵機 ${this.enemies.length} 機を全機撃破せよ</b><br>` +
        (stage === 2
          ? '敵の一部はモルニヤ級の高楕円軌道上にいる — [M] 軌道計画モードで遷移を計画せよ<br>'
          : '[Tab] ターゲット選択 → [F] ターゲット基準推進で接近 → [,/.] タイムワープで会合を短縮<br>') +
        '[H] キーで操作方法を表示',
      12000,
    );
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

  // ステージごとの敵軌道。ステージ1は自機軌道の近傍、
  // ステージ2は低軌道 2 機 + モルニヤ級高楕円軌道 3 機。
  private makeEnemySpecs(base: OrbitState, stage: number): EnemySpec[] {
    const r0 = len(base.r);
    const hHat = norm(cross(base.r, base.v));

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

  // ---------------------------------------------------------------- update

  update(dtRaw: number): void {
    const dt = Math.min(dtRaw, 0.1);
    this.zoomActive = !this.mapMode && this.input.down('KeyZ');
    this.handleEdgeInput();
    if (this.phase !== 'playing' && this.mapMode) {
      // ゲーム終了時はマップモードを強制解除する
      this.mapMode = false;
      this.hud.setPlanPanel(null);
    }
    if (!this.paused && this.phase === 'playing') {
      // 軌道計画モード中も時間を進め、ワープできるようにする(手動推進・射撃のみ
      // simulate() 内部で無効化する)。ノード編集は同じフレームの現在軌道に対して行う。
      this.simulate(dt);
      if (this.mapMode) this.updateMapPlanning(dt);
      else this.input.takeClicks(); // 戦闘中のクリックは射撃扱いのみ(座標キューは捨てる)
    } else {
      this.lastSimDt = 0;
      this.sfx.setThrust(false);
      this.thrustVizDir = null;
      this.thrustAccelVec = v3();
      this.input.takeClicks();
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
        case 'Digit2':
        case 'Digit3': {
          const idx = Number(code[code.length - 1]) - 1;
          this.throttleIdx = idx;
          this.hud.hint(`エンジン出力: 第${idx + 1}段 (${C.THROTTLE_LEVELS[idx]!.toFixed(1)} m/s²)`);
          break;
        }
        case 'Comma':
          this.autoWarp = false;
          if (this.warpIdx > 0) {
            this.warpIdx--;
            this.sfx.warp();
            this.hud.hint(`TIME WARP ×${this.warp()}`);
          }
          break;
        case 'Period':
          this.autoWarp = false;
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
          if (this.node && this.phase === 'playing') {
            this.autoWarp = !this.autoWarp;
            this.hud.hint(this.autoWarp ? 'ノードへ自動ワープ開始' : '自動ワープ解除');
          } else {
            this.hud.hint('マニューバノードがありません ([M] で計画)');
          }
          break;
        case 'KeyX':
          if (this.mapMode) {
            if (this.editNu !== null) this.hud.hint('ノードを削除');
            this.editNu = null;
            this.editDv = v3();
          } else if (this.node) {
            this.node = null;
            this.editNu = null;
            this.editDv = v3();
            this.autoWarp = false;
            this.hud.hint('マニューバノードを破棄');
          }
          break;
        case 'KeyP':
          this.paused = !this.paused;
          break;
        case 'KeyH':
          this.hud.toggleHelp();
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
      this.hud.hint('軌道計画モード: 自機軌道をクリックしてノード配置 → W/S・A/D・Q/E で Δv 調整 → [M] で確定', 5000);
    } else {
      this.mapMode = false;
      this.finalizeNode();
      this.hud.setPlanPanel(null);
    }
  }

  // ノードでの Δv(プログレード/ノーマル/ラジアル成分)をワールドベクトルへ
  private dvWorldAt(el: Elements, vNode: Vec3, dv: Vec3): Vec3 {
    const pro = norm(vNode);
    const h = el.hHat;
    const radOut = cross(pro, h);
    return v3(
      pro.x * dv.x + h.x * dv.y + radOut.x * dv.z,
      pro.y * dv.x + h.y * dv.y + radOut.y * dv.z,
      pro.z * dv.x + h.z * dv.y + radOut.z * dv.z,
    );
  }

  // 編集中ノードの計画軌道要素(プレビュー用)。null = プレビューなし。
  private plannedPreview(el: Elements): Elements | null {
    if (this.editNu === null) return null;
    const rN = positionOnOrbit(el, this.editNu);
    const vN = velocityOnOrbit(el, this.editNu);
    const vP = add(vN, this.dvWorldAt(el, vN, this.editDv));
    return elementsFromState(rN, vP);
  }

  // マップ表示中のノード編集(物理停止中)
  private updateMapPlanning(dt: number): void {
    const el = elementsFromState(this.player.state.r, this.player.state.v);
    if (!el || el.e >= 0.98 || !isFinite(el.period)) {
      this.hud.setPlanPanel('<div style="color:#ff6a00">現在の軌道では計画できません(楕円軌道が必要)</div>');
      this.input.takeClicks();
      return;
    }

    // クリック → 自機軌道上の最近傍点にノードを配置
    for (const c of this.input.takeClicks()) {
      const nu = this.pickOrbitNu(el, c.x, c.y);
      if (nu !== null) {
        this.editNu = nu;
        this.sfx.warp();
      }
    }

    // Δv 調整(推進キーを流用、[V] で微調整)
    if (this.editNu !== null) {
      const i = this.input;
      const rate = (this.fineAttitude ? C.NODE_DV_RATE_FINE : C.NODE_DV_RATE) * dt;
      this.editDv.x += ((i.down('KeyW') ? 1 : 0) + (i.down('KeyS') ? -1 : 0)) * rate;
      this.editDv.y += ((i.down('KeyA') ? 1 : 0) + (i.down('KeyD') ? -1 : 0)) * rate;
      this.editDv.z += ((i.down('KeyE') ? 1 : 0) + (i.down('KeyQ') ? -1 : 0)) * rate;
    }

    // 計画パネル
    const nuNow = trueAnomalyAt(el, this.player.state.r);
    if (this.editNu === null) {
      this.hud.setPlanPanel(
        '<div style="color:#7d838c">自機軌道(グレー)をクリックしてマニューバノードを配置(時間は進み続ける)<br>' +
          '[Tab] ターゲット切替 / 左ドラッグ・ホイールで視点 / [M] 戦闘ビューへ</div>',
      );
    } else {
      const tof = tofBetween(el, nuNow, this.editNu);
      const pl = this.plannedPreview(el);
      this.hud.setPlanPanel(this.hud.planHtml(this.editDv, tof, pl));
    }
  }

  // スクリーン座標から自機軌道上の最近傍点の真近点角を求める(離心近点角で一様サンプル)
  private pickOrbitNu(el: Elements, mx: number, my: number): number | null {
    const o = this.player.state.r;
    const b = el.a * Math.sqrt(1 - el.e * el.e);
    let best: number | null = null;
    let bestD = C.NODE_PICK_PX * C.NODE_PICK_PX;
    const N = 512;
    for (let i = 0; i < N; i++) {
      const E = (i / N) * Math.PI * 2;
      const x = el.a * (Math.cos(E) - el.e);
      const y = b * Math.sin(E);
      const pt = v3(
        el.pHat.x * x + el.qHat.x * y,
        el.pHat.y * x + el.qHat.y * y,
        el.pHat.z * x + el.qHat.z * y,
      );
      const p = this.project(sub(pt, o));
      if (!p.front) continue;
      const d = (p.x - mx) * (p.x - mx) + (p.y - my) * (p.y - my);
      if (d < bestD) {
        bestD = d;
        best = 2 * Math.atan2(Math.sqrt(1 + el.e) * Math.sin(E / 2), Math.sqrt(1 - el.e) * Math.cos(E / 2));
      }
    }
    return best;
  }

  // マップを抜けるとき、編集中のノードを実行計画として凍結する
  private finalizeNode(): void {
    this.node = null;
    this.autoWarp = false;
    const dvMag = len(this.editDv);
    if (this.editNu === null || dvMag < C.NODE_MIN_DV) return;
    const el = elementsFromState(this.player.state.r, this.player.state.v);
    if (!el || el.e >= 0.98 || !isFinite(el.period)) return;
    const nuNow = trueAnomalyAt(el, this.player.state.r);
    const rNode = positionOnOrbit(el, this.editNu);
    const vNode = velocityOnOrbit(el, this.editNu);
    const vPlanned = add(vNode, this.dvWorldAt(el, vNode, this.editDv));
    const targetEl = elementsFromState(rNode, vPlanned);
    if (!targetEl) return;
    this.node = {
      nodeTime: this.simTime + tofBetween(el, nuNow, this.editNu),
      rNode,
      vPlanned,
      targetEl,
      dvTotal: dvMag,
    };
    this.hud.hint(`マニューバノード確定 (Δv ${dvMag.toFixed(1)} m/s) — [N] でノードへ自動ワープ`, 4500);
  }

  // 噴射ガイドの達成判定と表示(戦闘ビュー)
  private updateNodeGuide(o: Vec3, pv: Vec3, playerEl: Elements | null): void {
    const node = this.node;
    if (!node || this.mapMode || !this.player.alive) {
      this.hud.hideMarker('nd');
      this.hud.hideMarker('burn');
      if (!this.mapMode) this.hud.setPlanPanel(null);
      return;
    }

    // 達成判定: 現在軌道が計画軌道に十分近い
    if (playerEl && this.orbitClose(playerEl, node.targetEl)) {
      this.node = null;
      this.autoWarp = false;
      this.hud.hideMarker('nd');
      this.hud.hideMarker('burn');
      this.hud.setPlanPanel(null);
      this.hud.hint('✓ マニューバ達成 — 計画軌道に到達', 5000);
      this.sfx.warp();
      return;
    }

    // ノード位置マーカー(カウントダウン付き)
    const tRem = node.nodeTime - this.simTime;
    const p = this.project(sub(node.rNode, o));
    const tLabel =
      tRem >= 0
        ? `T-${Math.floor(tRem / 60)}:${String(Math.floor(tRem % 60)).padStart(2, '0')}`
        : `T+${Math.floor(-tRem / 60)}:${String(Math.floor(-tRem % 60)).padStart(2, '0')}`;
    this.hud.marker('nd', 'mk-mnode', '◆', p.x, p.y, p.front, `NODE ${tLabel}`);

    // 噴射ガイド: 目標速度ベクトルとの差分方向へ加速する
    const dvRem = sub(node.vPlanned, pv);
    const mag = len(dvRem);
    const g = this.project(scale(norm(dvRem), 5e4));
    this.hud.marker(
      'burn',
      'mk-burn',
      '⬢',
      g.x,
      g.y,
      g.front,
      `BURN ${mag.toFixed(1)} m/s → ${(len(node.vPlanned) / 1000).toFixed(2)} km/s`,
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
    // [N] 自動ワープ: ノード到達時刻に向けてワープ段数を自動調整する
    if (this.autoWarp && this.node) {
      const tRem = this.node.nodeTime - this.simTime;
      if (tRem <= C.AUTOWARP_STOP) {
        this.warpIdx = 0;
        this.autoWarp = false;
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

    // 推進入力
    const thrustFn = canAct ? this.buildThrustAccel() : null;
    if (!canAct && !this.mapMode && this.anyThrustKey() && this.player.alive) {
      this.hud.hint(`射撃・推進はワープ ×${C.MAX_PHYS_WARP} 以下でのみ可能`);
    }
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

    // 姿勢力学(高ワープ時は見かけ上スローになるが数値的に安定)
    const attDt = Math.min(simDt, 0.12);
    this.updatePlayerAttitude(attDt);
    for (const e of this.enemies) if (e.alive) stepAttitude(e.att, v3(), attDt);
    for (const cs of this.casings) stepAttitude(cs.att, v3(), attDt);
    for (const d of this.debris) stepAttitude(d.att, v3(), attDt);
    for (const mp of this.magPickups) if (mp.alive) stepAttitude(mp.att, v3(), attDt);

    this.cleanup();
  }

  // 弾薬まわりの毎フレーム処理: 補給の取り込み・低残弾時の補給投入・薬莢の接触音
  private updateAmmoLogistics(dt: number): void {
    // 補給マガジンの取り込み
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

    // 薬莢が機体に当たったときの金属音(かすかに、レート制限つき)。
    // 排出直後は必ず機体の近くにいるため、一度 6m 以上離れて「アーム」された
    // 薬莢が再接近したときだけ鳴らす。
    this.clankCd -= dt;
    if (this.player.alive) {
      for (const cs of this.casings) {
        if (cs.clanked) continue;
        const d2 = lenSq(sub(cs.state.r, this.player.state.r));
        if (!cs.clankArmed) {
          if (d2 > 6 * 6) cs.clankArmed = true;
          continue;
        }
        if (d2 < 3.2 * 3.2 && this.clankCd <= 0) {
          cs.clanked = true;
          this.sfx.clank();
          this.clankCd = 0.07;
        }
      }
    }
  }

  // 自機軌道の少し先(同一軌道を位相シフト)に補給マガジンを投入する
  private spawnMagPickup(): void {
    const r = this.player.state.r;
    const v = this.player.state.v;
    const hHat = norm(cross(r, v));
    const ang = (2500 + Math.random() * 2500) / len(r); // 2.5〜5km 先
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
  private makeEnvAccel(bcInv: number): ExtraAccel {
    const drag = makeDragAccel(bcInv);
    return (r: Vec3, v: Vec3): Vec3 => {
      const a = drag(r, v);
      const j = j2Accel(r);
      const s = thirdBodyAccel(r, this.sunPos, MU_SUN);
      const m = thirdBodyAccel(r, this.moonPos, MU_MOON);
      return v3(
        a.x + j.x + s.x + m.x,
        a.y + j.y + s.y + m.y,
        a.z + j.z + s.z + m.z,
      );
    };
  }

  // 対気速度から動圧と外殻温度を更新する。加熱はよどみ点熱流束の
  // Sutton–Graves 近似 q̇ = k·√(ρ/Rn)·v³、冷却はステファン・ボルツマン放射。
  private updateThermal(dtSub: number): void {
    const r = this.player.state.r;
    const v = this.player.state.v;
    const rho = atmosphericDensity(len(r) - R_EARTH);
    const vr = v3(v.x - EARTH_OMEGA * r.z, v.y, v.z + EARTH_OMEGA * r.x);
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

  private anyThrustKey(): boolean {
    return ['KeyW', 'KeyS', 'KeyA', 'KeyD', 'KeyQ', 'KeyE'].some((k) => this.input.down(k));
  }

  // 押下キーから推力加速度関数を構築。
  // 機体座標系（+Z前, +X右, +Y上）を基準とする。
  private buildThrustAccel(): ExtraAccel | null {
    const i = this.input;
    const axZ = (i.down('KeyW') ? 1 : 0) + (i.down('KeyS') ? -1 : 0); // 前/後
    // X軸が左を向いているため、A(左)を+X、D(右)を-Xに割り当てる
    const axX = (i.down('KeyA') ? 1 : 0) + (i.down('KeyD') ? -1 : 0); // 左/右
    const axY = (i.down('KeyE') ? 1 : 0) + (i.down('KeyQ') ? -1 : 0); // 上/下
    if (axX === 0 && axY === 0 && axZ === 0) return null;

    const thrustAccel = C.THROTTLE_LEVELS[this.throttleIdx]!;
    const q = this.player.att.q;

    return (): Vec3 => {
      const localThrustDir = v3(axX, axY, axZ);
      const normalizedLocal = norm(localThrustDir);
      const worldThrustDir = qRotate(q, normalizedLocal);
      return v3(
        worldThrustDir.x * thrustAccel,
        worldThrustDir.y * thrustAccel,
        worldThrustDir.z * thrustAccel,
      );
    };
  }

  private updatePlayerAttitude(attDt: number): void {
    if (!this.player.alive) return;
    const i = this.input;
    const att = this.player.att;
    const I = att.inertia;
    // 機体軸: +X 右, +Y 上, +Z 前(機首)。マップモード中は手動回転操作を無効化する
    // (WASDQE はノード Δv 編集に使うため、姿勢キーは残っていても無視する)。
    const manual = this.mapMode ? 0 : 1;
    const inX = ((i.down('KeyI') ? 1 : 0) + (i.down('KeyK') ? -1 : 0)) * manual; // ピッチ
    const inY = ((i.down('KeyL') ? 1 : 0) + (i.down('KeyJ') ? -1 : 0)) * manual; // ヨー
    const inZ = ((i.down('KeyU') ? 1 : 0) + (i.down('KeyO') ? -1 : 0)) * manual; // ロール

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

    // 薬莢: 左舷へ排出(右舷はマガジンベルトがあるため)。初速・回転とも
    // 従来より抑え、ゆっくり漂いながら緩やかに回転する見た目にする。
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

  private removeDebrisObj(d: DebrisPiece): void {
    this.scene.remove(d.obj);
    const mesh = d.obj as THREE.Mesh;
    mesh.geometry.dispose();
    (mesh.material as THREE.Material).dispose();
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

    // 地球・恒星・太陽
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
      const cp = Math.cos(this.mapPitch);
      // 地球中心はフローティングオリジンで -o
      this.mapCamera.position.set(
        -o.x + cp * Math.cos(this.mapYaw) * this.mapDist,
        -o.y + Math.sin(this.mapPitch) * this.mapDist,
        -o.z + cp * Math.sin(this.mapYaw) * this.mapDist,
      );
      this.mapCamera.up.set(0, 1, 0);
      this.mapCamera.lookAt(-o.x, -o.y, -o.z);
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
    this.sun.mesh.position.set(
      cam.position.x + sd.x * SUN_DISTANCE,
      cam.position.y + sd.y * SUN_DISTANCE,
      cam.position.z + sd.z * SUN_DISTANCE,
    );
    this.sun.mesh.quaternion.copy(cam.quaternion);
    this.sunLight.position.set(sd.x * 1e5, sd.y * 1e5, sd.z * 1e5);
    const moonRel = sub(this.moonPos, o);
    const moonDist = len(moonRel);
    const md = scale(moonRel, 1 / moonDist);
    this.moonMesh.position.set(
      cam.position.x + md.x * MOON_VIS_DIST,
      cam.position.y + md.y * MOON_VIS_DIST,
      cam.position.z + md.z * MOON_VIS_DIST,
    );
    this.moonMesh.scale.setScalar(MOON_VIS_DIST * (R_MOON / moonDist));

    // 地球の影: 自機周辺が影円柱内にあれば太陽光・環境光を減光する
    const lit = this.shadowLitFactor(o);
    this.sunLight.intensity = C.SUN_INTENSITY * (C.SHADOW_MIN_SUN + (1 - C.SHADOW_MIN_SUN) * lit);
    this.ambient.intensity =
      C.AMBIENT_INTENSITY * (C.SHADOW_MIN_AMBIENT + (1 - C.SHADOW_MIN_AMBIENT) * lit);

    // マヌーバ噴射プルーム: 推力方向の逆側に、明るい芯 + 淡い外殻の 2 枚を置く
    const showPlume = this.thrustVizDir !== null && this.player.alive && !this.zoomActive;
    this.plumeCore.visible = showPlume;
    this.plumeOuter.visible = showPlume;
    if (showPlume) {
      const d = this.thrustVizDir!;
      const flick = 0.82 + Math.random() * 0.36; // 揺らぎ
      const sc = (1.5 + 0.9 * this.throttleIdx) * flick; // 出力段で大きく
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
    this.playerOrbitLine.update(this.player.alive ? playerEl : null, o, this.thrustVizDir !== null);
    const tgt = this.target && this.target.alive ? this.target : null;
    this.targetOrbitLine.update(tgt ? elementsFromState(tgt.state.r, tgt.state.v) : null, o);

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

    // 計画軌道(白): マップ編集中はプレビュー、戦闘中は確定ノードの目標軌道
    let plannedEl: Elements | null = null;
    if (this.mapMode && playerEl) {
      plannedEl = this.plannedPreview(playerEl);
    } else if (this.node) {
      plannedEl = this.node.targetEl;
    }
    // マップ編集中は Δv 操作に即時追従させる
    this.plannedOrbitLine.update(plannedEl, o, this.mapMode);

    // マップ編集中のノード位置マーカー
    if (this.mapMode && playerEl && this.editNu !== null) {
      const np = this.project(sub(positionOnOrbit(playerEl, this.editNu), o));
      this.hud.marker('nd', 'mk-mnode', '◆', np.x, np.y, np.front, `NODE Δv ${len(this.editDv).toFixed(1)} m/s`);
    } else if (this.mapMode) {
      this.hud.hideMarker('nd');
    }

    this.updateMarkers(o, pv, tgt);
    this.updateNodeMarkers(playerEl, tgt, o);
    this.updateBoardMarkers(o, dt, tgt);
    if (!this.mapMode) this.updateNodeGuide(o, pv, playerEl);
    else this.hud.hideMarker('burn');
    this.updateNavball(o, pv, tgt);
    this.updateHudPanels(dt, playerEl, tgt);
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
      }
    }

    // 機体の角加速度を前フレームとの差分から推定(body-frame ω の差分)
    const w = this.player.att.w;
    const alpha =
      dt > 1e-6 ? v3((w.x - this.prevBodyW.x) / dt, (w.y - this.prevBodyW.y) / dt, (w.z - this.prevBodyW.z) / dt) : v3();
    this.prevBodyW = v3(w.x, w.y, w.z);

    // 推力加速度をワールド→機体座標系へ変換(擬似力は加速度と逆向き)
    const qInv = new THREE.Quaternion(
      this.player.att.q.x,
      this.player.att.q.y,
      this.player.att.q.z,
      this.player.att.q.w,
    ).invert();
    const aThrustWorld = this.thrustAccelVec;
    const aThrustBody = new THREE.Vector3(aThrustWorld.x, aThrustWorld.y, aThrustWorld.z).applyQuaternion(qInv);

    const h = Math.min(dt, 0.05); // 積分刻みの上限(大きな dt でのはみ出し防止)
    const damping = 0.985; // 空気抵抗の無い環境でも数値的な発散を防ぐための減衰
    const wV = new THREE.Vector3(w.x, w.y, w.z);
    const alphaV = new THREE.Vector3(alpha.x, alpha.y, alpha.z);

    for (let i = 0; i < n; i++) {
      const pos = this.beltPos[i]!;
      const prev = this.beltPrevPos[i]!;
      const vel = new THREE.Vector3().copy(pos).sub(prev); // 前フレームの変位(Verlet の速度相当)

      // 擬似力による加速度: -a_thrust - α×r - ω×(ω×r) - 2ω×v
      const accel = new THREE.Vector3(-aThrustBody.x, -aThrustBody.y, -aThrustBody.z);
      accel.sub(new THREE.Vector3().crossVectors(alphaV, pos));
      accel.sub(new THREE.Vector3().crossVectors(wV, new THREE.Vector3().crossVectors(wV, pos)));
      accel.sub(new THREE.Vector3().crossVectors(wV, vel).multiplyScalar(2 / Math.max(h, 1e-4)));

      const next = new THREE.Vector3()
        .copy(pos)
        .addScaledVector(vel, damping)
        .addScaledVector(accel, h * h);
      prev.copy(pos);
      pos.copy(next);
    }

    // 距離拘束(剛体棒): 先頭はベルトの給弾進みに応じて動くアンカーに固定。
    // 数回反復して各リンク間隔を MAG_BELT_PITCH に収束させる。
    const anchor = new THREE.Vector3(0.9 - this.beltFeed * MAG_BELT_PITCH, 0, 0);
    for (let iter = 0; iter < 4; iter++) {
      for (let i = 0; i < n; i++) {
        const a = i === 0 ? anchor : this.beltPos[i - 1]!;
        const b = this.beltPos[i]!;
        const delta = new THREE.Vector3().copy(b).sub(a);
        const dist = delta.length();
        if (dist < 1e-6) continue;
        const corr = delta.multiplyScalar((dist - MAG_BELT_PITCH) / dist);
        if (i === 0) {
          b.sub(corr); // アンカー側は固定、リンク側だけ補正
        } else {
          b.addScaledVector(corr, -0.5);
          a.addScaledVector(corr, 0.5);
        }
      }
    }

    // 表示: 各リンクをその節点の手前(アンカー or 前リンクの節点)に置き、
    // 節点への方向へ向ける(ローカル +X = ベルト方向)。
    let prevPoint = anchor;
    const xAxis = new THREE.Vector3(1, 0, 0);
    for (let i = 0; i < n; i++) {
      const link = this.beltLinks[i]!;
      link.visible = this.player.alive && i < beltCount;
      const pos = this.beltPos[i]!;
      link.position.copy(prevPoint);
      const dir = new THREE.Vector3().copy(pos).sub(prevPoint).normalize();
      if (dir.lengthSq() > 1e-8) {
        link.quaternion.setFromUnitVectors(xAxis, dir);
      }
      prevPoint = pos;
    }
  }

  // RCS 姿勢制御の噴射パフと音。4 基のスラスタブロック(機体 ±0.75, ±0.65, z=1.6)
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

    const tau = v3(
      (i.down('KeyI') ? 1 : 0) + (i.down('KeyK') ? -1 : 0),
      (i.down('KeyL') ? 1 : 0) + (i.down('KeyJ') ? -1 : 0),
      (i.down('KeyU') ? 1 : 0) + (i.down('KeyO') ? -1 : 0),
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
      const label = `${e.name} ${dist >= 1000 ? (dist / 1000).toFixed(1) + 'km' : dist.toFixed(0) + 'm'}`;
      this.hud.marker(key, isTgt ? 'mk-target' : 'mk-enemy', '◇', p.x, p.y, p.front, label);
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
      const label = `AMMO ${dist >= 1000 ? (dist / 1000).toFixed(1) + 'km' : dist.toFixed(0) + 'm'}`;
      this.hud.marker(key, 'mk-ammo', '▣', p.x, p.y, p.front, label);
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
  private updateNodeMarkers(playerEl: Elements | null, tgt: Ship | null, o: Vec3): void {
    if (!playerEl || !tgt) {
      this.hud.hideMarker('an');
      this.hud.hideMarker('dn');
      return;
    }
    const tgtEl = elementsFromState(tgt.state.r, tgt.state.v);
    const lineDir = tgtEl ? cross(playerEl.hHat, tgtEl.hHat) : null;
    if (!tgtEl || !lineDir || lenSq(lineDir) < 1e-6) {
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
  ): void {
    this.hudTimer -= dt;
    if (this.hudTimer <= 0) {
      this.hudTimer = 0.1;
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
      });

      if (tgt) {
        const relP = sub(tgt.state.r, this.player.state.r);
        const relV = sub(tgt.state.v, this.player.state.v);
        const dist = len(relP);
        const tgtEl = elementsFromState(tgt.state.r, tgt.state.v);
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
}
