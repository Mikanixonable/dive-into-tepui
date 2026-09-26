// マガジンベルトの鎖のたわみ・ねじれを機体座標系で解き、接触判定の代理を置く。
import type { Attitude } from '../../physics/attitude';
import { LOCAL_RIGHT, Q_IDENTITY, qFromUnitVectors, qInvert, qMul, qRotate, type Quat } from '../../math/quat';
import { kinematicState } from '../../physics/kinematic-state';
import { type Vec3, add, addScaled, cross, len, norm, scale, sub, v3, type SerializedVec3 } from '../../math/vec3';
import { MAG_BELT_ANCHOR_X, MAG_BELT_PITCH } from '../../physics/player-shape';
import { ContactProxy } from '../dynamic/contact-proxy';
import type { EntityContactParticipant } from '../dynamic/dynamic-simulation-participant';

const MAG_CHAIN_MAX_ROLL_DEG = 15;  // ロール上限
const MAG_CHAIN_MAX_PITCH_DEG = 45; // ピッチ上限(上下方向の折れ)
const MAG_CHAIN_MAX_YAW_DEG = 15;   // ヨー上限(左右方向の折れ)
const MAG_CHAIN_ROLL_GAIN = 0.6; // 機体のロール角速度→ねじれ目標角への変換係数
const MAG_CHAIN_ROLL_RATE = 3.5; // ねじれ角が目標へ追従する速さ [1/s]
const BELT_SECTION_MASS = 5; // 接触で押し合うときの、節点1つの質量 [kg]
const BELT_SECTION_RADIUS = 0.8; // 節点の接触半径 [m]


// v を [lo, hi] にクランプする。
function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

// 鎖の節点の直列化した形。位置・前の位置・ねじれは吊り元から順に並ぶ。
export interface SerializedBeltPhysics {
  readonly positions: SerializedVec3[];
  readonly prevPositions: SerializedVec3[];
  readonly twists: number[];
  readonly prevShipW: SerializedVec3;
}

export class BeltPhysics {
  // 機体座標系の節点位置。
  private readonly _positions: Vec3[];
  private readonly prevPositions: Vec3[];
  // 各リンクのチェーン軸まわりのねじれ角 [rad]。常に ±MAG_CHAIN_MAX_ROLL_DEG に収まる。
  private readonly _twists: number[];

  private prevShipW: Vec3;
  private mountAnchor = v3(MAG_BELT_ANCHOR_X, 0, 0);
  private mountDirection = LOCAL_RIGHT;
  private mountQ: Quat = Q_IDENTITY;
  // 給弾進みに応じて動く根本の固定点(機体座標系)。
  private anchorValue: Vec3 = this.mountAnchor;

  public get anchor(): Vec3 { return this.anchorValue; }

  // positions・prevPositions は機体座標系の節点の位置と前フレームの位置、twists は各節のねじれ角
  // [rad]、prevShipW は前フレームの機体角速度 [rad/s]。省いたものは静止した鎖として始める。
  public constructor(
    positions: readonly Vec3[],
    prevPositions: readonly Vec3[] = positions,
    twists: readonly number[] = positions.map(() => 0),
    prevShipW = v3(),
  ) {
    this._positions = [...positions];
    this.prevPositions = [...prevPositions];
    this._twists = [...twists];
    this.prevShipW = prevShipW;
  }

  // linkCount 個の節点を、アンカーから等間隔に伸ばした形で新しく作る。最初の update より前から位置を
  // 答えられる。
  public static create(linkCount: number): BeltPhysics {
    return new BeltPhysics(
      Array.from({ length: linkCount }, (_, i) => v3(MAG_BELT_ANCHOR_X + (i + 1) * MAG_BELT_PITCH, 0, 0)),
    );
  }

  // 直列化した節点から復元する。
  public static deserialize(serialized: SerializedBeltPhysics): BeltPhysics {
    const vec = (p: SerializedVec3): Vec3 => v3(p.x, p.y, p.z);
    return new BeltPhysics(
      serialized.positions.map(vec),
      serialized.prevPositions.map(vec),
      serialized.twists,
      vec(serialized.prevShipW),
    );
  }

  // 節点の位置・前の位置・ねじれと、前フレームの機体角速度の直列化。
  public serialize(): SerializedBeltPhysics {
    return {
      positions: [...this._positions],
      prevPositions: [...this.prevPositions],
      twists: [...this._twists],
      prevShipW: this.prevShipW,
    };
  }

  private get linkCount(): number { return this._positions.length; }

