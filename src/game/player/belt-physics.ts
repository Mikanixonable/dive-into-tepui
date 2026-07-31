// マガジンベルトの物理演算(Verlet 積分 + 距離拘束によるチェーンのたわみ・ねじれ)専用の
// 算術モジュール。position/orientation は physics/vec3・physics/attitude の Vec3/Quat のみで
// 表現する(THREE への変換・メッシュ反映は belt.ts の責務)。下記の BeltSection だけは
// GameEntity の要求上 THREE.Object3D を1つ必要とするが、描画には使わない。
import * as THREE from 'three/webgpu';
import { Attitude, Quat, qFromUnitVectors, qInvert, qMul, qRotate } from '../../physics/attitude';
import { orbitState } from '../../physics/orbital';
import { Vec3, add, addScaled, cross, len, norm, scale, sub, v3 } from '../../physics/vec3';
import { MAG_BELT_ANCHOR_X, MAG_BELT_PITCH } from '../../render/ships';
import * as C from '../const';
import { GameEntity } from '../game-entity/game-entity';

// ベルトが機体座標系でたわみなく伸びる基準方向(不変)。belt.ts の姿勢導出でも
// 同じ基準を使うためエクスポートする。
export const X_AXIS: Vec3 = v3(1, 0, 0);
const IDENTITY_Q: Quat = { x: 0, y: 0, z: 0, w: 1 }; // アンカー(機体)側の基準姿勢

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

// マガジンベルトのリンク節点を剛体接触に参加させるためのプロキシ。BeltPhysics が生成・保持し、
// 機体座標系の Verlet 状態(beltPos/beltPrevPos)と state(ワールド ECI)の相互変換も
// BeltPhysics 側が担う(利用範囲がベルト内部に閉じるため、他の GameEntity 派生と違いここで定義する)。
export class BeltSection extends GameEntity {
  constructor(readonly beltIndex: number) {
    super(orbitState(0, v3(), v3()), new THREE.Object3D());
    this.mass = 5;
    this.collideRadius = 0.8;
  }
}

export class BeltPhysics {
  // ベルトのたわみは物理演算(Verlet 積分 + 距離拘束)で行う。位置は機体座標系
  // (機体原点基準)。無重力(自由落下軌道)なので重力そのものは効かず、
  // 自機の推力加速度とスピン(角速度・角加速度)による慣性力(擬似力)だけが
  // ベルトを揺らす。
  // 機体座標系の節点位置(belt.ts が姿勢導出に読む。要素の再代入は本クラス内のみ)。
  readonly beltPos: Vec3[] = [];
  private readonly beltPrevPos: Vec3[] = [];
  private beltInit = false;
  // 各リンクのチェーン軸まわりのねじれ角 [rad](機関銃ベルト同様、上下方向の
  // 折れ曲がりは距離拘束のみで自由に許容する一方、ロールはここで角度上限を掛けて
  // 制限する)。機体のロール角速度を発生源に、リンクからリンクへ位相遅れつつ
  // 伝播させ、常に ±MAG_CHAIN_MAX_ROLL_DEG に収まるよう追従・クランプする。
  readonly beltTwist: number[] = [];

  private prevBodyW = v3(); // 前フレームの機体角速度(ベルト物理の角加速度推定用)
  private angularAccel = v3(); // 推定した機体角加速度(update() 内で使い回す)
  // 給弾進みに応じて動く根本の固定点(機体座標系)。belt.ts が姿勢導出の起点として読む。
  anchor: Vec3 = v3(MAG_BELT_ANCHOR_X, 0, 0);

  constructor(private readonly linkCount: number) {}

  shiftBeltNodes(): void {
    const n = this.linkCount;
    if (n < 2) return;

    // ノードを 1 つ前詰め (i=0 は消費済みマガジン、破棄)
    for (let i = 0; i < n - 1; i++) {
      this.beltPos[i] = this.beltPos[i + 1]!;
      this.beltPrevPos[i] = this.beltPrevPos[i + 1]!;
      this.beltTwist[i] = this.beltTwist[i + 1]!;
    }

    // 末尾に新ノードを追加(前の末尾から +X 方向へ PITCH 分延長)。
    // このノードは直後に beltCount が 1 減って非表示になるので、
    // 位置精度はどうでもよい(次フレームで距離拘束に収束する)。
    const last = this.beltPos[n - 2]!;
    const lastPrev = this.beltPrevPos[n - 2]!;
    const vel = sub(last, lastPrev); // 前のノードの速度ベクトルを引き継いで自然に延長
    const newLast = v3(last.x + vel.x + MAG_BELT_PITCH, last.y + vel.y, last.z + vel.z);
    this.beltPos[n - 1] = newLast;
    this.beltPrevPos[n - 1] = (newLast); // 新末尾は追加直後は速度ゼロ
    this.beltTwist[n - 1] = this.beltTwist[n - 2]!;
  }

