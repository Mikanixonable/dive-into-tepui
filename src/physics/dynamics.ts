// 一質点にかかる全加速度(重力 + J2 + 大気抵抗 + 推力)の合成と RK4 1ステップ。
// ゲーム本体(game-entity/game-entity.ts)と軌道計画(plan/plan-arc.ts)の積分が共有する
// 唯一の定義箇所。THREE/DOM 非依存の純関数。
import { Attractor, gravityAccel } from './attractor';
import { OrbitState, j2Accel, stepOrbitRK4 } from './orbital';
import { dragAccel } from './atmosphere';
import { Vec3, add, sub, v3 } from './vec3';

const ORIGIN = v3(0, 0, 0);

// 全天体からの重力(originAccel を引いて ECI が非慣性系であることを補正済み)+ J2 + 大気抵抗。
function accel(r: Vec3, v: Vec3, bodies: readonly Attractor[], originAccel: Vec3, bcInv: number): Vec3 {
  const gravity = sub(gravityAccel(r, bodies), originAccel);
  return add(add(gravity, j2Accel(r)), dragAccel(r, v, bcInv));
}

// 全天体重力 + J2 + 大気抵抗 + 推力の RK4 1ステップ。bodies はこのステップぶん呼び出し側が
// 確定させた重力源一覧(Ephemeris.attractorsAt)。原点天体自身の加速度(gravityAccel(0,
// bodies))はステップ内で定数なので、4段の外で1回だけ評価する。bcInv/thrust は種別ごとに
// 異なるため引数で受け取り、モジュール内に既定値を持たない。
export function stepDynamicsRK4(state: OrbitState, dt: number, bodies: readonly Attractor[], bcInv: number, thrust: Vec3 | null): OrbitState {
  const originAccel = gravityAccel(ORIGIN, bodies);
  return stepOrbitRK4(state, dt, (rx, ry, rz, vx, vy, vz) => {
    const a = accel(v3(rx, ry, rz), v3(vx, vy, vz), bodies, originAccel, bcInv);
    return thrust ? add(a, thrust) : a;
  });
}