  public get positions(): readonly Vec3[] { return this._positions; }
  public get twists(): readonly number[] { return this._twists; }

  // weapon module の semantic belt anchor と延伸方向へ鎖全体を据え直す。assembly の質量だけが
  // 変わったフレームでは同値入力を無視し、燃料消費でベルトを毎回初期化しない。
  public setMount(anchor: Vec3, direction: Vec3): void {
    const normalizedDirection = norm(direction);
    if (len(sub(anchor, this.mountAnchor)) < 1e-9
      && len(sub(normalizedDirection, this.mountDirection)) < 1e-9) return;
    this.mountAnchor = v3(anchor.x, anchor.y, anchor.z);
    this.mountDirection = normalizedDirection;
    this.mountQ = qFromUnitVectors(LOCAL_RIGHT, normalizedDirection);
    this.anchorValue = this.mountAnchor;
    for (let i = 0; i < this.linkCount; i++) {
      const p = addScaled(this.mountAnchor, this.mountDirection, (i + 1) * MAG_BELT_PITCH);
      this._positions[i] = p;
      this.prevPositions[i] = p;
      this._twists[i] = 0;
    }
  }

  // リンクを1つ手前へ詰め、末尾に新しいリンクを継ぎ足す。
  public shiftBeltNodes(): void {
    const n = this.linkCount;
    if (n < 2) return;

    // ノードを 1 つ前詰め (i=0 は消費済みマガジン、破棄)
    for (let i = 0; i < n - 1; i++) {
      this._positions[i] = this._positions[i + 1]!;
      this.prevPositions[i] = this.prevPositions[i + 1]!;
      this._twists[i] = this._twists[i + 1]!;
    }

    // 末尾へ新ノードを追加。位置は概算でよく、次フレームの拘束で収束する。
    const last = this._positions[n - 2]!;
    const lastPrev = this.prevPositions[n - 2]!;
    const vel = sub(last, lastPrev); // 前のノードの速度ベクトルを引き継いで自然に延長
    const newLast = addScaled(add(last, vel), this.mountDirection, MAG_BELT_PITCH);
    this._positions[n - 1] = newLast;
    this.prevPositions[n - 1] = (newLast); // 新末尾は追加直後は速度ゼロ
    this._twists[n - 1] = this._twists[n - 2]!;
  }

  // ベルトのたわみを dt 秒ぶん時間発展させる。軌道上は自由落下のため重力は作用せず、機体の推力加速度と
  // 回転が生む慣性力がベルトを機体座標系の中で揺らす。
  public update(dt: number, att: Attitude, thrustAccelVec: Vec3, beltFeed: number): void {
    // 前フレームとの角速度差から角加速度を推定する
    const invDt = dt > 1e-6 ? 1 / dt : 0;
    const angularAccel = scale(sub(att.w, this.prevShipW), invDt);
    this.prevShipW = att.w;

    const aThrustShip = qRotate(qInvert(att.q), thrustAccelVec);
    this.integrateVerlet(dt, att.w, angularAccel, aThrustShip);

    this.anchorValue = addScaled(
      this.mountAnchor, this.mountDirection, -beltFeed * MAG_BELT_PITCH,
    );
    const anchor = this.anchorValue;
    this.pinRootToAnchor(anchor);
    this.relaxDistanceConstraints(anchor);

    this.advanceOrientationConstraints(dt, att, beltFeed, anchor);
  }

  // 各節点の位置を、角加速度 angularAccel の機体座標系の擬似力込みで Verlet 積分する。
  private integrateVerlet(dt: number, w: Vec3, angularAccel: Vec3, aThrustShip: Vec3): void {
    const h = Math.min(dt, 0.05); // 積分刻みの上限(大きな dt でのはみ出し防止)
    const damping = 0.99; // 慣性を維持しつつ、毎ステップ速度を1%減衰させる
    const invDt = dt > 1e-6 ? 1 / dt : 0;
    // コリオリ力 -2ω×v の係数。vel は dt あたりの変位なので h でなく dt で割る(h では dt > 0.05 で過大になる)。
    const inv2Dt = invDt * 2;

    for (let i = 0; i < this.linkCount; i++) {
      const pos = this._positions[i]!;
      const vel = sub(pos, this.prevPositions[i]!); // 前フレームの変位(Verlet の速度相当)

      // 擬似力による加速度: -a_thrust - α×r - ω×(ω×r) - 2ω×v
      const euler = cross(angularAccel, pos);
      const centrifugal = cross(w, cross(w, pos));
      const coriolis = scale(cross(w, vel), inv2Dt);
      const accel = v3(
        -aThrustShip.x - euler.x - centrifugal.x - coriolis.x,
        -aThrustShip.y - euler.y - centrifugal.y - coriolis.y,
        -aThrustShip.z - euler.z - centrifugal.z - coriolis.z,
      );

      this.prevPositions[i] = pos;
      this._positions[i] = addScaled(addScaled(pos, vel, damping), accel, h * h);
    }
  }

