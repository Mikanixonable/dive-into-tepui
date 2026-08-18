// 剛体姿勢力学: クォータニオン + 機体座標系角速度をオイラーの運動方程式で積分。
// 非対称な慣性を与えると中間軸まわりの回転が不安定化し、
// ジャニベコフ効果(デブリの周期的な反転)が自然に現れる。
import { Vec3, add, addScaled, cross, dot, len, lenSq, norm, scale, sub, v3 } from './vec3';
import type { InertiaTensor } from './inertia-tensor';
import { inertiaTimes, invertInertia, rotationalEnergy } from './inertia-tensor';

// Vec3 と同じく不変。姿勢を進めるときは新しい Quat / Attitude を作って差し替える。
export interface Quat {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly w: number;
}

export interface Attitude {
  readonly q: Quat; // 機体座標系 → ワールドの回転
  readonly w: Vec3; // 機体座標系での角速度 [rad/s]
  // 重心まわりの慣性テンソル [kg·m²]。機体座標系は慣性主軸系である必要がなく、慣性乗積を持って
  // よい — 形状から導いた機体はふつう持つ。
  readonly inertia: InertiaTensor;
}

// クォータニオンの積 a ⊗ b を返す。
export function qMul(a: Quat, b: Quat): Quat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

// クォータニオンを単位長へ正規化する。ノルムがほぼ0なら単位クォータニオンを返す。
export function qNormalize(q: Quat): Quat {
  const l = Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w);
  if (l < 1e-12) return { x: 0, y: 0, z: 0, w: 1 };
  return { x: q.x / l, y: q.y / l, z: q.z / l, w: q.w / l };
}

// 軸 axis(単位ベクトル)まわりに angle [rad] 回転するクォータニオンを作る。
export function qFromAxisAngle(axis: Vec3, angle: number): Quat {
  const h = angle / 2;
  const s = Math.sin(h);
  return { x: axis.x * s, y: axis.y * s, z: axis.z * s, w: Math.cos(h) };
}

// 単位クォータニオンの逆(共役)
export function qInvert(q: Quat): Quat {
  return { x: -q.x, y: -q.y, z: -q.z, w: q.w };
}

// a を b へ重ねる最小回転(a, b は単位ベクトル)
export function qFromUnitVectors(a: Vec3, b: Vec3): Quat {
  const d = dot(a, b);
  if (d > 1 - 1e-12) return { x: 0, y: 0, z: 0, w: 1 };
  if (d < -1 + 1e-6) {
    // ほぼ反平行: a と直交する任意軸まわりに 180° 回転
    let axis = cross(v3(1, 0, 0), a);
    if (lenSq(axis) < 1e-6) axis = cross(v3(0, 1, 0), a);
    return qFromAxisAngle(norm(axis), Math.PI);
  }
  const axis = cross(a, b);
  const s = Math.sqrt((1 + d) * 2);
  const invs = 1 / s;
  return { x: axis.x * invs, y: axis.y * invs, z: axis.z * invs, w: s * 0.5 };
}

// v_world = q ⊗ v ⊗ q*
export function qRotate(q: Quat, v: Vec3): Vec3 {
  const { x, y, z, w } = q;
  // t = 2 * (q_vec × v)
  const tx = 2 * (y * v.z - z * v.y);
  const ty = 2 * (z * v.x - x * v.z);
  const tz = 2 * (x * v.y - y * v.x);
  // v + w*t + q_vec × t
  return v3(
    v.x + w * tx + (y * tz - z * ty),
    v.y + w * ty + (z * tx - x * tz),
    v.z + w * tz + (x * ty - y * tx),
  );
}

// 機首方向(+Z)と上方向の基準(+Y)から姿勢クォータニオンを構築する。
// up は fwd と直交していなくてよい(再直交化する)。fwd と up がほぼ平行で
// 基底が定まらない(特異点)場合は null を返す。
export function qFromForwardUp(fwd: Vec3, up: Vec3): Quat | null {
  const z = norm(fwd);
  const xRaw = cross(norm(up), z);
  if (lenSq(xRaw) < 1e-9) return null;
  const x = norm(xRaw);
  const y = cross(z, x);
  // 列 (x, y, z) の回転行列 → クォータニオン(Shepperd 法: 最大対角成分で分岐)
  const m00 = x.x, m01 = y.x, m02 = z.x;
  const m10 = x.y, m11 = y.y, m12 = z.y;
  const m20 = x.z, m21 = y.z, m22 = z.z;
  const trace = m00 + m11 + m22;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    return { x: (m21 - m12) * s, y: (m02 - m20) * s, z: (m10 - m01) * s, w: 0.25 / s };
  }
  if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    return { x: 0.25 * s, y: (m01 + m10) / s, z: (m02 + m20) / s, w: (m21 - m12) / s };
  }
  if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    return { x: (m01 + m10) / s, y: 0.25 * s, z: (m12 + m21) / s, w: (m02 - m20) / s };
  }
  const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
  return { x: (m02 + m20) / s, y: (m12 + m21) / s, z: 0.25 * s, w: (m10 - m01) / s };
}

