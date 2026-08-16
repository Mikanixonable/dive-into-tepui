// 予測列の先端を中心天体まわりの二体ケプラー軌道とみなして外挿する純関数群。THREE/DOM 非依存。
import { Attractor, orbitalElementsOf } from './attractor';
import {
  OrbitalElements,
  eccentricAnomalyFromMean,
  positionOnOrbit,
  timeSincePeriapsis,
  trueAnomalyAt,
  trueAnomalyFromMean,
  velocityOnOrbit,
} from './elements';
import { KinematicState, kinematicState } from './kinematic-state';
import { sub } from './vec3';

// この外挿が前提とする離心率の上限。eccentricAnomalyFromMean のニュートン法が収束するとみなす
// 範囲(既存の楕円ケプラーソルバの前提)。
const MAX_ECCENTRICITY = 0.98;

// tip を center まわりの二体軌道とみなしたときの軌道要素と、tip 自身の真近点角。
// 外挿できない場合(軌道要素が求まらない、離心率が MAX_ECCENTRICITY 以上、長半径が非有限・
// 非正、center に質量が無い)は null。
function findExtrapolationOrbit(
  tip: KinematicState, center: Attractor,
): { el: OrbitalElements; nu0: number } | null {
  if (center.mu <= 0) return null;
  const el = orbitalElementsOf(tip, center);
  if (el === null || el.e >= MAX_ECCENTRICITY || !isFinite(el.a) || el.a <= 0) return null;
  const nu0 = trueAnomalyAt(el, sub(tip.r, center.state.r));
  return { el, nu0 };
}

// tip を center まわりの二体ケプラー軌道とみなした、時刻 t における中心天体相対の状態
// (位置・速度は ECI 方向のまま原点だけ center に取った相対値。絶対 ECI 化は center の
// 位置・速度を足して行う)。外挿できない軌道では null。
export function extrapolatedRelativeState(tip: KinematicState, center: Attractor, t: number): KinematicState | null {
  const orbit = findExtrapolationOrbit(tip, center);
  if (orbit === null) return null;
  const { el, nu0 } = orbit;
  const n = (2 * Math.PI) / el.period; // 平均運動
  const meanAnomaly = n * (timeSincePeriapsis(el, nu0) + (t - tip.t));
  const nu = trueAnomalyFromMean(meanAnomaly, el.e);
  return kinematicState(t, positionOnOrbit(el, nu), velocityOnOrbit(el, nu));
}

// 離心近点角 E → 真近点角 ν の直接式(反復なし)。
function trueAnomalyFromEccentric(E: number, e: number): number {
  return 2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(E / 2), Math.sqrt(1 - e) * Math.cos(E / 2));
}

// tip.t から untilT までを離心近点角 E で count 等分した、中心天体相対の状態列(時刻昇順、
// tip 自身は含まない、最後の要素の時刻はちょうど untilT)。等時間刻みだと近点付近で弧長が
// 粗くなるため E で等分する。外挿できない場合、count <= 0、untilT <= tip.t のいずれでも空配列。
export function extrapolatedRelativeStates(
  tip: KinematicState, center: Attractor, untilT: number, count: number,
): KinematicState[] {
  if (count <= 0 || untilT <= tip.t) return [];
  const orbit = findExtrapolationOrbit(tip, center);
  if (orbit === null) return [];
  const { el, nu0 } = orbit;
  const e = el.e;
  const n = (2 * Math.PI) / el.period;

  // tip 時点の E0/M0(直接式)。
  const E0 = 2 * Math.atan2(Math.sqrt(1 - e) * Math.sin(nu0 / 2), Math.sqrt(1 + e) * Math.cos(nu0 / 2));
  const M0 = E0 - e * Math.sin(E0);
  const meanAnomalyEnd = M0 + n * (untilT - tip.t);

  // Mend → Eend はケプラー方程式を解く必要があり、この関数で唯一の反復になる。
  // eccentricAnomalyFromMean は入力を [-π, π] へ畳んでから解くため、畳んだぶんの周回数を
  // 明示的に足し戻さないと、複数周にまたがる Eend が巻き戻って単調でなくなる。
  const revolutions = Math.round(meanAnomalyEnd / (2 * Math.PI));
  const wrappedMeanAnomalyEnd = meanAnomalyEnd - revolutions * 2 * Math.PI;
  const Eend = eccentricAnomalyFromMean(wrappedMeanAnomalyEnd, e) + revolutions * 2 * Math.PI;

  // E0〜Eend を等分した各 Ei から、Mi・ti・νi をすべて直接式(反復なし)で求める。
  const states: KinematicState[] = [];
  for (let i = 0; i < count; i++) {
    const isLast = i === count - 1;
    const Ei = isLast ? Eend : E0 + (Eend - E0) * ((i + 1) / count);
    const Mi = Ei - e * Math.sin(Ei);
    const ti = isLast ? untilT : tip.t + (Mi - M0) / n;
    const nui = trueAnomalyFromEccentric(Ei, e);
    states.push(kinematicState(ti, positionOnOrbit(el, nui), velocityOnOrbit(el, nui)));
  }
  return states;
}