  // 根本(リンク0)をアンカー anchor の隣へ固定する。
  private pinRootToAnchor(anchor: Vec3): void {
    const root = addScaled(anchor, this.mountDirection, MAG_BELT_PITCH);
    this._positions[0] = root;
    this.prevPositions[0] = (root);
  }

  // 数回反復して、アンカー anchor から各リンク間隔を MAG_BELT_PITCH に収束させる
  private relaxDistanceConstraints(anchor: Vec3): void {
    const n = this.linkCount;
    for (let iter = 0; iter < 6; iter++) {
      for (let i = 0; i < n; i++) {
        const a = i === 0 ? anchor : this._positions[i - 1]!;
        const b = this._positions[i]!;
        const delta = sub(b, a);
        const dist = len(delta);
        if (dist < 1e-6) continue;
        const corr = scale(delta, (dist - MAG_BELT_PITCH) / dist);
        if (i <= 1) {
          // 参照点(アンカーまたは根本)は固定なので b 側だけ補正する。
          this._positions[i] = sub(b, corr);
        } else {
          this._positions[i] = addScaled(b, corr, -0.5);
          this._positions[i - 1] = addScaled(a, corr, 0.5);
        }
      }
    }
  }

  // つなぎ目ごとにピッチ/ヨーの角度上限を課して節点位置へ書き戻し、併せてねじれ角を進める。
  // 根本から2番目のつなぎ目は、次にリンク0へ昇格する前に直立させるため feed に応じて上限を0へ絞る。
  // 鎖はアンカー anchor から伸ばす。
  private advanceOrientationConstraints(dt: number, att: Attitude, feed: number, anchor: Vec3): void {
    const maxRoll = (MAG_CHAIN_MAX_ROLL_DEG * Math.PI) / 180;
    const maxPitchRad = (MAG_CHAIN_MAX_PITCH_DEG * Math.PI) / 180;
    const maxYawRad = (MAG_CHAIN_MAX_YAW_DEG * Math.PI) / 180;
    const secondLinkNarrowing = clamp(1 - feed, 0, 1);
    const rollLerp = Math.min(1, dt * MAG_CHAIN_ROLL_RATE);
    let prevPoint = anchor;
    let prevQ: Quat = this.mountQ;
    let prevTwist = att.w.z * MAG_CHAIN_ROLL_GAIN; // ねじれの発生源: 機体のロール角速度

    for (let i = 0; i < this.linkCount; i++) {
      const rawDir = sub(this._positions[i]!, prevPoint);
      const segLen = len(rawDir); // 方向を取り出すためだけの実長
      let bendQ = prevQ;
      if (segLen > 1e-6) {
        const narrowing = i === 1 ? secondLinkNarrowing : 1;
        // tan(最大角度) = ローカル座標系での横ずれ/前進量の上限
        const tanMaxPitch = Math.tan(maxPitchRad * narrowing);
        const tanMaxYaw = Math.tan(maxYawRad * narrowing);
        const clampedDir = this.clampDirectionToPrevFrame(scale(rawDir, 1 / segLen), prevQ, tanMaxPitch, tanMaxYaw);

        // 実長ではなく目標長 MAG_BELT_PITCH を使う: 実長は補正済み prevPoint からの誤差を増幅して NaN へ発散する。
        const newPos = addScaled(prevPoint, clampedDir, MAG_BELT_PITCH);
        const oldPos = this._positions[i]!;
        this.prevPositions[i] = add(this.prevPositions[i]!, sub(newPos, oldPos));
        this._positions[i] = newPos;

        const localX = qRotate(prevQ, LOCAL_RIGHT); // 前リンクの進行方向(ワールド)
        bendQ = qMul(qFromUnitVectors(localX, clampedDir), prevQ); // 曲げぶんの最小回転を合成
      }

      prevTwist = this.advanceTwist(i, prevTwist, maxRoll, rollLerp);
      prevQ = bendQ;
      prevPoint = this._positions[i]!;
    }
  }

