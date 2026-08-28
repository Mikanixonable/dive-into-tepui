// 衛星: 惑星まわりのケプラー軌道 + 太陽摂動。太陽の質量が支配的なため摂動は無視できず、
// 永年項(昇交点の逆行・近点の順行)と周期項(出差・二均差・年差・視差不等)の両方を持つ —
// 簡易月理論(Brown の月理論を主要項で切り詰めた形)。歳差周期は実測値で与える。一次の
// 摂動論から導くと近点歳差が実測の約半分になる(ニュートンを悩ませ Clairaut が二次項で
// 解決した問題)ため、正確さを優先して理論導出値ではなく実測周期を使う。
// 周期項は、二体部分(厳密ケプラー解)の上へ黄経・黄緯・動径の加算補正として重ねる —
// 中心差(equation of the center、引数が衛星自身の平均近点角 mp のみの項)は二体解が
// 既に出しているので表に含めてはならない。同様に黄緯の主傾斜項(引数が f のみ)も
// 軌道傾斜の幾何が出す(採用基準・実採用数は solar-system.ts の MOON_LON_TERMS/
// MOON_LAT_TERMS/MOON_DIST_TERMS のコメントを参照)。到達精度: 月では、二体ケプラー解
// との黄経差の最大値が約2.3°(採用14項の振幅和 ≈2.49° に対し実測はその9割強)、地心距離は
// 近地点 356,400〜370,400 km・遠地点 404,000〜406,700 km の実測範囲にほぼ収まる
// (遠地点のみ切り詰めによる高次相関項の欠如で最大 0.05% ほど超えることがある)。
import { Quat } from './attitude';
import { PlanetAngles } from './planet-orbit';
import { eclToEci, eciToEcl } from './ecliptic';
import { ECLIPTIC_BASIS, KeplerOrbit, keplerOrbitState } from './kepler-orbit';
import { KinematicState, kinematicState } from './kinematic-state';
import { dot, len } from '../math/vec3';

const DEG = Math.PI / 180;

// 周期項の引数(基本角の線形結合)。d = 太陽からの平均離角、m = 太陽(惑星)の平均近点角、
// mp = 衛星の平均近点角、f = 衛星の昇交点からの緯度引数。
export type PerturbationTerm = {
  readonly d: number;
  readonly m: number;
  readonly mp: number;
  readonly f: number;
  readonly amp: number; // 黄経・黄緯補正は [rad]、動径補正は [m]
};

export type SatelliteOrbit = {
  readonly kepler: KeplerOrbit; // 二体部分。永年歳差は raanRate/lonPeriRate が担う
  readonly lonTerms: readonly PerturbationTerm[]; // 黄経補正 Σ amp・sin(arg)
  readonly latTerms: readonly PerturbationTerm[]; // 黄緯補正 Σ amp・sin(arg)
  readonly distTerms: readonly PerturbationTerm[]; // 動径補正 Σ amp・cos(arg)
};

// 歳差周期 [s] を符号付きの歳差速度 [rad/s] へ変換する。0 は「歳差しない」ことを表す(JPL の
// 公開表の規約)ので rate = 0 に写す — 2π/0 の無限大速度、および 0 に負号が付いて -0 になる
// ことの両方を避けるための特別扱い。
function precessionRate(periodSec: number, sign: 1 | -1): number {
  return periodSec === 0 ? 0 : (sign * 2 * Math.PI) / periodSec;
}

// 度・秒単位で入力された衛星の軌道要素・歳差周期を SatelliteOrbit へ変換する。
// 昇交点歳差(逆行)・近点歳差(順行)の符号はここで一度だけ決め、呼び出し側には正の周期だけを渡させる。
export function satelliteOrbit(p: {
  a: number;
  e: number;
  incDeg: number;
  raan0Deg: number;
  lonPeri0Deg: number;
  l0Deg: number;
  periodSec: number;
  nodePeriodSec: number; // 昇交点歳差の周期(正の値。逆行は satelliteOrbit 自身が符号を付ける)
  perigeePeriodSec: number; // 近点歳差の周期(正の値。順行は satelliteOrbit 自身が符号を付ける)
  basisToEci?: Quat; // 要素を測る基準面(省略時は黄道面)
  lonTerms: readonly PerturbationTerm[];
  latTerms: readonly PerturbationTerm[];
  distTerms: readonly PerturbationTerm[];
}): SatelliteOrbit {
  return {
    // 二体部分は永年歳差込みの KeplerOrbit。周期項(lonTerms/latTerms/distTerms)はそのまま素通しする。
    kepler: {
      basisToEci: p.basisToEci ?? ECLIPTIC_BASIS,
      a: p.a,
      aRate: 0,
      e: p.e,
      eRate: 0,
      inc: p.incDeg * DEG,
      incRate: 0,
      raan0: p.raan0Deg * DEG,
      raanRate: precessionRate(p.nodePeriodSec, -1),
      lonPeri0: p.lonPeri0Deg * DEG,
      lonPeriRate: precessionRate(p.perigeePeriodSec, 1),
      l0: p.l0Deg * DEG,
      lRate: (2 * Math.PI) / p.periodSec,
    },
    lonTerms: p.lonTerms,
    latTerms: p.latTerms,
    distTerms: p.distTerms,
  };
}