  // マガジンベルトのたわみを物理演算(Verlet 積分 + 距離拘束)で解く。
  // 軌道上は自由落下(無重力)なので、通常の重力によるたわみは発生しない。
  // 代わりに、機体自身の推力加速度(並進)とスピン(角速度・角加速度)が
  // 生む慣性力(擬似力)——並進慣性 -a、遠心力 -ω×(ω×r)、オイラー力 -α×r、
  // コリオリ力 -2ω×v——だけがベルトを機体座標系の中で揺らす。
  // ベルトは「接合部で連結されているが曲げられる」チェーンとして、各リンクの
  // 節点を距離拘束(剛体棒)でつなぐ position-based dynamics で表現する。
  update(dt: number, att: Attitude, thrustAccelVec: Vec3, beltFeed: number): void {
    this.initNodesOnce();

    const invDt = dt > 1e-6 ? 1 / dt : 0;

    // 機体の角加速度を前フレームとの差分から推定(body-frame ω の差分)
    this.estimateAngularAccel(att.w, invDt);

    // 推力加速度をワールド→機体座標系へ変換(擬似力は加速度と逆向き)
    const aThrustBody = qRotate(qInvert(att.q), thrustAccelVec);

    // 擬似力による加速度で各節点を Verlet 積分
    this.integrateVerlet(dt, att.w, aThrustBody);

    // 距離拘束(剛体棒): 先頭はベルトの給弾進みに応じて動くアンカーに固定
    this.pinRootToAnchor(beltFeed);
    this.relaxDistanceConstraints();

    // つなぎ目のピッチ/ヨークランプ(節点位置を補正)とロールねじれの積分
    this.advanceOrientationConstraints(dt, att);
  }

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

  private estimateAngularAccel(w: Vec3, invDt: number): void {
    this.angularAccel = v3((w.x - this.prevBodyW.x) * invDt, (w.y - this.prevBodyW.y) * invDt, (w.z - this.prevBodyW.z) * invDt);
    this.prevBodyW = (w);
  }

  private integrateVerlet(dt: number, w: Vec3, aThrustBody: Vec3): void {
    const h = Math.min(dt, 0.05); // 積分刻みの上限(大きな dt でのはみ出し防止)
    const damping = 0.95; // 慣性を維持するため減衰を弱める
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
        -aThrustBody.x - euler.x - centrifugal.x - coriolis.x,
        -aThrustBody.y - euler.y - centrifugal.y - coriolis.y,
        -aThrustBody.z - euler.z - centrifugal.z - coriolis.z,
      );

