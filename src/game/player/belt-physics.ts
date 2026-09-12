// マガジンベルトの物理演算(Verlet 積分 + 距離拘束によるチェーンのたわみ・ねじれ)。
import { Attitude } from '../../physics/attitude';
import { LOCAL_RIGHT, Q_IDENTITY, qFromUnitVectors, qInvert, qMul, qRotate, Quat } from '../../math/quat';
import { KinematicState, kinematicState } from '../../physics/kinematic-state';
import { Vec3, add, addScaled, cross, len, norm, scale, sub, v3 } from '../../math/vec3';
import { MAG_BELT_ANCHOR_X, MAG_BELT_PITCH } from '../../physics/player-shape';
import { DynamicMotion, type DynamicMotionBehavior } from '../dynamic/dynamic-motion';

const MAG_CHAIN_MAX_ROLL_DEG = 15;  // ロール上限
const MAG_CHAIN_MAX_PITCH_DEG = 45; // ピッチ上限(上下方向の折れ)
const MAG_CHAIN_MAX_YAW_DEG = 15;   // ヨー上限(左右方向の折れ)
const MAG_CHAIN_ROLL_GAIN = 0.6; // 機体のロール角速度→ねじれ目標角への変換係数
const MAG_CHAIN_ROLL_RATE = 3.5; // ねじれ角が目標へ追従する速さ [1/s]


// v を [lo, hi] にクランプする。
function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

// ベルトのリンク節点を剛体接触に参加させるためのプロキシ。
export class BeltSection extends DynamicMotion {
  // 吊り元の艦 owner にぶら下がる節点のプロキシを生成する。
  // state は生成時点の実際の world 状態 — 仮の状態で始めると、最初に置き直した substep の
  // prevState がその仮位置になり、そこからの偽の区間を掃引してしまう。
  public constructor(owner: DynamicMotion, state: KinematicState) {
    const behavior: DynamicMotionBehavior = {
      contactKind: 'belt-section',
      contactsWith: (_self, other) => other !== owner && other.attachedTo !== owner,
    };
    super(state, { mass: 5, radius: 0.8, collides: true, behavior });
    this.attachedTo = owner;
  }
}

export class BeltPhysics {
  // 機体座標系の節点位置。
  public readonly positions: Vec3[] = [];
  private readonly prevPositions: Vec3[] = [];
  // 各リンクのチェーン軸まわりのねじれ角 [rad]。常に ±MAG_CHAIN_MAX_ROLL_DEG に収まる。
  public readonly twists: number[] = [];

  private prevShipW = v3(); // 前フレームの機体角速度(ベルト物理の角加速度推定用)
  private angularAccel = v3();
  // 給弾進みに応じて動く根本の固定点(機体座標系)。
  private anchorValue: Vec3 = v3(MAG_BELT_ANCHOR_X, 0, 0);

  public get anchor(): Vec3 { return this.anchorValue; }

  // 節点はアンカーから等間隔に伸ばした形で始め、最初の update より前から位置を答えられる。
  public constructor(private readonly linkCount: number, private readonly owner: DynamicMotion) {
    for (let i = 0; i < linkCount; i++) {
      const p = v3(MAG_BELT_ANCHOR_X + (i + 1) * MAG_BELT_PITCH, 0, 0);
      this.positions.push(p);
      this.prevPositions.push(p);
      this.twists.push(0);
    }
  }

  // リンクを1つ手前へ詰め、末尾に新しいリンクを継ぎ足す。
  public shiftBeltNodes(): void {
    const n = this.linkCount;
    if (n < 2) return;

    // ノードを 1 つ前詰め (i=0 は消費済みマガジン、破棄)
    for (let i = 0; i < n - 1; i++) {
      this.positions[i] = this.positions[i + 1]!;
      this.prevPositions[i] = this.prevPositions[i + 1]!;
      this.twists[i] = this.twists[i + 1]!;
    }

    // 末尾へ新ノードを追加。位置は概算でよく、次フレームの拘束で収束する。
    const last = this.positions[n - 2]!;
    const lastPrev = this.prevPositions[n - 2]!;
    const vel = sub(last, lastPrev); // 前のノードの速度ベクトルを引き継いで自然に延長
    const newLast = v3(last.x + vel.x + MAG_BELT_PITCH, last.y + vel.y, last.z + vel.z);
    this.positions[n - 1] = newLast;
    this.prevPositions[n - 1] = (newLast); // 新末尾は追加直後は速度ゼロ
    this.twists[n - 1] = this.twists[n - 2]!;
  }

