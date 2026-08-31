// 与えられた加速度による RK4 積分の器(ケプラーの二体問題の解析式込み)、天体の2次重力場に
// よる摂動、および一質点にかかる全加速度(重力 + 2次重力場 + 大気抵抗 + 推力)の合成の
// 唯一の定義箇所。THREE/DOM 非依存の純関数。
import type { CelestialMotion } from './celestial-motion';
import type { Degree2Gravity } from './celestial-body-def';
import { attractorAccel } from './attractor';
import { KinematicState, kinematicState } from './kinematic-state';
import { dragAccel } from './atmosphere';
import { sunlitFactor } from './shadow';
import { srpAccel } from './srp';
import { Vec3, add, cross, dot, sub, v3 } from '../math/vec3';

// 状態(位置・速度)から加速度を返すコールバック。RK4 の各中間段(k1〜k4)ごとに、その段が
// 実際に評価されるべき絶対時刻 t とともに呼ばれる。RK4 が4次精度を持つのは非自励系
// y' = f(t, y) の各段をそれぞれ正しい時刻で評価したときに限られ、t を1点(例えばステップ
// 中点)へ凍結して自励系として解くと求積が中点則相当に落ち、大域誤差が O(h²) の2次へ
// 退化する — 重力源が動く系(天体が段の間に位置を変える)では t を無視できない。
type AccelFn = (t: number, rx: number, ry: number, rz: number, vx: number, vy: number, vz: number) => Vec3;

// 天体の2次重力場による摂動加速度。rRel はその天体の中心からの相対位置。
// J2(極方向の扁平)は軌道面に非対称なトルクを与えて昇交点を歳差させ、C22(赤道断面の
// 楕円性)は主軸座標系の長軸まわりに2回対称な経度依存を加える。
export function degree2Accel(rRel: Vec3, mu: number, g: Degree2Gravity): Vec3 {
  const r2 = rRel.x * rRel.x + rRel.y * rRel.y + rRel.z * rRel.z;
  if (r2 < 1) return v3();
  const rl = Math.sqrt(r2);
  const inv5 = 1 / (r2 * r2 * rl);
  const muR2 = mu * g.refRadius * g.refRadius;

  // J2: a = k[(1 − 5u²)r + 2(r·p̂)p̂], u = (r·p̂)/|r|
  const z = dot(rRel, g.pole);
  const k = -1.5 * g.j2 * muR2 * inv5;
  const f = 1 - (5 * z * z) / r2;
  let ax = k * (rRel.x * f + 2 * z * g.pole.x);
  let ay = k * (rRel.y * f + 2 * z * g.pole.y);
  let az = k * (rRel.z * f + 2 * z * g.pole.z);

  // C22: ポテンシャル 3·C22·μ·R²·(x² − y²)/|r|⁵ の勾配。x̂ は長軸、ŷ = p̂ × x̂。
  if (g.tesseral !== null) {
    const xHat = g.tesseral.longAxis;
    const yHat = cross(g.pole, xHat);
    const x = dot(rRel, xHat);
    const y = dot(rRel, yHat);
    const a2 = 3 * g.tesseral.c22 * muR2 * inv5;
    const radial = (-5 * (x * x - y * y)) / r2;
    ax += a2 * (2 * x * xHat.x - 2 * y * yHat.x + radial * rRel.x);
    ay += a2 * (2 * x * xHat.y - 2 * y * yHat.y + radial * rRel.y);
    az += a2 * (2 * x * xHat.z - 2 * y * yHat.z + radial * rRel.z);
  }

  return v3(ax, ay, az);
}

