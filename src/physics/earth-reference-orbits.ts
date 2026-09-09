// 軌道ガイドタブ「基本」群のうち、CR3BP の族を持たない地球専用の参照軌道(太陽同期準回帰・
// ドーンダスク・モルニヤ・ツンドラ)の軌道要素を組む。いずれも中心天体の重心を原点とした
// OrbitalElements を返し、実際の天体位置への配置は呼び出し側(orbit-guide.ts)が行う。
// 中心天体の重力・扁平・自転周期は呼び出し側から受け取る。
import type { CelestialMotion } from './celestial-motion';
import type { Degree2Gravity } from './celestial-body-def';
import {
  meanMotionFromSemiMajor, orbitalElementsFromClassical, semiMajorFromMeanMotion, semiMajorFromPeriod,
} from './elements';
import type { OrbitalElements } from './elements';
import { SECONDS_PER_DAY } from './time';

const TWO_PI = 2 * Math.PI;

// 太陽に対する昇交点の歳差が一致すべき角速度の基準となる回帰年 [s]。
const TROPICAL_YEAR_SEC = 365.2422 * SECONDS_PER_DAY;

// 臨界傾斜角(近地点引数の長期摂動が止まる傾斜角、cos²i = 1/5) [deg]。モルニヤ・ツンドラ軌道が使う。
const CRITICAL_INCLINATION_DEG = (Math.acos(1 / Math.sqrt(5)) * 180) / Math.PI;

interface SunSynchronousShape {
  readonly a: number;
  readonly incDeg: number;
}

// 回帰日数 repeatDays の間に revsPerRepeat 回中心天体を周回する太陽同期円軌道の形を解く。
// 実数の傾斜角が存在しない、または高度が地表以下なら null を返す。
function sunSynchronousShape(
  repeatDays: number,
  revsPerRepeat: number,
  mu: number,
  radius: number,
  degree2: Degree2Gravity | null,
): SunSynchronousShape | null {
  if (degree2 === null) return null;
  const n = (revsPerRepeat * TWO_PI) / (repeatDays * SECONDS_PER_DAY);
  const a = semiMajorFromMeanMotion(n, mu);
  if (a <= radius) return null; // 解の高度が地表以下(中心天体に埋まる非物理的な解)。
  const sunRate = TWO_PI / TROPICAL_YEAR_SEC;
  const precessionPerRad = -1.5 * n * degree2.j2 * (degree2.refRadius / a) ** 2;
  const cosInc = sunRate / precessionPerRad;
  if (!(cosInc >= -1 && cosInc <= 1)) return null;
  const incDeg = (Math.acos(cosInc) * 180) / Math.PI;
  return { a, incDeg };
}

// 回帰日数 repeatDays の間に revsPerRepeat 回中心天体を周回し、昇交点が太陽と
// 同じ角速度で歳差する円軌道の要素を組む。raanOffsetDeg は昇交点の初期位置
// (太陽方向を基準にした角度)。
function sunSynchronousElements(
  repeatDays: number, revsPerRepeat: number, raanOffsetDeg: number, planet: CelestialMotion, planetPivot: number,
): OrbitalElements | null {
  const shape = sunSynchronousShape(
    repeatDays,
    revsPerRepeat,
    planet.def.mu,
    planet.def.radius,
    planet.degree2At(planetPivot),
  );
  if (shape === null) return null;
  return orbitalElementsFromClassical(
    shape.a, 0, shape.incDeg, raanOffsetDeg, 0, planet, planet.stateAt(planetPivot));
}

// sunSynchronousElements が null を返す2つの境界(cosInc=-1・a=天体半径)を、それぞれ平均運動 n
// について解いた閉形式から求めた「1日あたり周回数」の範囲。repeatDays・revsPerRepeat 個々の値では
// なく、その比だけで決まる。HUD がスライダーの有効域を示すのに使う。j2 は equatorRadius を基準
// 半径とする2次帯球調和係数。
export function sunSyncRevsPerDayRange(
  mu: number, equatorRadius: number, j2: number,
): { readonly min: number; readonly max: number } {
  const sunRate = TWO_PI / TROPICAL_YEAR_SEC;
  // cosInc = -1(太陽同期条件の下限)。
  const nMin = ((sunRate * mu ** (2 / 3)) / (1.5 * j2 * equatorRadius ** 2)) ** (3 / 7);
  // a = equatorRadius(解の高度が地表に一致する上限)。
  const nMax = meanMotionFromSemiMajor(equatorRadius, mu);
  const revPerDay = (n: number) => (n * SECONDS_PER_DAY) / TWO_PI;
  return { min: revPerDay(nMin), max: revPerDay(nMax) };
}

// 太陽同期準回帰軌道。昇交点の絶対位置はガイド線の形に影響しないので 0° に固定する。
export function sunSyncRepeatGroundTrackElements(
  repeatDays: number, revsPerRepeat: number, planet: CelestialMotion, planetPivot: number,
): OrbitalElements | null {
  return sunSynchronousElements(repeatDays, revsPerRepeat, 0, planet, planetPivot);
}

export type LocalTime = 'dawn' | 'dusk';

// ドーンダスク軌道。昇交点の地方太陽時を朝(6時)・夕(18時)に置く太陽同期軌道。sunRaanDeg は
// その瞬間の太陽方向の昇交点赤経(呼び出し側が現在時刻の天体暦から求めて渡す)。
export function dawnDuskElements(
  repeatDays: number, revsPerRepeat: number, localTime: LocalTime, sunRaanDeg: number,
  planet: CelestialMotion, planetPivot: number,
): OrbitalElements | null {
  return sunSynchronousElements(
    repeatDays, revsPerRepeat, sunRaanDeg + (localTime === 'dawn' ? -90 : 90), planet, planetPivot);
}

// 傾斜角・近地点引数を臨界値(63.4°・270°)に固定し、周期 period から長半径を、近地点高度から
// 離心率を求める。モルニヤ・ツンドラ軌道はこの周期だけが異なる。
function criticalInclinationElements(
  perigeeAltitude: number, raanDeg: number, period: number, planet: CelestialMotion, planetPivot: number,
): OrbitalElements {
  const a = semiMajorFromPeriod(period, planet.def.mu);
  const e = 1 - (planet.def.radius + perigeeAltitude) / a;
  return orbitalElementsFromClassical(
    a, e, CRITICAL_INCLINATION_DEG, raanDeg, 270, planet, planet.stateAt(planetPivot));
}

// モルニヤ軌道: 周期は中心天体の自転周期 spinPeriod [s] の半分(1自転に2周)。
export function molniyaElements(
  perigeeAltitude: number, raanDeg: number, planet: CelestialMotion, planetPivot: number, spinPeriod: number,
): OrbitalElements {
  return criticalInclinationElements(perigeeAltitude, raanDeg, spinPeriod / 2, planet, planetPivot);
}

// ツンドラ軌道: 周期は中心天体の自転周期 spinPeriod [s](1自転に1周)。
export function tundraElements(
  perigeeAltitude: number, raanDeg: number, planet: CelestialMotion, planetPivot: number, spinPeriod: number,
): OrbitalElements {
  return criticalInclinationElements(perigeeAltitude, raanDeg, spinPeriod, planet, planetPivot);
}
