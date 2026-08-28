// 軌道ガイドタブ「基本」群のうち、CR3BP の族を持たない地球専用の参照軌道(太陽同期準回帰・
// ドーンダスク・モルニヤ・ツンドラ)の軌道要素を組む。いずれも地球の重心を原点とした
// OrbitalElements を返し、実際の地球位置への配置は呼び出し側(orbit-guide.ts)が行う。
import type { CelestialBody } from './celestial-body';
import { kinematicState } from './kinematic-state';
import { orbitalElementsFromClassical, OrbitalElements } from './elements';
import { J2_EARTH, MU_EARTH, R_EARTH_EQ, SIDEREAL_DAY } from './solar-system';
import { v3 } from '../math/vec3';

const EARTH: CelestialBody = {
  id: 'earth', mu: MU_EARTH, radius: R_EARTH_EQ,
  state: kinematicState(0, v3(), v3()), accel: v3(), degree2: null, atmosphere: null, isStar: false,
};

// 太陽に対する昇交点の歳差が一致すべき角速度の基準となる回帰年 [s]。
const TROPICAL_YEAR_SEC = 365.2422 * 86400;

// 臨界傾斜角(近地点引数の長期摂動が止まる傾斜角、cos²i = 1/5) [deg]。モルニヤ・ツンドラ軌道が使う。
export const CRITICAL_INCLINATION_DEG = (Math.acos(1 / Math.sqrt(5)) * 180) / Math.PI;

// 回帰日数 repeatDays の間に revsPerRepeat 回(いずれも正の整数)地球を周回し、かつ昇交点が
// 太陽と同じ角速度で歳差する円軌道の高度・傾斜角を解く。raanOffsetDeg は昇交点の初期位置
// (太陽方向を基準にした角度)。両条件を同時に満たす実数の傾斜角が存在しなければ null。
function sunSynchronousElements(
  repeatDays: number, revsPerRepeat: number, raanOffsetDeg: number,
): OrbitalElements | null {
  const n = (revsPerRepeat * 2 * Math.PI) / (repeatDays * 86400);
  const a = Math.cbrt(EARTH.mu / (n * n));
  if (a <= EARTH.radius) return null; // 解の高度が地表以下(地球に埋まる非物理的な解)。
  const sunRate = (2 * Math.PI) / TROPICAL_YEAR_SEC;
  const precessionPerRad = -1.5 * n * J2_EARTH * (EARTH.radius / a) ** 2;
  const cosInc = sunRate / precessionPerRad;
  if (!(cosInc >= -1 && cosInc <= 1)) return null;
  const incDeg = (Math.acos(cosInc) * 180) / Math.PI;
  return orbitalElementsFromClassical(a, 0, incDeg, raanOffsetDeg, 0, EARTH);
}

// sunSynchronousElements が null を返す2つの境界(cosInc=-1・a=地球半径)を、それぞれ平均運動 n
// について解いた閉形式。repeatDays・revsPerRepeat 個々の値ではなく、その比(1日あたり周回数)
// だけで決まるので定数になる。HUD がスライダーの有効域を示すのに使う。
export const SUN_SYNC_REVS_PER_DAY_RANGE: { readonly min: number; readonly max: number } = (() => {
  const sunRate = (2 * Math.PI) / TROPICAL_YEAR_SEC;
  // cosInc = -1(太陽同期条件の下限)。
  const nMin = ((sunRate * EARTH.mu ** (2 / 3)) / (1.5 * J2_EARTH * EARTH.radius ** 2)) ** (3 / 7);
  // a = EARTH.radius(解の高度が地表に一致する上限)。
  const nMax = Math.sqrt(EARTH.mu / EARTH.radius ** 3);
  const revPerDay = (n: number) => (n * 86400) / (2 * Math.PI);
  return { min: revPerDay(nMin), max: revPerDay(nMax) };
})();

// 太陽同期準回帰軌道。昇交点の絶対位置はガイド線の形に影響しないので 0° に固定する。
export function sunSyncRepeatGroundTrackElements(repeatDays: number, revsPerRepeat: number): OrbitalElements | null {
  return sunSynchronousElements(repeatDays, revsPerRepeat, 0);
}

export type LocalTime = 'dawn' | 'dusk';

// ドーンダスク軌道。昇交点の地方太陽時を朝(6時)・夕(18時)に置く太陽同期軌道。sunRaanDeg は
// その瞬間の太陽方向の昇交点赤経(呼び出し側が現在時刻の天体暦から求めて渡す)。
export function dawnDuskElements(
  repeatDays: number, revsPerRepeat: number, localTime: LocalTime, sunRaanDeg: number,
): OrbitalElements | null {
  return sunSynchronousElements(repeatDays, revsPerRepeat, sunRaanDeg + (localTime === 'dawn' ? -90 : 90));
}

// 傾斜角・近地点引数を臨界値(63.4°・270°)に固定し、周期 period から長半径を、近地点高度から
// 離心率を求める。モルニヤ・ツンドラ軌道はこの周期だけが異なる。
function criticalInclinationElements(perigeeAltitude: number, raanDeg: number, period: number): OrbitalElements {
  const a = Math.cbrt((EARTH.mu * period * period) / (4 * Math.PI * Math.PI));
  const e = 1 - (EARTH.radius + perigeeAltitude) / a;
  return orbitalElementsFromClassical(a, e, CRITICAL_INCLINATION_DEG, raanDeg, 270, EARTH);
}

// モルニヤ軌道: 周期は半恒星日(1日に2周)。
export function molniyaElements(perigeeAltitude: number, raanDeg: number): OrbitalElements {
  return criticalInclinationElements(perigeeAltitude, raanDeg, SIDEREAL_DAY / 2);
}

// ツンドラ軌道: 周期は1恒星日(1日に1周)。
export function tundraElements(perigeeAltitude: number, raanDeg: number): OrbitalElements {
  return criticalInclinationElements(perigeeAltitude, raanDeg, SIDEREAL_DAY);
}
