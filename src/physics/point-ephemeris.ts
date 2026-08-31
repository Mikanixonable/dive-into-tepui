// 1つの**点**の暦。天体本体とは限らない — 暦は id ごとに天体そのものか、その天体を含む
// 惑星系の重心かを収録していて(EphemerisPointKind)、同梱パックでは 11 件のうち 6 件
// (mars/jupiter/saturn/uranus/neptune/pluto)が系の重心。どの点のものかは、この値を保持
// している側(CelestialMotion か PlanetSystem)が決める。
import { KinematicState } from './kinematic-state';

// 暦が id ごとに収録している点。天体そのものの中心か、その天体を含む惑星系の重心か。
// **1つの暦の中で id ごとに違いうる** — JPL の SPK は地球と月を本体まで分解する一方、
// 火星以遠は系の重心しか持たないため。
export type EphemerisPointKind = 'body' | 'systemBarycenter';

export interface PointEphemeris {
  // この点を答えられる simTime の範囲。点ごとに異なりうる。
  readonly validStartSimTime: number;
  readonly validEndSimTime: number;

  // 太陽系重心中心・ゲーム ECI 軸の位置・速度。範囲外の simTime を渡すと例外。
  stateAt(simTime: number): KinematicState<'packed'>;
}

// 結ばれた暦が答える位置・速度。結ばれていない・有効期間の外では null。
export function boundStateAt(ephemeris: PointEphemeris | null, t: number): KinematicState<'packed'> | null {
  if (ephemeris === null) return null;
  if (t < ephemeris.validStartSimTime || t > ephemeris.validEndSimTime) return null;
  return ephemeris.stateAt(t);
}

// 暦が収録している点の一覧。key は天体 id、kind はその id が本体か惑星系の重心か。
// **供給源はこの形へ解決してから渡す** — 天体1体ぶんへの切り出しは構築時に1度で済み、
// 引く側が id と種別で2度問い合わせる必要も無くなる。id が載っていなければ未収録。
export type EphemerisPoints = ReadonlyMap<string, EphemerisPoint>;

export type EphemerisPoint = {
  readonly kind: EphemerisPointKind;
  readonly ephemeris: PointEphemeris;
};

// id が期待した種別で収録されているときだけ、その暦を返す。**種別が食い違えば null** —
// 系の重心の系列を惑星本体へ結ぶと、その系がまるごと重心オフセットぶんずれる
// (木星系で 68 km、冥王星系で 2,128 km)。
export function ephemerisPointOf(
  points: EphemerisPoints, id: string, kind: EphemerisPointKind,
): PointEphemeris | null {
  const point = points.get(id);
  return point !== undefined && point.kind === kind ? point.ephemeris : null;
}