// 一様分布のランダムな回転クォータニオンを返す。rand は [0,1) の乱数生成器。
export function randomQuat(rand: () => number = Math.random): Quat {
  // Shoemake の一様ランダム回転
  const u1 = rand();
  const u2 = rand() * Math.PI * 2;
  const u3 = rand() * Math.PI * 2;
  const s1 = Math.sqrt(1 - u1);
  const s2 = Math.sqrt(u1);
  return {
    x: s1 * Math.sin(u2),
    y: s1 * Math.cos(u2),
    z: s2 * Math.sin(u3),
    w: s2 * Math.cos(u3),
  };
}

const ATT_MAX_SUB_DT = 0.04; // 姿勢積分の最大刻み [s]
// 姿勢LODの計算量上限。通常物理域(最大dt=0.1s×warp4=0.4s)は10step以内なので
// 全区間をRK4、高warpだけ最大0.48sの剛体力学＋残時間coastになる。
export const ATT_MAX_DYNAMIC_STEPS = 12;

// オイラーの運動方程式: I ω̇ = τ − ω × (I ω)。慣性主軸系に限らない一般の対称テンソルに対して
// 成り立つ形なので、逆テンソル invI を1度だけ求めておけば各段の評価は行列ベクトル積2回で済む。
// invI が null(特異な慣性テンソル)なら角加速度が定義できないので、ω を変えない。
function eulerRates(I: InertiaTensor, invI: InertiaTensor | null, w: Vec3, tq: Vec3): Vec3 {
  if (!invI) return v3();
  return inertiaTimes(invI, sub(tq, cross(w, inertiaTimes(I, w))));
}

// トルク(機体座標系)を与えて姿勢を dt 進めた新しい Attitude を返す(att は書き換えない)。
// ジャイロ項は単純な前進オイラーだと発散するため ω を RK4 で積分し、
// トルクなしの場合は回転運動エネルギーを保存するよう射影して
// 長時間タンブリングしても |ω| が有界に留まるようにする。
export function stepAttitude(att: Attitude, torque: Vec3, dt: number): Attitude {
  const I = att.inertia;
  const invI = invertInertia(I);
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

    const e0 = rotationalEnergy(I, w);
    const k1 = eulerRates(I, invI, w, torque);
    const k2 = eulerRates(I, invI, addScaled(w, k1, h / 2), torque);
    const k3 = eulerRates(I, invI, addScaled(w, k2, h / 2), torque);
    const k4 = eulerRates(I, invI, addScaled(w, k3, h), torque);

    const wOld = w;
    w = v3(
      w.x + (h / 6) * (k1.x + 2 * k2.x + 2 * k3.x + k4.x),
      w.y + (h / 6) * (k1.y + 2 * k2.y + 2 * k3.y + k4.y),
      w.z + (h / 6) * (k1.z + 2 * k2.z + 2 * k3.z + k4.z),
    );

    // エネルギー射影(トルクなしの剛体は T = ½ωᵀIω が厳密に保存される)
    if (torqueFree && e0 > 1e-12) {
      const e1 = rotationalEnergy(I, w);
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
// ゲイン(physics/ は game/const.ts に依存しないため引数で受け取る)。特異姿勢(desiredFwd と
// desiredUp が平行)なら制御せず v3() を返す。
export function attitudeAlignTorque(
  desiredFwd: Vec3, desiredUp: Vec3, att: Attitude, kp: number, kd: number,
): Vec3 {
  const err = attitudeAlignError(desiredFwd, desiredUp, att.q);
  if (!err) return v3();
  const { angle, axisBody } = err;
  // 角加速度の指令を慣性テンソルに掛けてトルクへ直す。慣性乗積があるとトルクの向きは指令の向きと
  // 一致しないが、生じる角加速度のほうは指令どおりになる。
  return inertiaTimes(att.inertia, v3(
    kp * angle * axisBody.x - kd * att.w.x,
    kp * angle * axisBody.y - kd * att.w.y,
    kp * angle * axisBody.z - kd * att.w.z,
  ));
}