  // 単位方向 dirWorld を、前リンクの姿勢 prevQ(+X が進行方向)から見た上下・左右の折れ角が
  // 上限内に収まるよう曲げて返す。tanMaxPitch・tanMaxYaw は上限角の正接。
  private clampDirectionToPrevFrame(dirWorld: Vec3, prevQ: Quat, tanMaxPitch: number, tanMaxYaw: number): Vec3 {
    const local = qRotate(qInvert(prevQ), dirWorld);
    // local.x は cos(折れ角) ≈ 1。ゼロ割を避けるため下限 0.001。
    const lx = Math.max(local.x, 0.001);
    const clampedLocal = norm(v3(lx, clamp(local.y, -tanMaxYaw * lx, tanMaxYaw * lx), clamp(local.z, -tanMaxPitch * lx, tanMaxPitch * lx)));
    return qRotate(prevQ, clampedLocal);
  }

  // i 番のねじれ角を更新し、次リンクへ位相遅れつつ伝播させるシード値を返す
  private advanceTwist(i: number, prevTwist: number, maxRoll: number, rollLerp: number): number {
    if (i === 0) {
      // 根本はねじれ 0 に固定し、伝播用シードはそのまま次リンクへ渡す。
      this._twists[0] = 0;
      return prevTwist;
    }
    const target = clamp(prevTwist, -maxRoll, maxRoll);
    const twist = this._twists[i]! + (target - this._twists[i]!) * rollLerp;
    this._twists[i] = clamp(twist, -maxRoll, maxRoll);
    return this._twists[i]!;
  }

  // 節点ごとの接触代理。初回の placeContactSections で生成し、以後は使い回す。visible 以降の
  // 節点は contactSections に含めず、衝突解決の書き戻しもしない。
  private readonly sections: ContactProxy[] = [];
  private activeSections = 0;

  // 表示されている節点ぶんの接触代理。placeContactSections で置き直す。
  public get contactSections(): readonly ContactProxy[] {
    return this.activeSections === this.sections.length
      ? this.sections
      : this.sections.slice(0, this.activeSections);
  }

  // 機体座標系の節点を ECI 状態へ直し、衝突判定用の接触代理を置き直す。visibleLinks より後の節点は
  // 見えないので置かない。owner は鎖を吊る艦で、自身の節点との接触を除外するのに使う(呼ぶたびに
  // 同じ艦を渡す)。t は現在時刻、baseR・baseV は機体の ECI 位置・速度。
  public placeContactSections(
    owner: EntityContactParticipant, visibleLinks: number, t: number, dt: number,
    baseR: Vec3, baseV: Vec3, att: Attitude,
  ): void {
    const invDt = 1 / dt;
    this.activeSections = Math.min(Math.max(0, visibleLinks), this.linkCount);
    for (let i = 0; i < this.activeSections; i++) {
      const bp = this._positions[i]!;
      const bpPrev = this.prevPositions[i]!;
      // 節点は機体座標系の中で Verlet 変位ぶん動き、機体そのものの回転で接線方向にも動く。
      const verletVel = v3((bp.x - bpPrev.x) * invDt, (bp.y - bpPrev.y) * invDt, (bp.z - bpPrev.z) * invDt);
      const bodyVel = add(verletVel, cross(att.w, bp));

      const world = kinematicState<'eci'>(
        t,
        add(baseR, qRotate(att.q, bp)),
        add(baseV, qRotate(att.q, bodyVel)),
      );
      const section = this.sections[i];
      if (section === undefined) {
        this.sections.push(new ContactProxy(owner, 'belt-section', BELT_SECTION_MASS, BELT_SECTION_RADIUS, world));
      } else {
        section.reset(world);
      }
    }
  }

  // 衝突解決後のワールド状態を機体座標系の節点位置・速度へ書き戻す。置いていない節点は書き戻さない。
  public applyContactSections(dt: number, baseR: Vec3, baseV: Vec3, att: Attitude): void {
    const qInv = qInvert(att.q);
    for (const [i, s] of this.sections.slice(0, this.activeSections).entries()) {
      const bpLocal = qRotate(qInv, sub(s.state.r, baseR));
      const bodyVel = qRotate(qInv, sub(s.state.v, baseV));
      const verletVel = sub(bodyVel, cross(att.w, bpLocal));

      // Verlet は前後2つの位置で速度を表すので、速度は前フレーム位置へ畳んで返す。
      this._positions[i] = bpLocal;
      this.prevPositions[i] = v3(
        bpLocal.x - verletVel.x * dt,
        bpLocal.y - verletVel.y * dt,
        bpLocal.z - verletVel.z * dt,
      );
    }
  }
}
