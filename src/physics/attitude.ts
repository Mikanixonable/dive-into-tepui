// 剛体姿勢力学: クォータニオン + 機体座標系角速度をオイラーの運動方程式で積分。
// 非対称な慣性主軸を与えると中間軸まわりの回転が不安定化し、
// ジャニベコフ効果(デブリの周期的な反転)が自然に現れる。
import { Vec3, v3 } from './vec3';

export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

export interface Attitude {
  q: Quat; // 機体座標系 → ワールドの回転
  w: Vec3; // 機体座標系での角速度 [rad/s]
  inertia: Vec3; // 主慣性モーメント(対角、相対値でよい)
}

export function qIdentity(): Quat {
  return { x: 0, y: 0, z: 0, w: 1 };
}

export function qMul(a: Quat, b: Quat): Quat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

export function qNormalize(q: Quat): void {
  const l = Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w);
  if (l < 1e-12) {
    q.x = 0;
    q.y = 0;
    q.z = 0;
    q.w = 1;
    return;
  }
  q.x /= l;
  q.y /= l;
  q.z /= l;
  q.w /= l;
}

export function qFromAxisAngle(axis: Vec3, angle: number): Quat {
  const h = angle / 2;
  const s = Math.sin(h);
  return { x: axis.x * s, y: axis.y * s, z: axis.z * s, w: Math.cos(h) };
}

// v_world = q ⊗ v ⊗ q*
export function qRotate(q: Quat, v: Vec3): Vec3 {
  const { x, y, z, w } = q;
  // t = 2 * (q_vec × v)
  const tx = 2 * (y * v.z - z * v.y);
  const ty = 2 * (z * v.x - x * v.z);
  const tz = 2 * (x * v.y - y * v.x);
  // v + w*t + q_vec × t
  return {
    x: v.x + w * tx + (y * tz - z * ty),
    y: v.y + w * ty + (z * tx - x * tz),
    z: v.z + w * tz + (x * ty - y * tx),
  };
}

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
const ATT_MAX_ITERS = 12;

// オイラーの運動方程式(主軸系): I ω̇ = (I ω) × ω + τ
function eulerRates(I: Vec3, w: Vec3, tq: Vec3): Vec3 {
  return v3(
    (tq.x + (I.y - I.z) * w.y * w.z) / I.x,
    (tq.y + (I.z - I.x) * w.z * w.x) / I.y,
    (tq.z + (I.x - I.y) * w.x * w.y) / I.z,
  );
}

function kineticEnergy(I: Vec3, w: Vec3): number {
  return 0.5 * (I.x * w.x * w.x + I.y * w.y * w.y + I.z * w.z * w.z);
}

// トルク(機体座標系)を与えて姿勢を dt 進める。
// ジャイロ項は単純な前進オイラーだと発散するため ω を RK4 で積分し、
// トルクなしの場合は回転運動エネルギーを保存するよう射影して
// 長時間タンブリングしても |ω| が有界に留まるようにする。
export function stepAttitude(att: Attitude, torque: Vec3, dt: number): void {
  const I = att.inertia;
  const torqueFree =
    torque.x === 0 && torque.y === 0 && torque.z === 0;
  let remaining = Math.min(dt, ATT_MAX_SUB_DT * ATT_MAX_ITERS);
  while (remaining > 1e-9) {
    const w = att.w;
    const wMag = Math.sqrt(w.x * w.x + w.y * w.y + w.z * w.z);
    // 高速回転ほど刻みを細かく(ω·h ≲ 0.25 rad)
    const h = Math.min(remaining, ATT_MAX_SUB_DT, wMag > 1e-6 ? 0.25 / wMag : ATT_MAX_SUB_DT);
    remaining -= h;

    const e0 = kineticEnergy(I, w);
    const k1 = eulerRates(I, w, torque);
    const w2 = v3(w.x + (k1.x * h) / 2, w.y + (k1.y * h) / 2, w.z + (k1.z * h) / 2);
    const k2 = eulerRates(I, w2, torque);
    const w3 = v3(w.x + (k2.x * h) / 2, w.y + (k2.y * h) / 2, w.z + (k2.z * h) / 2);
    const k3 = eulerRates(I, w3, torque);
    const w4 = v3(w.x + k3.x * h, w.y + k3.y * h, w.z + k3.z * h);
    const k4 = eulerRates(I, w4, torque);

    const wOld = v3(w.x, w.y, w.z);
    w.x += (h / 6) * (k1.x + 2 * k2.x + 2 * k3.x + k4.x);
    w.y += (h / 6) * (k1.y + 2 * k2.y + 2 * k3.y + k4.y);
    w.z += (h / 6) * (k1.z + 2 * k2.z + 2 * k3.z + k4.z);

    // エネルギー射影(トルクなしの剛体は T = ½ωᵀIω が厳密に保存される)
    if (torqueFree && e0 > 1e-12) {
      const e1 = kineticEnergy(I, w);
      if (e1 > 1e-12) {
        const s = Math.sqrt(e0 / e1);
        w.x *= s;
        w.y *= s;
        w.z *= s;
      }
    }

    // 機体座標系の角速度なので右から乗算: q ← q ⊗ Δq(ω̄ h)
    const ax = (wOld.x + w.x) / 2;
    const ay = (wOld.y + w.y) / 2;
    const az = (wOld.z + w.z) / 2;
    const aMag = Math.sqrt(ax * ax + ay * ay + az * az);
    if (aMag > 1e-12) {
      att.q = qMul(att.q, qFromAxisAngle(v3(ax / aMag, ay / aMag, az / aMag), aMag * h));
      qNormalize(att.q);
    }
  }
}
