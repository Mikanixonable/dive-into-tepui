// マガジンベルトの物理演算(Verlet 積分 + 距離拘束によるチェーンのたわみ・ねじれ)。
import * as THREE from 'three/webgpu';
import { Attitude, Quat, qFromUnitVectors, qInvert, qMul, qRotate } from '../../physics/attitude';
import { kinematicState } from '../../physics/kinematic-state';
import { Vec3, add, addScaled, cross, len, norm, scale, sub, v3 } from '../../physics/vec3';
import { MAG_BELT_ANCHOR_X, MAG_BELT_PITCH } from '../../render/ships';
import * as C from '../const';
import { GameEntity } from '../game-entity/game-entity';
import type { Attractor } from '../../physics/attractor';

// ベルトが機体座標系でたわみなく伸びる基準方向。
export const X_AXIS: Vec3 = v3(1, 0, 0);
const IDENTITY_Q: Quat = { x: 0, y: 0, z: 0, w: 1 }; // アンカー(機体)側の基準姿勢

// v を [lo, hi] にクランプする。
function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

// ベルトのリンク節点を剛体接触に参加させるためのプロキシ。
export class BeltSection extends GameEntity {
  // 節点インデックス beltIndex に対応するプロキシを、吊り元の艦 owner とともに生成する。
  constructor(readonly beltIndex: number, private readonly owner: GameEntity) {
    super(kinematicState(0, v3(), v3()), new THREE.Object3D());
    this.mass = 5;
    this.radius = 0.8;
    this.collides = true;
    this.attachedTo = owner;
  }

  // 吊り元の艦、およびそれに取り付いた他の実体(ベルトの他節点・放熱板の折り)とは接触しない。
  contactsWith(other: GameEntity | Attractor): boolean {
    if (other === this.owner) return false;
    return !(other instanceof GameEntity && other.attachedTo === this.owner);
  }
}

export class BeltPhysics {
  // 機体座標系の節点位置。
  readonly beltPos: Vec3[] = [];
  private readonly beltPrevPos: Vec3[] = [];
  private beltInit = false;
  // 各リンクのチェーン軸まわりのねじれ角 [rad]。常に ±MAG_CHAIN_MAX_ROLL_DEG に収まる。
  readonly beltTwist: number[] = [];

  private prevShipW = v3(); // 前フレームの機体角速度(ベルト物理の角加速度推定用)
  private angularAccel = v3();
  // 給弾進みに応じて動く根本の固定点(機体座標系)。
  anchor: Vec3 = v3(MAG_BELT_ANCHOR_X, 0, 0);

  constructor(private readonly linkCount: number, private readonly owner: GameEntity) {}

  // リンクを1つ手前へ詰め、末尾に新しいリンクを継ぎ足す。
  shiftBeltNodes(): void {
    const n = this.linkCount;
    if (n < 2) return;

    // ノードを 1 つ前詰め (i=0 は消費済みマガジン、破棄)
    for (let i = 0; i < n - 1; i++) {
      this.beltPos[i] = this.beltPos[i + 1]!;
      this.beltPrevPos[i] = this.beltPrevPos[i + 1]!;
      this.beltTwist[i] = this.beltTwist[i + 1]!;
    }

    // 末尾へ新ノードを追加。直後に非表示になるので位置精度は問わない(次フレームで収束する)。
    const last = this.beltPos[n - 2]!;
    const lastPrev = this.beltPrevPos[n - 2]!;
    const vel = sub(last, lastPrev); // 前のノードの速度ベクトルを引き継いで自然に延長
    const newLast = v3(last.x + vel.x + MAG_BELT_PITCH, last.y + vel.y, last.z + vel.z);
    this.beltPos[n - 1] = newLast;
    this.beltPrevPos[n - 1] = (newLast); // 新末尾は追加直後は速度ゼロ
    this.beltTwist[n - 1] = this.beltTwist[n - 2]!;
  }

  // ベルトのたわみを解く。軌道上は自由落下なので重力ではたわまず、機体自身の推力加速度と
  // スピンが生む慣性力(並進慣性 -a、遠心力 -ω×(ω×r)、オイラー力 -α×r、コリオリ力 -2ω×v)
  // だけがベルトを機体座標系の中で揺らす。
  update(dt: number, att: Attitude, thrustAccelVec: Vec3, beltFeed: number): void {
    this.initNodesOnce();

    const invDt = dt > 1e-6 ? 1 / dt : 0;
    this.estimateAngularAccel(att.w, invDt);

    const aThrustShip = qRotate(qInvert(att.q), thrustAccelVec);
    this.integrateVerlet(dt, att.w, aThrustShip);

    this.pinRootToAnchor(beltFeed);
    this.relaxDistanceConstraints();

    this.advanceOrientationConstraints(dt, att);
  }

