// 円制限三体問題のラグランジュ点。共線点 γ の求解と、回転系での5点の無次元座標、および
// 5点それぞれが力学的に意味を持つかの判定。
import { qRotate } from './attitude';
import type { CelestialBody } from './celestial-body';
import type { OrbitingMotion } from './celestial-motion';
import type { FrameRotation } from './kepler-orbit';
import { KinematicState, kinematicState } from './kinematic-state';
import { Vec3, add, cross, len, sub, v3 } from '../math/vec3';

// L4/L5 が線形安定でいられる質量比 mu = m2/(m1+m2) の上限(Routh/Gascheau の基準)。
// 27mu(1−mu) < 1 の解で、同値な表現は m1/m2 > (25+3√69)/2 ≈ 24.96。
export const TRIANGULAR_STABILITY_MASS_RATIO = (27 - Math.sqrt(621)) / 54;

export type LagrangePoints = {
  readonly L1: Vec3;
  readonly L2: Vec3;
  readonly L3: Vec3;
  readonly L4: Vec3;
  readonly L5: Vec3;
};

// 共線点の、最も近い天体からの距離(軌道半径比 gamma)。L1/L2 は副天体から、L3 は主天体から
// 測る。回転系での釣り合いはどれも gamma の5次方程式になり、閉じた形では解けないので
// Newton 法で解く — L1/L2 の初期値である Hill 半径 (mu/3)^(1/3) は地球-月系で真の解から
// 5%(約 5,000 km)ずれるため、反復して詰める。
export function collinearGamma(mu: number, point: 'L1' | 'L2' | 'L3'): number {
  if (point === 'L3') return collinearGammaL3(mu);
  const sign = point === 'L1' ? -1 : 1;
  let g = Math.cbrt(mu / 3);
  for (let i = 0; i < 40; i++) {
    // L1: g^5 -(3-mu)g^4 +(3-2mu)g^3 -mu g^2 +2mu g -mu = 0
    // L2: g^5 +(3-mu)g^4 +(3-2mu)g^3 -mu g^2 -2mu g -mu = 0
    const f = g ** 5 + sign * (3 - mu) * g ** 4 + (3 - 2 * mu) * g ** 3
      - mu * g * g - sign * 2 * mu * g - mu;
    const df = 5 * g ** 4 + sign * 4 * (3 - mu) * g ** 3 + 3 * (3 - 2 * mu) * g * g
      - 2 * mu * g - sign * 2 * mu;
    const step = f / df;
    g -= step;
    if (Math.abs(step) < 1e-15) break;
  }
  return g;
}

// L3 の主天体からの距離(軌道半径比)。一次の近似 1-(7/12)mu を初期値に5次方程式
// g^5 +(2+mu)g^4 +(1+2mu)g^3 -(1-mu)g^2 -2(1-mu)g -(1-mu) = 0 を Newton 法で解く。
function collinearGammaL3(mu: number): number {
  let g = 1 - (7 / 12) * mu;
  // 反復ごとに5次方程式とその導関数を評価し、修正量が丸め誤差に達したら止める。
  for (let i = 0; i < 40; i++) {
    const f = g ** 5 + (2 + mu) * g ** 4 + (1 + 2 * mu) * g ** 3
      - (1 - mu) * g * g - 2 * (1 - mu) * g - (1 - mu);
    const df = 5 * g ** 4 + 4 * (2 + mu) * g ** 3 + 3 * (1 + 2 * mu) * g * g
      - 2 * (1 - mu) * g - 2 * (1 - mu);
    const step = f / df;
    g -= step;
    if (Math.abs(step) < 1e-15) break;
  }
  return g;
}

// L4/L5 に秤動する軌道が存在するか。質量比がこの上限を超える系(冥王星-カロンのような
// 準二重惑星)では三角点は線形不安定で、そこへ置いた物体は留まらない。
export function hasStableTriangularPoints(mu: number): boolean {
  return mu < TRIANGULAR_STABILITY_MASS_RATIO;
}

// 共線点 L1 が副天体の表面からどれだけ離れているかを、副天体の半径を単位にして返す。
// 1 を下回れば L1 は副天体の内部にあり、行き先にもハロー軌道の中心にもならない。
export function collinearClearanceRatio(mu: number, orbitRadius: number, secondaryRadius: number): number {
  return (orbitRadius * collinearGamma(mu, 'L1')) / secondaryRadius;
}

// 円制限三体問題のラグランジュ点。5点はいずれも回転系(原点 = 主天体、x̂ = 副天体方向、
// ŷ = 副天体の公転前方)の固定点で、その無次元座標(軌道半径を 1 とする)は質量比
// mu = m2/(m1+m2) だけで決まる。それを ECI [m] へ移す写像 place を受け取って組み立てる。
export function lagrangePoints(mu: number, place: (x: number, y: number) => Vec3): LagrangePoints {
  const s60 = Math.sqrt(3) / 2;
  return {
    L1: place(1 - collinearGamma(mu, 'L1'), 0),
    L2: place(1 + collinearGamma(mu, 'L2'), 0),
    L3: place(-collinearGamma(mu, 'L3'), 0),
    L4: place(0.5, s60),
    L5: place(0.5, -s60),
  };
}

// 円制限三体問題の量(ラグランジュ点・共線点まわりの局所基底・ガイド軌道)を組むのに要る、
// ある時刻の副天体系。**位置はすべて ECI で、原点の解決は済んでいる** — この型を受け取る側は
// 天体暦にも ECI 原点にも触らない。
export type SecondaryFrame = {
  readonly secondary: CelestialBody; // 副天体の ECI 瞬間値
  readonly primary: CelestialBody; // 主天体の ECI 瞬間値
  readonly rotation: FrameRotation; // 副天体の公転回転基準系(x̂ = 主天体→副天体)
  readonly normal: Vec3; // 公転面法線(単位ベクトル、ECI)
};

// 同時刻の ECI 天体配列と副天体の運動から SecondaryFrame を組む。副天体に主天体が無い、
// または配列にどちらかが載っていなければ null。
export function secondaryFrameOf(
  bodies: readonly CelestialBody[], motion: OrbitingMotion, t: number,
): SecondaryFrame | null {
  const primaryId = motion.primary?.id;
  if (primaryId === undefined) return null;
  const secondary = bodies.find((b) => b.id === motion.id);
  const primary = bodies.find((b) => b.id === primaryId);
  if (secondary === undefined || primary === undefined) return null;
  return { secondary, primary, rotation: motion.orbitFrameRotationAt(t), normal: motion.orbitNormalAt(t) };
}

// 副天体を基準にした5点の ECI 位置。
export function lagrangePointsOf(frame: SecondaryFrame): LagrangePoints {
  const { secondary, primary } = frame;
  const R = len(sub(secondary.state.r, primary.state.r));
  const mu = secondary.mu / (primary.mu + secondary.mu);
  return lagrangePoints(mu, (x, y) => add(primary.state.r, qRotate(frame.rotation.q, v3(R * x, R * y, 0))));
}

// ラグランジュ点1点の ECI 状態。回転系の角速度 omega と主天体の速度から
// v = v_primary + omega × (r − r_primary) として合成する(5点とも同じ剛体回転系に乗って
// いるため omega は共通)。
export function lagrangeStateOf(point: keyof LagrangePoints, frame: SecondaryFrame): KinematicState {
  const { primary, rotation } = frame;
  const r = lagrangePointsOf(frame)[point];
  return kinematicState<'eci'>(
    frame.secondary.state.t, r,
    add(primary.state.v, cross(rotation.omega, sub(r, primary.state.r))),
  );
}
