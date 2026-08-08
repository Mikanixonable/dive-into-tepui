// 与えられた加速度による RK4 積分の器(ケプラーの二体問題の解析式込み)、地球 J2 摂動、
// および一質点にかかる全加速度(重力 + J2 + 大気抵抗 + 推力)の合成。
// ゲーム本体(game-entity/game-entity.ts)と軌道計画(plan/plan-arc.ts)の積分が共有する
// 唯一の定義箇所。THREE/DOM 非依存の純関数。
import { Attractor, attractorAccel } from './attractor';
import { MU_EARTH, KinematicState, R_EARTH_EQ, kinematicState } from './kinematic-state';
import { dragAccel } from './atmosphere';
import { Vec3, add, v3 } from './vec3';

// 状態(位置・速度)から加速度を返すコールバック。RK4 の各中間段(k1〜k4)ごとに呼ばれる。
type AccelFn = (rx: number, ry: number, rz: number, vx: number, vy: number, vz: number) => Vec3;

const J2_EARTH = 1.08262668e-3; // 地球扁平の J2 項

// J2(地球扁平)摂動加速度。極軸 = Y。
// 軌道面に非対称なトルクを与え、昇交点の歳差(LEO 51.6° で約 -5°/日)を生む。
export function j2Accel(r: Vec3): Vec3 {
  const r2 = r.x * r.x + r.y * r.y + r.z * r.z;
  const rl = Math.sqrt(r2);
  const k = (-1.5 * J2_EARTH * MU_EARTH * R_EARTH_EQ * R_EARTH_EQ) / (r2 * r2 * rl); // /r^5
  const f = (5 * r.y * r.y) / r2;
  return v3(k * r.x * (1 - f), k * r.y * (3 - f), k * r.z * (1 - f));
}

// 加速度コールバック accel だけを使って RK4 で 1 ステップ積分する。
// 入力 s は書き換えず、時刻も dt だけ進めた新しい KinematicState を返す。
export function stepRK4(s: KinematicState, dt: number, accel: AccelFn): KinematicState {
  const r0x = s.r.x, r0y = s.r.y, r0z = s.r.z;
  const v0x = s.v.x, v0y = s.v.y, v0z = s.v.z;
  const h2 = dt / 2;
  const h6 = dt / 6;

  // k1
  const kr1x = v0x, kr1y = v0y, kr1z = v0z;
  const a1 = accel(r0x, r0y, r0z, v0x, v0y, v0z);
  const kv1x = a1.x, kv1y = a1.y, kv1z = a1.z;

  // k2
  const r2x = r0x + kr1x * h2, r2y = r0y + kr1y * h2, r2z = r0z + kr1z * h2;
  const v2x = v0x + kv1x * h2, v2y = v0y + kv1y * h2, v2z = v0z + kv1z * h2;
  const kr2x = v2x, kr2y = v2y, kr2z = v2z;
  const a2 = accel(r2x, r2y, r2z, v2x, v2y, v2z);
  const kv2x = a2.x, kv2y = a2.y, kv2z = a2.z;

  // k3
  const r3x = r0x + kr2x * h2, r3y = r0y + kr2y * h2, r3z = r0z + kr2z * h2;
  const v3x = v0x + kv2x * h2, v3y = v0y + kv2y * h2, v3z = v0z + kv2z * h2;
  const kr3x = v3x, kr3y = v3y, kr3z = v3z;
  const a3 = accel(r3x, r3y, r3z, v3x, v3y, v3z);
  const kv3x = a3.x, kv3y = a3.y, kv3z = a3.z;

  // k4
  const r4x = r0x + kr3x * dt, r4y = r0y + kr3y * dt, r4z = r0z + kr3z * dt;
  const v4x = v0x + kv3x * dt, v4y = v0y + kv3y * dt, v4z = v0z + kv3z * dt;
  const kr4x = v4x, kr4y = v4y, kr4z = v4z;
  const a4 = accel(r4x, r4y, r4z, v4x, v4y, v4z);
  const kv4x = a4.x, kv4y = a4.y, kv4z = a4.z;

  return kinematicState(
    s.t + dt,
    v3(
      r0x + h6 * (kr1x + kr4x + 2 * (kr2x + kr3x)),
      r0y + h6 * (kr1y + kr4y + 2 * (kr2y + kr3y)),
      r0z + h6 * (kr1z + kr4z + 2 * (kr2z + kr3z))
    ),
    v3(
      v0x + h6 * (kv1x + kv4x + 2 * (kv2x + kv3x)),
      v0y + h6 * (kv1y + kv4y + 2 * (kv2y + kv3y)),
      v0z + h6 * (kv1z + kv4z + 2 * (kv2z + kv3z))
    )
  );
}

// 全天体からの重力(Σ attractorAccel — ECI が非慣性系であることの補正込み)+ J2 + 大気抵抗。
function totalAccel(r: Vec3, v: Vec3, attractors: readonly Attractor[], bcInv: number): Vec3 {
  let ax = 0, ay = 0, az = 0;
  for (const attractor of attractors) {
    const g = attractorAccel(r, attractor);
    ax += g.x; ay += g.y; az += g.z;
  }
  const j2 = j2Accel(r);
  const drag = dragAccel(r, v, bcInv);
  return v3(ax + j2.x + drag.x, ay + j2.y + drag.y, az + j2.z + drag.z);
}

// 全天体重力 + J2 + 大気抵抗 + 推力の RK4 1ステップ。attractors はこのステップぶん呼び出し側が
// 確定させた重力源一覧(Ephemeris.attractorsAt)。bcInv/thrust は種別ごとに異なるため
// 引数で受け取り、モジュール内に既定値を持たない。
export function stepDynamics(state: KinematicState, dt: number, attractors: readonly Attractor[], bcInv: number, thrust: Vec3 | null): KinematicState {
  return stepRK4(state, dt, (rx, ry, rz, vx, vy, vz) => {
    const a = totalAccel(v3(rx, ry, rz), v3(vx, vy, vz), attractors, bcInv);
    return thrust ? add(a, thrust) : a;
  });
}