  // 初回のみ、節点をアンカーから等間隔に並べて初期化する。
  private initNodesOnce(): void {
    if (this.beltInit) return;
    this.beltInit = true;
    for (let i = 0; i < this.linkCount; i++) {
      const p = v3(MAG_BELT_ANCHOR_X + (i + 1) * MAG_BELT_PITCH, 0, 0);
      this.beltPos.push(p);
      this.beltPrevPos.push((p));
      this.beltTwist.push(0);
    }
  }

  // 前フレームとの角速度差から角加速度を推定する。
  private estimateAngularAccel(w: Vec3, invDt: number): void {
    this.angularAccel = v3((w.x - this.prevShipW.x) * invDt, (w.y - this.prevShipW.y) * invDt, (w.z - this.prevShipW.z) * invDt);
    this.prevShipW = (w);
  }

  // 各節点の位置を擬似力込みで Verlet 積分する。
  private integrateVerlet(dt: number, w: Vec3, aThrustShip: Vec3): void {
    const h = Math.min(dt, 0.05); // 積分刻みの上限(大きな dt でのはみ出し防止)
    const damping = 0.99; // 慣性を維持しつつ、毎ステップ2%だけ減衰させる
    const invDt = dt > 1e-6 ? 1 / dt : 0;
    // コリオリ力 -2ω×v の係数: vel = pos-prevPos = v*dt なので速度への変換に 2/dt を使う。
    // (2/h ではなく実際の dt を使わないと dt > 0.05 のときコリオリ力が過大になる。)
    const inv2Dt = invDt * 2;

    for (let i = 0; i < this.linkCount; i++) {
      const pos = this.beltPos[i]!;
      const vel = sub(pos, this.beltPrevPos[i]!); // 前フレームの変位(Verlet の速度相当)

      // 擬似力による加速度: -a_thrust - α×r - ω×(ω×r) - 2ω×v
      const euler = cross(this.angularAccel, pos);
      const centrifugal = cross(w, cross(w, pos));
      const coriolis = scale(cross(w, vel), inv2Dt);
      const accel = v3(
        -aThrustShip.x - euler.x - centrifugal.x - coriolis.x,
        -aThrustShip.y - euler.y - centrifugal.y - coriolis.y,
        -aThrustShip.z - euler.z - centrifugal.z - coriolis.z,
      );

      this.beltPrevPos[i] = pos;
      this.beltPos[i] = addScaled(addScaled(pos, vel, damping), accel, h * h);
    }
  }

  // アンカーを給弾進みに応じて更新し、根本(リンク0)を固定する
  private pinRootToAnchor(beltFeed: number): void {
    this.anchor = v3(MAG_BELT_ANCHOR_X - beltFeed * MAG_BELT_PITCH, 0, 0);

    const root = v3(this.anchor.x + MAG_BELT_PITCH, this.anchor.y, this.anchor.z);
    this.beltPos[0] = root;
    this.beltPrevPos[0] = (root);
  }

  // 数回反復して各リンク間隔を MAG_BELT_PITCH に収束させる
  private relaxDistanceConstraints(): void {
    const n = this.linkCount;
    for (let iter = 0; iter < 6; iter++) {
      for (let i = 0; i < n; i++) {
        const a = i === 0 ? this.anchor : this.beltPos[i - 1]!;
        const b = this.beltPos[i]!;
        const delta = sub(b, a);
        const dist = len(delta);
        if (dist < 1e-6) continue;
        const corr = scale(delta, (dist - MAG_BELT_PITCH) / dist);
        if (i <= 1) {
          // 参照点(アンカーまたは根本)は固定なので b 側だけ補正する。
          this.beltPos[i] = sub(b, corr);
        } else {
          this.beltPos[i] = addScaled(b, corr, -0.5);
          this.beltPos[i - 1] = addScaled(a, corr, 0.5);
        }
      }
    }
  }