      this.beltPrevPos[i] = pos;
      this.beltPos[i] = addScaled(addScaled(pos, vel, damping), accel, h * h);
    }
  }

  // アンカーを給弾進みに応じて更新し、根本(リンク0)を固定する
  private pinRootToAnchor(beltFeed: number): void {
    this.anchor = v3(MAG_BELT_ANCHOR_X - beltFeed * MAG_BELT_PITCH, 0, 0);

    // 根本(リンク0)は常に機体に対して垂直(ローカル+X方向)になるよう、
    // 揺動物理を経由させずアンカーから固定距離・固定方向の位置に毎フレーム
    // 強制する(速度もゼロにして慣性ドリフトを止める)。これにより根本の
    // 接合部は常に垂直のまま、リンク1以降だけが自由に揺れる。
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
          // i===0: 参照点はアンカー(固定)。i===1: 参照点は根本(beltPos[0]、
          // 常に垂直固定)。どちらも a 側は動かさず b 側だけ補正する。
          this.beltPos[i] = sub(b, corr);
        } else {
          this.beltPos[i] = addScaled(b, corr, -0.5);
          this.beltPos[i - 1] = addScaled(a, corr, 0.5);
        }
      }
    }
  }

  // つなぎ目ごとに許容するピッチ/ヨーの角度上限を tan クランプで適用し、
  // クランプ後の方向を beltPos/beltPrevPos へ書き戻す(節点位置そのものを補正する
  // ————— よって物理状態の更新であり、update() 側の責務)。曲げ量を求める
  // ための平行移動(parallel transport)フレーム(prevQ)はクランプの基準にのみ
  // 使い、ここでは保持しない(belt.ts の姿勢導出が改めて算出する)。
  // 併せて、機体のロール角速度を発生源とするねじれ角(beltTwist)もここで積分する。
  private advanceOrientationConstraints(dt: number, att: Attitude): void {
    const maxRoll = (C.MAG_CHAIN_MAX_ROLL_DEG * Math.PI) / 180;
    // tan(最大角度) = ローカル座標系での横ずれ/前進量の上限
    const tanMaxPitch = Math.tan((C.MAG_CHAIN_MAX_YAW_DEG * Math.PI) / 180);
    const tanMaxYaw = Math.tan((C.MAG_CHAIN_MAX_PITCH_DEG * Math.PI) / 180);
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

        // クランプ後の方向を「前点 + クランプ済み方向 × MAG_BELT_PITCH」として書き戻し、
        // 物理とビジュアルを一致させる(次フレームの Verlet 積分にも反映)。
        // 長さに実長ではなく距離拘束の目標長を使うのは、prevPoint がこのループ内で
        // 既に補正済みの節点だから — 補正で伸びた実長をそのまま採用すると、誤差が
        // リンクを下るごとに掛け算で増幅し、数フレームで Infinity/NaN へ発散する。
        // 【重要】beltPrevPos も同量だけ平行移動して Verlet の速度 (pos - prevPos) を保つ。
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

  // 前リンクのローカル座標系(+X = 進行方向)に変換し、Y 成分(ヨー方向の横ずれ)と
  // Z 成分(ピッチ方向の上下ずれ)をそれぞれ tan(上限角度) でクランプする。
  // 「X 成分 = 1 固定でロジカルに考えると tan θ = 横ずれ/前進量」となるので、
  // 正規化ベクトルをローカル系に変換後 X を基準に Y/X と Z/X をクランプし、
  // 再正規化してワールドへ戻す。
  private clampDirectionToPrevFrame(dirWorld: Vec3, prevQ: Quat, tanMaxPitch: number, tanMaxYaw: number): Vec3 {
    const local = qRotate(qInvert(prevQ), dirWorld);
    // local.x は cos(折れ角) ≈ 1(小角度近似で正のはず)。ゼロ割を避けるため最低 0.001 に制限。
    const lx = Math.max(local.x, 0.001);
    const clampedLocal = norm(v3(lx, clamp(local.y, -tanMaxYaw * lx, tanMaxYaw * lx), clamp(local.z, -tanMaxPitch * lx, tanMaxPitch * lx)));
    return qRotate(prevQ, clampedLocal);
  }

  // beltTwist[i] を更新し、次リンクへ位相遅れつつ伝播させるシード値を返す
  private advanceTwist(i: number, prevTwist: number, maxRoll: number, rollLerp: number): number {
    if (i === 0) {
      // 根本はロール方向も含めて完全固定(ねじれ0)。伝播用シード(prevTwist)
      // は機体のロール角速度由来のまま変えず、ねじれはリンク1から始める。
      this.beltTwist[0] = 0;
      return prevTwist;
    }
    // ねじれ角を目標へ追従させつつ ±maxRoll にクランプ(常に上限内)
    const target = clamp(prevTwist, -maxRoll, maxRoll);
    const twist = this.beltTwist[i]! + (target - this.beltTwist[i]!) * rollLerp;
    this.beltTwist[i] = clamp(twist, -maxRoll, maxRoll);
    return this.beltTwist[i]!;
  }

  // ---- 剛体接触 (collision.ts) との受け渡し -------------------------------
  // beltPos/beltPrevPos は機体座標系の Verlet 状態なので、接触解決には
  // ワールド ECI の位置・速度へ変換した BeltSection プロキシ(リンクごとに
  // 永続保持)を渡し、解決後に applyCollisionSections で逆変換して書き戻す。
  // 衝突がなければこの往復は恒等変換になり、Verlet 状態は変化しない。
  private readonly sections: BeltSection[] = [];

  collisionSections(dt: number, baseR: Vec3, baseV: Vec3, att: Attitude): BeltSection[] {
    while (this.sections.length < this.beltPos.length) {
      this.sections.push(new BeltSection(this.sections.length));
    }
    const invDt = 1 / dt;
    for (const s of this.sections) {
      const bp = this.beltPos[s.beltIndex]!;
      const bpPrev = this.beltPrevPos[s.beltIndex]!;
      const v_verlet = v3((bp.x - bpPrev.x) * invDt, (bp.y - bpPrev.y) * invDt, (bp.z - bpPrev.z) * invDt);
      const v_tangential = cross(att.w, bp);
      const v_body_total = add(v_verlet, v_tangential);

      s.state = orbitState(
        s.state.t,
        add(baseR, qRotate(att.q, bp)),
        add(baseV, qRotate(att.q, v_body_total)),
      );
    }
    return this.sections;
  }

  applyCollisionSections(dt: number, baseR: Vec3, baseV: Vec3, att: Attitude): void {
    const qInv = qInvert(att.q);
    for (const s of this.sections) {
      const bpLocal = qRotate(qInv, sub(s.state.r, baseR));
      const v_body_total = qRotate(qInv, sub(s.state.v, baseV));
      const v_tangential = cross(att.w, bpLocal);
      const v_verlet = sub(v_body_total, v_tangential);

      this.beltPos[s.beltIndex] = bpLocal;
      this.beltPrevPos[s.beltIndex] = v3(
        bpLocal.x - v_verlet.x * dt,
        bpLocal.y - v_verlet.y * dt,
        bpLocal.z - v_verlet.z * dt,
      );
    }
  }
}
