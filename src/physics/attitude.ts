// 剛体姿勢力学: クォータニオン + 機体座標系角速度をオイラーの運動方程式で積分。
// 非対称な慣性主軸を与えると中間軸まわりの回転が不安定化し、
// ジャニベコフ効果(デブリの周期的な反転)が自然に現れる。
import { Vec3, add, addScaled, len, scale, v3 } from '../math/vec3';
import { Quat, qMul, qNormalize, qFromAxisAngle, qInvert, qRotate, qFromForwardUp } from '../math/quat';

export interface Attitude {
  readonly q: Quat; // 機体座標系 → ワールドの回転
  readonly w: Vec3; // 機体座標系での角速度 [rad/s]
  readonly inertia: Vec3; // 主慣性モーメント(対角、相対値でよい)
}

const ATT_MAX_SUB_DT = 0.04; // 姿勢積分の最大刻み [s]
// 姿勢LODの計算量上限。通常物理域(最大dt=0.1s×warp4=0.4s)は10step以内なので
// 全区間をRK4、高warpだけ最大0.48sの剛体力学＋残時間coastになる。
export const ATT_MAX_DYNAMIC_STEPS = 12;

// オイラーの運動方程式(主軸系): I ω̇ = (I ω) × ω + τ
function eulerRates(I: Vec3, w: Vec3, tq: Vec3): Vec3 {
  return v3(
    (tq.x + (I.y - I.z) * w.y * w.z) / I.x,
    (tq.y + (I.z - I.x) * w.z * w.x) / I.y,
    (tq.z + (I.x - I.y) * w.x * w.y) / I.z,
  );
}

// 主慣性モーメント I と角速度 w から回転運動エネルギーを求める。
function kineticEnergy(I: Vec3, w: Vec3): number {
  return 0.5 * (I.x * w.x * w.x + I.y * w.y * w.y + I.z * w.z * w.z);
}

// トルク(機体座標系)を与えて姿勢を dt 進めた新しい Attitude を返す(att は書き換えない)。
// ジャイロ項は単純な前進オイラーだと発散するため ω を RK4 で積分し、
// トルクなしの場合は回転運動エネルギーを保存するよう射影して
// 長時間タンブリングしても |ω| が有界に留まるようにする。
export function stepAttitude(att: Attitude, torque: Vec3, dt: number): Attitude {
  const I = att.inertia;
  const torqueFree =
    torque.x === 0 && torque.y === 0 && torque.z === 0;
  let w = att.w;
  let q = att.q;
  // 剛体のω変化は一定数までRK4で解き、極端なwarpの残時間は最後のωによるcoastとして進める。
  let remaining = dt;
  let dynamicSteps = 0;
  while (remaining > 1e-9) {
    const wMag = len(w);
    // 高速回転ほど刻みを細かく(ω·h ≲ 0.25 rad)
    const h = Math.min(remaining, ATT_MAX_SUB_DT, wMag > 1e-6 ? 0.25 / wMag : ATT_MAX_SUB_DT);
    remaining -= h;
    dynamicSteps++;

    const e0 = kineticEnergy(I, w);
    const k1 = eulerRates(I, w, torque);
    const k2 = eulerRates(I, addScaled(w, k1, h / 2), torque);
    const k3 = eulerRates(I, addScaled(w, k2, h / 2), torque);
    const k4 = eulerRates(I, addScaled(w, k3, h), torque);

    const wOld = w;
    w = v3(
      w.x + (h / 6) * (k1.x + 2 * k2.x + 2 * k3.x + k4.x),
      w.y + (h / 6) * (k1.y + 2 * k2.y + 2 * k3.y + k4.y),
      w.z + (h / 6) * (k1.z + 2 * k2.z + 2 * k3.z + k4.z),
    );

    // エネルギー射影(トルクなしの剛体は T = ½ωᵀIω が厳密に保存される)
    if (torqueFree && e0 > 1e-12) {
      const e1 = kineticEnergy(I, w);
      if (e1 > 1e-12) w = scale(w, Math.sqrt(e0 / e1));
    }

    // 機体座標系の角速度なので右から乗算: q ← q ⊗ Δq(ω̄ h)
    const avg = scale(add(wOld, w), 0.5);
    const aMag = len(avg);
    if (aMag > 1e-12) {
      const dq = qFromAxisAngle(scale(avg, 1 / aMag), aMag * h);
      q = qNormalize(qMul(q, dq));
    }

    if (dynamicSteps >= ATT_MAX_DYNAMIC_STEPS && remaining > 1e-9) {
      const coastMag = len(w);
      if (coastMag > 1e-12) {
        const coastAngle = (coastMag * remaining) % (Math.PI * 2);
        q = qNormalize(qMul(q, qFromAxisAngle(scale(w, 1 / coastMag), coastAngle)));
      }
      remaining = 0;
    }
  }
  return { q, w, inertia: I };
}

// 現在姿勢 q を目標 forward/up へ合わせるための誤差回転。angle は [-π, π]、axisBody は
// 機体座標系での回転軸(単位ベクトル)。目標が特異(fwd と up がほぼ平行)なら null。
export function attitudeAlignError(desiredFwd: Vec3, desiredUp: Vec3, q: Quat): { angle: number; axisBody: Vec3 } | null {
  const qDesired = qFromForwardUp(desiredFwd, desiredUp);
  if (!qDesired) return null;
  const qCurInv = qInvert(q);
  // ワールド系での誤差回転: qCurrent を qDesired へ重ねる回転
  const qErr = qMul(qDesired, qCurInv);
  const w = Math.max(-1, Math.min(1, qErr.w));
  let angle = 2 * Math.acos(w);
  if (angle > Math.PI) angle -= 2 * Math.PI;
  const s = Math.sqrt(Math.max(0, 1 - w * w));
  const axisWorld = s > 1e-6 ? v3(qErr.x / s, qErr.y / s, qErr.z / s) : v3(1, 0, 0);
  const axisBody = qRotate(qCurInv, axisWorld);
  return { angle, axisBody };
}

// desiredFwd/desiredUp へ機首を向けるPD制御トルクをボディフレームで返す。kp/kd は呼び出し側の
// ゲイン(physics/ は game/ の調整値に依存しないため引数で受け取る)。特異姿勢(desiredFwd と
// desiredUp が平行)なら制御せず v3() を返す。
export function attitudeAlignTorque(
  desiredFwd: Vec3, desiredUp: Vec3, att: Attitude, kp: number, kd: number,
): Vec3 {
  const err = attitudeAlignError(desiredFwd, desiredUp, att.q);
  if (!err) return v3();
  const { angle, axisBody } = err;
  const I = att.inertia;
  return v3(
    (kp * angle * axisBody.x - kd * att.w.x) * I.x,
    (kp * angle * axisBody.y - kd * att.w.y) * I.y,
    (kp * angle * axisBody.z - kd * att.w.z) * I.z,
  );
}