  // つなぎ目ごとに許容するピッチ/ヨーの角度上限を tan クランプで適用し、クランプ後の方向を
  // beltPos/beltPrevPos へ書き戻す。併せてねじれ角(beltTwist)を積分する。
  private advanceOrientationConstraints(dt: number, att: Attitude): void {
    const maxRoll = (C.MAG_CHAIN_MAX_ROLL_DEG * Math.PI) / 180;
    // tan(最大角度) = ローカル座標系での横ずれ/前進量の上限
    const tanMaxPitch = Math.tan((C.MAG_CHAIN_MAX_PITCH_DEG * Math.PI) / 180);
    const tanMaxYaw = Math.tan((C.MAG_CHAIN_MAX_YAW_DEG * Math.PI) / 180);
    const rollLerp = Math.min(1, dt * C.MAG_CHAIN_ROLL_RATE);
    let prevPoint = this.anchor;
    let prevQ: Quat = IDENTITY_Q; // アンカー(機体)側の基準姿勢: ベルトは+X方向へ伸びる
    let prevTwist = att.w.z * C.MAG_CHAIN_ROLL_GAIN; // ねじれの発生源: 機体のロール角速度

    for (let i = 0; i < this.linkCount; i++) {
      const rawDir = sub(this.beltPos[i]!, prevPoint);
      const segLen = len(rawDir); // 方向を取り出すためだけの実長
      let bendQ = prevQ;
      if (segLen > 1e-6) {
        const clampedDir = this.clampDirectionToPrevFrame(scale(rawDir, 1 / segLen), prevQ, tanMaxPitch, tanMaxYaw);

        // 実長ではなく目標長 MAG_BELT_PITCH を使う: 実長は補正済み prevPoint からの誤差を増幅して NaN へ発散する。
        const newPos = addScaled(prevPoint, clampedDir, MAG_BELT_PITCH);
        const oldPos = this.beltPos[i]!;
        this.beltPrevPos[i] = add(this.beltPrevPos[i]!, sub(newPos, oldPos));
        this.beltPos[i] = newPos;

        const localX = qRotate(prevQ, X_AXIS); // 前リンクの進行方向(ワールド)
        bendQ = qMul(qFromUnitVectors(localX, clampedDir), prevQ); // 曲げぶんの最小回転を合成
      }

      prevTwist = this.advanceTwist(i, prevTwist, maxRoll, rollLerp);
      prevQ = bendQ;
      prevPoint = this.beltPos[i]!;
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

  // beltTwist[i] を更新し、次リンクへ位相遅れつつ伝播させるシード値を返す
  private advanceTwist(i: number, prevTwist: number, maxRoll: number, rollLerp: number): number {
    if (i === 0) {
      // 根本はねじれ 0 に固定し、伝播用シードはそのまま次リンクへ渡す。
      this.beltTwist[0] = 0;
      return prevTwist;
    }
    const target = clamp(prevTwist, -maxRoll, maxRoll);
    const twist = this.beltTwist[i]! + (target - this.beltTwist[i]!) * rollLerp;
    this.beltTwist[i] = clamp(twist, -maxRoll, maxRoll);
    return this.beltTwist[i]!;
  }

  private readonly sections: BeltSection[] = [];

  // 各節点の機体座標系での位置・速度をワールド KinematicState に変換し、衝突判定用の
  // プロキシ配列を返す。
  collisionSections(dt: number, baseR: Vec3, baseV: Vec3, att: Attitude): BeltSection[] {
    // プロキシを節点数まで拡張する
    while (this.sections.length < this.beltPos.length) {
      this.sections.push(new BeltSection(this.sections.length, this.owner));
    }
    const invDt = 1 / dt;
    for (const s of this.sections) {
      const bp = this.beltPos[s.beltIndex]!;
      const bpPrev = this.beltPrevPos[s.beltIndex]!;
      // 機体座標系での速度: Verlet変位による速度 + 機体回転による接線速度
      const v_verlet = v3((bp.x - bpPrev.x) * invDt, (bp.y - bpPrev.y) * invDt, (bp.z - bpPrev.z) * invDt);
      const v_tangential = cross(att.w, bp);
      const v_body_total = add(v_verlet, v_tangential);

      // ワールド座標系へ変換する
      s.state = kinematicState(
        s.state.t,
        add(baseR, qRotate(att.q, bp)),
        add(baseV, qRotate(att.q, v_body_total)),
      );
    }
    return this.sections;
  }

  // 衝突解決後のワールド状態を機体座標系の節点位置・速度へ書き戻す。
  applyCollisionSections(dt: number, baseR: Vec3, baseV: Vec3, att: Attitude): void {
    const qInv = qInvert(att.q);
    for (const s of this.sections) {
      // ワールド座標系から機体座標系へ変換する
      const bpLocal = qRotate(qInv, sub(s.state.r, baseR));
      const v_body_total = qRotate(qInv, sub(s.state.v, baseV));
      const v_tangential = cross(att.w, bpLocal);
      const v_verlet = sub(v_body_total, v_tangential);

      // Verlet 積分と整合する前フレーム位置へ戻す
      this.beltPos[s.beltIndex] = bpLocal;
      this.beltPrevPos[s.beltIndex] = v3(
        bpLocal.x - v_verlet.x * dt,
        bpLocal.y - v_verlet.y * dt,
        bpLocal.z - v_verlet.z * dt,
      );
    }
  }
}