// 周期項の和とその時間微分を同時に返す(値と速度を別実装にしないため)。useSin は黄経・黄緯
// 補正(sin 系列)と動径補正(cos 系列)の切り替え。
function sumPeriodicTerms(
  terms: readonly PerturbationTerm[],
  useSin: boolean,
  d: number, m: number, mp: number, f: number,
  dRate: number, mRate: number, mpRate: number, fRate: number,
): readonly [value: number, rate: number] {
  let value = 0;
  let rate = 0;
  // 各項の引数は基本角の線形結合。
  for (const term of terms) {
    const arg = term.d * d + term.m * m + term.mp * mp + term.f * f;
    const argRate = term.d * dRate + term.m * mRate + term.mp * mpRate + term.f * fRate;
    if (useSin) {
      value += term.amp * Math.sin(arg);
      rate += term.amp * argRate * Math.cos(arg);
    } else {
      value += term.amp * Math.cos(arg);
      rate -= term.amp * argRate * Math.sin(arg);
    }
  }
  return [value, rate];
}

// 惑星中心・ECI 軸での状態。太陽の方向は planetAngles 経由で入る。二体部分の黄道座標
// (黄経・黄緯・動径)を求め、その上に周期項の加算補正を重ねてから ECI 位置・速度へ戻す。
// 回転基準系(kepler-orbit.ts の keplerOrbitRotation)と軌道法線は二体部分(平均要素)
// だけから組まれ、周期項を含まない — 混ぜると角速度が滑らかでなくなるためで、
// この結果、衛星の実位置は回転系の x̂ 軸から最大 2.5° ほどずれる(周期項の振幅の総和)。
export function satelliteState(
  orbit: SatelliteOrbit,
  planetAngles: PlanetAngles,
  t: number,
  phaseOffset: number,
): KinematicState {
  const k = orbit.kepler;
  const base = keplerOrbitState(k, t, phaseOffset);
  // 黄道座標への分解は黄道極を通る軌道で rho0 = hypot(x,y) → 0 となり速度が発散する。
  // 重ねる補正が1項も無いなら分解する意味自体が無いので、二体解をそのまま返す。
  if (orbit.lonTerms.length === 0 && orbit.latTerms.length === 0 && orbit.distTerms.length === 0) return base;

  const pos0 = eciToEcl(base.r);
  const vel0 = eciToEcl(base.v);

  const rho0 = Math.hypot(pos0.x, pos0.y);
  const r0 = len(pos0);
  const lambda0 = Math.atan2(pos0.y, pos0.x);
  const beta0 = Math.asin(pos0.z / r0);
  const rDot0 = dot(pos0, vel0) / r0;
  const rhoDot0 = (pos0.x * vel0.x + pos0.y * vel0.y) / rho0;
  const lambdaRate0 = (pos0.x * vel0.y - pos0.y * vel0.x) / (rho0 * rho0);
  const betaRate0 = (rho0 * vel0.z - pos0.z * rhoDot0) / (r0 * r0);

  // 出典(Meeus)の基本角と同じ、太陽からの平均離角 D・太陽の平均近点角 M・衛星の平均近点角
  // M'・衛星の昇交点からの緯度引数 F(すべて平均角)。
  const satL = k.l0 + phaseOffset + k.lRate * t;
  const sunL = planetAngles.meanLongitude + Math.PI; // 見かけの太陽黄経 = 惑星の日心黄経 + π
  const d = satL - sunL;
  const m = planetAngles.meanAnomaly;
  const mp = satL - (k.lonPeri0 + k.lonPeriRate * t);
  const f = satL - (k.raan0 + k.raanRate * t);
  const dRate = k.lRate - planetAngles.meanLongitudeRate;
  const mRate = planetAngles.meanAnomalyRate;
  const mpRate = k.lRate - k.lonPeriRate;
  const fRate = k.lRate - k.raanRate;

  const [dLon, dLonRate] = sumPeriodicTerms(orbit.lonTerms, true, d, m, mp, f, dRate, mRate, mpRate, fRate);
  const [dLat, dLatRate] = sumPeriodicTerms(orbit.latTerms, true, d, m, mp, f, dRate, mRate, mpRate, fRate);
  const [dDist, dDistRate] = sumPeriodicTerms(orbit.distTerms, false, d, m, mp, f, dRate, mRate, mpRate, fRate);

  const lambda = lambda0 + dLon;
  const lambdaRate = lambdaRate0 + dLonRate;
  const beta = beta0 + dLat;
  const betaRate = betaRate0 + dLatRate;
  const r = r0 + dDist;
  const rDot = rDot0 + dDistRate;

  const cosB = Math.cos(beta);
  const sinB = Math.sin(beta);
  const cosL = Math.cos(lambda);
  const sinL = Math.sin(lambda);
  const xe = r * cosB * cosL;
  const ye = r * cosB * sinL;
  const ze = r * sinB;
  const vxe = rDot * cosB * cosL - r * betaRate * sinB * cosL - r * lambdaRate * cosB * sinL;
  const vye = rDot * cosB * sinL - r * betaRate * sinB * sinL + r * lambdaRate * cosB * cosL;
  const vze = rDot * sinB + r * betaRate * cosB;

  return kinematicState(t, eclToEci(xe, ye, ze), eclToEci(vxe, vye, vze));
}