  // ベルトのたわみを解く。軌道上は自由落下なので重力ではたわまず、機体自身の推力加速度と
  // スピンが生む慣性力(並進慣性 -a、遠心力 -ω×(ω×r)、オイラー力 -α×r、コリオリ力 -2ω×v)
  // だけがベルトを機体座標系の中で揺らす。
  public update(dt: number, att: Attitude, thrustAccelVec: Vec3, beltFeed: number): void {
    const invDt = dt > 1e-6 ? 1 / dt : 0;
    this.estimateAngularAccel(att.w, invDt);

    const aThrustShip = qRotate(qInvert(att.q), thrustAccelVec);
    this.integrateVerlet(dt, att.w, aThrustShip);

    this.pinRootToAnchor(beltFeed);
    this.relaxDistanceConstraints();

    this.advanceOrientationConstraints(dt, att, beltFeed);
  }

  // 前フレームとの角速度差から角加速度を推定する。
  private estimateAngularAccel(w: Vec3, invDt: number): void {
    this.angularAccel = v3((w.x - this.prevShipW.x) * invDt, (w.y - this.prevShipW.y) * invDt, (w.z - this.prevShipW.z) * invDt);
    this.prevShipW = (w);
  }

  // 各節点の位置を擬似力込みで Verlet 積分する。
  private integrateVerlet(dt: number, w: Vec3, aThrustShip: Vec3): void {
    const h = Math.min(dt, 0.05); // 積分刻みの上限(大きな dt でのはみ出し防止)
    const damping = 0.99; // 慣性を維持しつつ、毎ステップ速度を1%減衰させる
    const invDt = dt > 1e-6 ? 1 / dt : 0;
    // コリオリ力 -2ω×v の係数: vel = pos-prevPos = v*dt なので速度への変換に 2/dt を使う。
    // (2/h ではなく実際の dt を使わないと dt > 0.05 のときコリオリ力が過大になる。)
    const inv2Dt = invDt * 2;

    for (let i = 0; i < this.linkCount; i++) {
      const pos = this.positions[i]!;
      const vel = sub(pos, this.prevPositions[i]!); // 前フレームの変位(Verlet の速度相当)

      // 擬似力による加速度: -a_thrust - α×r - ω×(ω×r) - 2ω×v
      const euler = cross(this.angularAccel, pos);
      const centrifugal = cross(w, cross(w, pos));
      const coriolis = scale(cross(w, vel), inv2Dt);
      const accel = v3(
        -aThrustShip.x - euler.x - centrifugal.x - coriolis.x,
        -aThrustShip.y - euler.y - centrifugal.y - coriolis.y,
        -aThrustShip.z - euler.z - centrifugal.z - coriolis.z,
      );

      this.prevPositions[i] = pos;
      this.positions[i] = addScaled(addScaled(pos, vel, damping), accel, h * h);
    }
  }

  // アンカーを給弾進みに応じて更新し、根本(リンク0)を固定する
  private pinRootToAnchor(beltFeed: number): void {
    this.anchorValue = v3(MAG_BELT_ANCHOR_X - beltFeed * MAG_BELT_PITCH, 0, 0);

    const root = v3(this.anchorValue.x + MAG_BELT_PITCH, this.anchorValue.y, this.anchorValue.z);
    this.positions[0] = root;
    this.prevPositions[0] = (root);
  }

  // 数回反復して各リンク間隔を MAG_BELT_PITCH に収束させる
  private relaxDistanceConstraints(): void {
    const n = this.linkCount;
    for (let iter = 0; iter < 6; iter++) {
      for (let i = 0; i < n; i++) {
        const a = i === 0 ? this.anchorValue : this.positions[i - 1]!;
        const b = this.positions[i]!;
        const delta = sub(b, a);
        const dist = len(delta);
        if (dist < 1e-6) continue;
        const corr = scale(delta, (dist - MAG_BELT_PITCH) / dist);
        if (i <= 1) {
          // 参照点(アンカーまたは根本)は固定なので b 側だけ補正する。
          this.positions[i] = sub(b, corr);
        } else {
          this.positions[i] = addScaled(b, corr, -0.5);
          this.positions[i - 1] = addScaled(a, corr, 0.5);
        }
      }
    }
  }

