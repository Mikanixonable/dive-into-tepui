// 掃引接触判定の実験(exp10 / exp11)が共有する区間の組み立て。
// 1区間は「両球が dt を渡る間の始点と終点の状態」と「その間の真の最接近距離」からなる。
// 真値は同じ運動を N 分割で積んだ経路から取り、粗い1歩の端点にはその積分の端点をそのまま使う
// — 測りたいのは端点を結ぶ近似の誤差であって、粗い RK4 の積分誤差ではない。
import { CelestialBody } from '../../src/physics/celestial-body';
import {
  SweptSphereContact, curveSphereContact, linearSphereContact,
} from '../../src/physics/sphere-contact';
import { stepDynamics } from '../../src/physics/dynamics';
import { KinematicState, kinematicState } from '../../src/physics/kinematic-state';
import { Atmosphere } from '../../src/physics/atmosphere';
import { MU_EARTH, MU_MOON, R_EARTH_EQ, R_MOON } from '../../src/game/celestial/solar-system/constants';
import { EARTH_ATMOSPHERE } from '../../src/game/celestial/solar-system/earth-system';
import { Vec3, add, len, sub, v3 } from '../../src/math/vec3';

const G = 6.674e-11;
// 密度 2000 kg/m³ の小天体。表面すれすれの円軌道の周期は密度だけで決まる。
const SMALL_RADIUS = 50e3;

function body(id: string, mu: number, radius: number, atmosphere: Atmosphere | null = null): CelestialBody {
  return {
    id, mu, radius, state: kinematicState(0, v3(), v3()), accel: v3(),
    degree2: null, atmosphere, isStar: false,
  };
}

export const EARTH = body('earth', MU_EARTH, R_EARTH_EQ);
export const EARTH_AIR = body('earth', MU_EARTH, R_EARTH_EQ,
  { ...EARTH_ATMOSPHERE, pole: v3(0, 0, 1) });
export const MOON = body('moon', MU_MOON, R_MOON);
export const SMALL = body('small', G * (4 / 3) * Math.PI * SMALL_RADIUS ** 3 * 2000, SMALL_RADIUS);

// 1歩を進める規則。区間の真値を積むときも、粗い1歩の端点を出すときも同じものを使う。
export type Advance = (s: KinematicState, dt: number) => KinematicState;

export function freeFall(central: CelestialBody): Advance {
  return (s, dt) => stepDynamics(s, dt, [central], [], null, 0, 0, null);
}

export function withDrag(central: CelestialBody, bcInv: number): Advance {
  return (s, dt) => stepDynamics(s, dt, [central], [], central, bcInv, 0, null);
}

export function withThrust(central: CelestialBody, thrust: Vec3): Advance {
  return (s, dt) => stepDynamics(s, dt, [central], [], null, 0, 0, thrust);
}

export const still: Advance = (s, dt) => kinematicState(s.t + dt, s.r, s.v);

// 判定にかける1区間。radiusSum は費用の計測で使う代表値で、精度の計測では二分探索で動かす。
export interface Sweep {
  readonly label: string;
  readonly aStart: KinematicState;
  readonly aEnd: KinematicState;
  readonly bStart: KinematicState;
  readonly bEnd: KinematicState;
  readonly radiusSum: number;
  readonly trueMin: number;
}

// 測る対象の3つの解法。production は sweptSphereContact(= 三次)しか通らないが、
// 次数を落とす調整の余地を測るために、ここでは実体を直接叩く。
export type Solver = '弦' | '二次' | '三次';

export const SOLVERS: readonly Solver[] = ['弦', '二次', '三次'];

export function solve(
  s: Sweep, solver: Solver, radiusSum: number,
): SweptSphereContact | null {
  return solver === '弦'
    ? linearSphereContact(s.aStart, s.aEnd, s.bStart, s.bEnd, radiusSum)
    : curveSphereContact(s.aStart, s.aEnd, s.bStart, s.bEnd, radiusSum, solver === '二次' ? 2 : 3);
}

const TRUE_STEPS = 4000;

export function sweepOf(
  label: string, a0: KinematicState, b0: KinematicState, dt: number,
  advanceA: Advance, advanceB: Advance, radiusSum: number,
): Sweep {
  let a = a0;
  let b = b0;
  let trueMin = len(sub(b0.r, a0.r));
  for (let i = 0; i < TRUE_STEPS; i++) {
    a = advanceA(a, dt / TRUE_STEPS);
    b = advanceB(b, dt / TRUE_STEPS);
    trueMin = Math.min(trueMin, len(sub(b.r, a.r)));
  }
  return { label, aStart: a0, aEnd: a, bStart: b0, bEnd: b, radiusSum, trueMin };
}

// 中心天体を原点に静止させた相手として置く区間。
export function againstBody(
  label: string, central: CelestialBody, a0: KinematicState, dt: number, advanceA: Advance,
): Sweep {
  return sweepOf(label, a0, kinematicState(a0.t, central.state.r, v3()), dt,
    advanceA, still, central.radius);
}

// 表面から alt の円軌道上の状態。x 軸上に置き、y 方向へ回る。
export function circular(central: CelestialBody, alt: number): KinematicState {
  const r = central.radius + alt;
  return kinematicState(0, v3(r, 0, 0), v3(0, Math.sqrt(central.mu / r), 0));
}

// 半径 r の円軌道の周期。刻みを「1周あたり何歩か」で指定するための基準。
export function circularPeriod(central: CelestialBody, r: number): number {
  return 2 * Math.PI * Math.sqrt(r ** 3 / central.mu);
}

// 近点 rp・離心率 e の軌道で、区間の割合 frac の位置に近点が来るように始点を戻した状態。
export function beforePerigee(
  central: CelestialBody, rp: number, e: number, dt: number, frac: number,
): KinematicState {
  const atPerigee = kinematicState(0, v3(rp, 0, 0), v3(0, Math.sqrt(central.mu * (1 + e) / rp), 0));
  const back = freeFall(central);
  let s = atPerigee;
  for (let i = 0; i < TRUE_STEPS; i++) s = back(s, -(dt * frac) / TRUE_STEPS);
  return kinematicState(0, s.r, s.v);
}

// 基準の軌道から offset だけずらし、速度を relSpeed だけ加えた相手。
export function companion(base: KinematicState, offset: Vec3, relV: Vec3): KinematicState {
  return kinematicState(base.t, add(base.r, offset), add(base.v, relV));
}
