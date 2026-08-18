// 重力傾斜トルク。中心天体の重力が機体の各部に及ぼす力の差が、慣性主軸の分布に応じて
// 生む姿勢トルクを与える。慣性主軸の等しい機体では消え、細長い機体ほど強く働く。
import { Quat, qInvert, qRotate } from './attitude';
import { Vec3, lenSq, v3 } from './vec3';

// 重力傾斜トルクを機体座標系で返す。rRel は中心天体から機体へ向かう相対位置(ECI [m])、
// mu はその天体の重力定数 [m^3/s^2]、principalInertia は機体座標系の主慣性モーメント
// (対角成分 [kg·m^2])、q は機体座標系 → ワールドの姿勢。中心天体と機体が重なる位置では
// 向きが定まらないため v3() を返す。
export function gravityGradientTorque(rRel: Vec3, mu: number, principalInertia: Vec3, q: Quat): Vec3 {
  const r2 = lenSq(rRel);
  if (r2 <= 0 || !Number.isFinite(r2)) return v3();

  // 天底方向を機体座標系へ移し、そこで慣性テンソルを掛ける。
  const r = Math.sqrt(r2);
  const nadirBody = qRotate(qInvert(q), v3(rRel.x / r, rRel.y / r, rRel.z / r));
  const ix = principalInertia.x * nadirBody.x;
  const iy = principalInertia.y * nadirBody.y;
  const iz = principalInertia.z * nadirBody.z;

  // τ = 3(μ/r^3)(r̂ × I r̂)
  const k = (3 * mu) / (r2 * r);
  return v3(
    k * (nadirBody.y * iz - nadirBody.z * iy),
    k * (nadirBody.z * ix - nadirBody.x * iz),
    k * (nadirBody.x * iy - nadirBody.y * ix),
  );
}