  // つなぎ目ごとにピッチ/ヨーの角度上限を課して節点位置へ書き戻し、併せてねじれ角を進める。
  // 根本から2番目のつなぎ目は、次にリンク0へ昇格する前に直立させるため feed に応じて上限を0へ絞る。
  private advanceOrientationConstraints(dt: number, att: Attitude, feed: number): void {
    const maxRoll = (MAG_CHAIN_MAX_ROLL_DEG * Math.PI) / 180;
    const maxPitchRad = (MAG_CHAIN_MAX_PITCH_DEG * Math.PI) / 180;
    const maxYawRad = (MAG_CHAIN_MAX_YAW_DEG * Math.PI) / 180;
    const secondLinkNarrowing = clamp(1 - feed, 0, 1);
    const rollLerp = Math.min(1, dt * MAG_CHAIN_ROLL_RATE);
    let prevPoint = this.anchorValue;
    let prevQ: Quat = Q_IDENTITY; // アンカー(機体)側の基準姿勢: ベルトは+X方向へ伸びる
    let prevTwist = att.w.z * MAG_CHAIN_ROLL_GAIN; // ねじれの発生源: 機体のロール角速度

    for (let i = 0; i < this.linkCount; i++) {
      const rawDir = sub(this.positions[i]!, prevPoint);
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
        const oldPos = this.positions[i]!;
        this.prevPositions[i] = add(this.prevPositions[i]!, sub(newPos, oldPos));
        this.positions[i] = newPos;

        const localX = qRotate(prevQ, LOCAL_RIGHT); // 前リンクの進行方向(ワールド)
        bendQ = qMul(qFromUnitVectors(localX, clampedDir), prevQ); // 曲げぶんの最小回転を合成
      }

      prevTwist = this.advanceTwist(i, prevTwist, maxRoll, rollLerp);
      prevQ = bendQ;
      prevPoint = this.positions[i]!;
    }
  }

  // 前リンクのローカル座標系(+X = 進行方向)へ移し、横ずれ Y/X と上下ずれ Z/X をそれぞれ
  // tan(上限角度) でクランプして、再正規化のうえワールドへ戻す。
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
      this.twists[0] = 0;
      return prevTwist;
    }
    const target = clamp(prevTwist, -maxRoll, maxRoll);
    const twist = this.twists[i]! + (target - this.twists[i]!) * rollLerp;
    this.twists[i] = clamp(twist, -maxRoll, maxRoll);
    return this.twists[i]!;
  }

  // 節点ごとの接触代理。初回の contactSections で生成し、以後は使い回す。
  private readonly sections: BeltSection[] = [];

  // 各節点の機体座標系での位置・速度をワールド KinematicState に変換し、衝突判定用の
  // プロキシ配列を返す。t は接触代理の KinematicState.t に使う現在時刻(掃引判定の区間を成す)。
  // 返す配列と代理は呼び出しをまたいで同じもので、状態だけが書き換わる。
  public contactSections(t: number, dt: number, baseR: Vec3, baseV: Vec3, att: Attitude): BeltSection[] {
    const invDt = 1 / dt;
    for (const [i, bp] of this.positions.entries()) {
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
      if (section === undefined) this.sections.push(new BeltSection(this.owner, world));
      else section.state = world;
    }
    return this.sections;
  }

  // 衝突解決後のワールド状態を機体座標系の節点位置・速度へ書き戻す。
  public applyContactSections(dt: number, baseR: Vec3, baseV: Vec3, att: Attitude): void {
    const qInv = qInvert(att.q);
    for (const [i, s] of this.sections.entries()) {
      const bpLocal = qRotate(qInv, sub(s.state.r, baseR));
      const bodyVel = qRotate(qInv, sub(s.state.v, baseV));
      const verletVel = sub(bodyVel, cross(att.w, bpLocal));

      // Verlet は前後2つの位置で速度を表すので、速度は前フレーム位置へ畳んで返す。
      this.positions[i] = bpLocal;
      this.prevPositions[i] = v3(
        bpLocal.x - verletVel.x * dt,
        bpLocal.y - verletVel.y * dt,
        bpLocal.z - verletVel.z * dt,
      );
    }
  }
}