// 加速度コールバック accel だけを使って RK4 で 1 ステップ積分する。
// 入力 s は書き換えず、時刻も dt だけ進めた新しい KinematicState を返す。
export function stepRK4(s: KinematicState, dt: number, accel: AccelFn): KinematicState {
  const r0x = s.r.x, r0y = s.r.y, r0z = s.r.z;
  const v0x = s.v.x, v0y = s.v.y, v0z = s.v.z;
  const h2 = dt / 2;
  const h6 = dt / 6;

  const tMid = s.t + h2;

  // k1
  const kr1x = v0x, kr1y = v0y, kr1z = v0z;
  const a1 = accel(s.t, r0x, r0y, r0z, v0x, v0y, v0z);
  const kv1x = a1.x, kv1y = a1.y, kv1z = a1.z;

  // k2
  const r2x = r0x + kr1x * h2, r2y = r0y + kr1y * h2, r2z = r0z + kr1z * h2;
  const v2x = v0x + kv1x * h2, v2y = v0y + kv1y * h2, v2z = v0z + kv1z * h2;
  const kr2x = v2x, kr2y = v2y, kr2z = v2z;
  const a2 = accel(tMid, r2x, r2y, r2z, v2x, v2y, v2z);
  const kv2x = a2.x, kv2y = a2.y, kv2z = a2.z;

  // k3
  const r3x = r0x + kr2x * h2, r3y = r0y + kr2y * h2, r3z = r0z + kr2z * h2;
  const v3x = v0x + kv2x * h2, v3y = v0y + kv2y * h2, v3z = v0z + kv2z * h2;
  const kr3x = v3x, kr3y = v3y, kr3z = v3z;
  const a3 = accel(tMid, r3x, r3y, r3z, v3x, v3y, v3z);
  const kv3x = a3.x, kv3y = a3.y, kv3z = a3.z;

  // k4
  const r4x = r0x + kr3x * dt, r4y = r0y + kr3y * dt, r4z = r0z + kr3z * dt;
  const v4x = v0x + kv3x * dt, v4y = v0y + kv3y * dt, v4z = v0z + kv3z * dt;
  const kr4x = v4x, kr4y = v4y, kr4z = v4z;
  const a4 = accel(s.t + dt, r4x, r4y, r4z, v4x, v4y, v4z);
  const kv4x = a4.x, kv4y = a4.y, kv4z = a4.z;

  return kinematicState<'eci'>(
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

// 全天体からの重力(Σ attractorAccel — ECI が非慣性系であることの補正込み)と、2次重力場を
// 持つ天体ぶんのその摂動、大気抵抗、太陽輻射圧。t は accel を評価すべき絶対時刻(RK4 の各段
// の時刻)で、重力項(質点・2次重力場とも)は天体位置を pivot からその時刻へ外挿してから
// 評価する — 距離の3乗で効く重力はステップ幅ぶんの天体の移動が精度を左右するため。
// 日照率と輻射圧の太陽方向だけは pivot に据え置く: 遮蔽の幾何と 1AU 先の太陽方向は
// ステップ内での天体の移動にほとんど左右されない。
function totalAccel(
  t: number,
  r: Vec3,
  v: Vec3,
  attractors: readonly CelestialMotion[],
  occluders: readonly CelestialMotion[],
  atmosphereBody: CelestialMotion | null,
  pivot: number,
  bcInv: number,
  srpCoeff: number,
  dt: number,
): Vec3 {
  let ax = 0, ay = 0, az = 0;
  for (const attractor of attractors) {
    const g = attractorAccel(r, attractor, pivot, t);
    ax += g.x; ay += g.y; az += g.z;
    // 2次重力場は天体中心からの相対位置で評価する(質点重力と違い ECI 原点基準では組めない)。
    const degree2 = attractor.degree2At(pivot);
    if (degree2 !== null) {
      const b = attractor.positionAt(pivot, t);
      const d2 = degree2Accel(v3(r.x - b.x, r.y - b.y, r.z - b.z), attractor.def.mu, degree2);
      ax += d2.x; ay += d2.y; az += d2.z;
    }
    // 恒星ぶんの輻射圧をすべて加算する(恒星0個なら寄与0)。
    if (attractor.kind === 'star' && srpCoeff !== 0) {
      const sunlit = sunlitFactor(r, attractor, occluders, pivot);
      const srp = srpAccel(r, attractor, pivot, srpCoeff, sunlit);
      ax += srp.x; ay += srp.y; az += srp.z;
    }
  }
  const atmosphere = atmosphereBody === null ? null : atmosphereBody.atmosphereAt(pivot);
  if (atmosphereBody === null || atmosphere === null) return v3(ax, ay, az);
  // 抗力はその天体の中心を基準に測る。天体位置は重力項と同じくこの段の時刻へ外挿する。
  const atmosphereState = atmosphereBody.stateAt(pivot);
  const b = atmosphereBody.positionAt(pivot, t);
  const drag = dragAccel(
    v3(r.x - b.x, r.y - b.y, r.z - b.z), sub(v, atmosphereState.v), bcInv, atmosphere, dt,
  );
  return v3(ax + drag.x, ay + drag.y, az + drag.z);
}

// 全天体重力 + 2次重力場 + 大気抵抗 + 太陽輻射圧 + 推力の RK4 1ステップ。attractors はこの
// ステップぶん呼び出し側が確定させた重力源一覧、occluders は日照率だけに使う遮蔽体一覧
// (重力の絞り込みとは別の関心事なので別の引数で受け取る)。atmosphereBody は抗力を及ぼす
// **ただ1体**の大気天体で、null なら抗力は恒等的にゼロ。pivot は天体一式を厳密に引いた時刻。
export function stepDynamics(
  state: KinematicState,
  dt: number,
  attractors: readonly CelestialMotion[],
  occluders: readonly CelestialMotion[],
  atmosphereBody: CelestialMotion | null,
  pivot: number,
  bcInv: number,
  srpCoeff: number,
  thrust: Vec3 | null,
): KinematicState {
  return stepRK4(state, dt, (t, rx, ry, rz, vx, vy, vz) => {
    const a = totalAccel(
      t, v3(rx, ry, rz), v3(vx, vy, vz), attractors, occluders, atmosphereBody,
      pivot, bcInv, srpCoeff, dt);
    return thrust ? add(a, thrust) : a;
  });
}
