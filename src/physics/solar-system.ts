// 天体の静的事実の表: 恒星/惑星/衛星の判別 union(CelestialBodyDef)と、太陽系の各天体の
// 重力定数・半径・軌道モデル(SOLAR_SYSTEM)。宣言順が Ephemeris が返す重力源配列の順になる。
import { AttractorId, PlanetId, SatelliteId, StarId } from './attractor';
import { PlanetOrbit, planetOrbit } from './planet-orbit';
import { PerturbationTerm, SatelliteOrbit, satelliteOrbit } from './satellite-orbit';
import { Vec3, len } from './vec3';

export const MU_SUN = 1.32712440018e20; // [m^3/s^2]
export const R_SUN = 6.957e8; // [m]
export const MU_MOON = 4.9048695e12;
export const R_MOON = 1.7374e6;
export const MU_EARTH = 3.986004418e14; // 地球重力定数 [m^3/s^2]
export const R_EARTH = 6.371e6; // 地球平均半径 [m]
export const R_EARTH_EQ = 6.378137e6; // 赤道半径 [m]
export const SIDEREAL_DAY = 86164.0905; // 恒星日 [s]

// 位置ベクトルから地球海抜高度を返す。
export function earthAltitudeOf(r: Vec3): number {
  return len(r) - R_EARTH;
}

// 地球-月重心の平均黄経(t=0)。実暦の値ではなく、SIM_EPOCH_UTC と同じくゲーム開始時刻を
// 昼側に置くための表示上のアンカー — 地球の真黄経が π(太陽から見て反対側 = 地球から見て
// 太陽が +X 方向)になる近点角から逆算した値(ϖ ≠ 0 なので単純に π にはならない)。
const EARTH_L0_DEG = 178.13895347311777;

// 公転している天体(惑星・衛星)を、表示上の「親」— 衛星ならその惑星、惑星なら恒星 — へ写す。
export function primaryOf(id: PlanetId | SatelliteId): AttractorId {
  const def = bodyDef(id);
  return def.kind === 'satellite' ? def.planet : 'sun';
}

export type CelestialBodyDef =
  | { readonly kind: 'star'; readonly id: StarId; readonly mu: number; readonly radius: number }
  | {
      readonly kind: 'planet';
      readonly id: PlanetId;
      readonly mu: number;
      readonly radius: number;
      readonly orbit: PlanetOrbit; // 中心は必ず恒星
    }
  | {
      readonly kind: 'satellite';
      readonly id: SatelliteId;
      readonly mu: number;
      readonly radius: number;
      readonly planet: PlanetId; // 中心は必ず惑星
      readonly orbit: SatelliteOrbit;
    };

const D2R = Math.PI / 180;

// 月の周期摂動項(出典: Jean Meeus『Astronomical Algorithms』第47章 Table 47.A/47.B、
// Brown の月理論の切り詰め)。**黄経で 0.01°(≒70 km)を超える項までを採用**した — 黄経は
// 14項、動径は同じ引数の行のうち Σr 欄が空(係数0)の1行を除いた13項、黄緯は7項。
// 引数 d/m/mp/f は Meeus の基本角 D(太陽からの平均離角)/M(太陽の平均近点角)/
// M'(月の平均近点角)/F(月の昇交点からの緯度引数)そのままの整数倍係数。**中心差に相当する
// mp のみの行((0,0,1,0) sin M' 6.288774°・(0,0,2,0)・(0,0,3,0) というその高調波も含む —
// これらは e のべき級数として二体ケプラー解の中心差展開と一致するため二重計上になる)と、
// 黄緯の主傾斜に相当する f のみの行((0,0,0,1) sin F 5.128122°)は、この表から意図的に
// 除外している**(`satellite-orbit.test.ts` の該当テストがこの除外を機械的に検査する)。
const MOON_LON_TERMS: readonly PerturbationTerm[] = [
  { d: 2, m: 0, mp: -1, f: 0, amp: 1274027e-6 * D2R }, // 出差 evection
  { d: 2, m: 0, mp: 0, f: 0, amp: 658314e-6 * D2R }, // 二均差 variation
  { d: 0, m: 1, mp: 0, f: 0, amp: -185116e-6 * D2R }, // 年差 annual equation
  { d: 2, m: 0, mp: -2, f: 0, amp: 58793e-6 * D2R },
  { d: 2, m: -1, mp: -1, f: 0, amp: 57066e-6 * D2R },
  { d: 2, m: 0, mp: 1, f: 0, amp: 53322e-6 * D2R },
  { d: 2, m: -1, mp: 0, f: 0, amp: 45758e-6 * D2R },
  { d: 0, m: 1, mp: -1, f: 0, amp: -40923e-6 * D2R },
  { d: 1, m: 0, mp: 0, f: 0, amp: -34720e-6 * D2R }, // 視差不等 parallactic inequality
  { d: 0, m: 1, mp: 1, f: 0, amp: -30383e-6 * D2R },
  { d: 2, m: 0, mp: 0, f: -2, amp: 15327e-6 * D2R },
  { d: 0, m: 0, mp: 1, f: 2, amp: -12528e-6 * D2R },
  { d: 0, m: 0, mp: 1, f: -2, amp: 10980e-6 * D2R },
  { d: 4, m: 0, mp: -1, f: 0, amp: 10675e-6 * D2R },
];

const MOON_LAT_TERMS: readonly PerturbationTerm[] = [
  { d: 0, m: 0, mp: 1, f: 1, amp: 280602e-6 * D2R },
  { d: 0, m: 0, mp: 1, f: -1, amp: 277693e-6 * D2R },
  { d: 2, m: 0, mp: 0, f: -1, amp: 173237e-6 * D2R },
  { d: 2, m: 0, mp: -1, f: 1, amp: 55413e-6 * D2R },
  { d: 2, m: 0, mp: -1, f: -1, amp: 46271e-6 * D2R },
  { d: 2, m: 0, mp: 0, f: 1, amp: 32573e-6 * D2R },
  { d: 0, m: 0, mp: 2, f: 1, amp: 17198e-6 * D2R },
];

// 動径補正は Meeus の表の値が既に [0.001 km] = [m] 単位なので、そのまま m として使える。
// (0,0,1,2) は Meeus の表で Σr 欄が空(係数0)のため、この表には含めない。
const MOON_DIST_TERMS: readonly PerturbationTerm[] = [
  { d: 2, m: 0, mp: -1, f: 0, amp: -3699111 },
  { d: 2, m: 0, mp: 0, f: 0, amp: -2955968 },
  { d: 0, m: 1, mp: 0, f: 0, amp: 48888 },
  { d: 2, m: 0, mp: -2, f: 0, amp: 246158 },
  { d: 2, m: -1, mp: -1, f: 0, amp: -152138 },
  { d: 2, m: 0, mp: 1, f: 0, amp: -170733 },
  { d: 2, m: -1, mp: 0, f: 0, amp: -204586 },
  { d: 0, m: 1, mp: -1, f: 0, amp: -129620 },
  { d: 1, m: 0, mp: 0, f: 0, amp: 108743 },
  { d: 0, m: 1, mp: 1, f: 0, amp: 104755 },
  { d: 2, m: 0, mp: 0, f: -2, amp: 10321 },
  { d: 0, m: 0, mp: 1, f: -2, amp: 79661 },
  { d: 4, m: 0, mp: -1, f: 0, amp: -34782 },
];

// 型注釈ではなく satisfies で受けることで、id ごとの具体型(地球なら惑星、月なら衛星)が
// 保たれ、「地球は必ず惑星」を型から引き出せる。
export const SOLAR_SYSTEM = {
  earth: {
    kind: 'planet',
    id: 'earth',
    mu: MU_EARTH,
    radius: R_EARTH,
    // JPL 低精度惑星暦の "EM Bary"(地球-月重心)行、黄道基準・J2000 相当。
    orbit: planetOrbit({
      a: 1.495978707e11,
      e: 0.01671123,
      incDeg: 0,
      raanDeg: 0,
      lonPeriDeg: 102.93768,
      l0Deg: EARTH_L0_DEG,
      periodSec: 365.25636 * 86400,
      raanRateDegPerCentury: 0,
      incRateDegPerCentury: -0.01294668,
      lonPeriRateDegPerCentury: 0.32327364,
      eRatePerCentury: -0.00004392,
      aRatePerCenturyAu: 0.00000562,
    }),
  },
  moon: {
    kind: 'satellite',
    id: 'moon',
    mu: MU_MOON,
    radius: R_MOON,
    planet: 'earth',
    orbit: satelliteOrbit({
      a: 3.844e8,
      e: 0.0549,
      incDeg: 5.145,
      raan0Deg: 0,
      lonPeri0Deg: 0,
      l0Deg: 0,
      periodSec: 27.321661 * 86400,
      nodePeriodSec: 18.612958 * 365.25 * 86400,
      perigeePeriodSec: 8.85 * 365.25 * 86400,
      lonTerms: MOON_LON_TERMS,
      latTerms: MOON_LAT_TERMS,
      distTerms: MOON_DIST_TERMS,
    }),
  },
  jupiter: {
    kind: 'planet',
    id: 'jupiter',
    mu: 1.26686534e17,
    radius: 6.9911e7,
    // JPL 低精度惑星暦(Standish 1992/2006)の Jupiter 行、黄道基準・J2000 相当。
    // eRatePerCentury/incRateDegPerCentury も同表の値(タスク指示に無いぶんを補う)。
    orbit: planetOrbit({
      a: 7.78340821e11,
      e: 0.04838624,
      incDeg: 1.30439695,
      raanDeg: 100.47390909,
      lonPeriDeg: 14.72847983,
      l0Deg: 34.39644051,
      periodSec: 11.862 * 365.25 * 86400,
      raanRateDegPerCentury: 0.20469106,
      incRateDegPerCentury: -0.00183714,
      lonPeriRateDegPerCentury: 0.21252668,
      eRatePerCentury: -0.00013253,
      aRatePerCenturyAu: -0.00011607,
    }),
  },
  sun: { kind: 'star', id: 'sun', mu: MU_SUN, radius: R_SUN },
} satisfies Record<AttractorId, CelestialBodyDef>;

// SOLAR_SYSTEM を satisfies で受けているため、推論された型にインデックスシグネチャがなく
// 非リテラルな id での添字アクセスは型エラーになる。動的な id で引く箇所はすべてこれを経由する。
// 戻り値の型は SOLAR_SYSTEM の実際のキー集合ではなく CelestialBodyDef 自体の判別 union から
// 組む(id ごとの具体型は保ったまま、天体を1つ追加した際にレジストリが未対応であることの
// エラーがこの関数の外へ波及しないようにするため)。
type KindOf<T extends AttractorId> = T extends StarId ? 'star' : T extends PlanetId ? 'planet' : 'satellite';
type BodyDefOf<T extends AttractorId> = Extract<CelestialBodyDef, { readonly kind: KindOf<T> }>;

// id を SOLAR_SYSTEM から引く。戻り値の型は id の具体型(星/惑星/衛星)に絞り込まれる。
export function bodyDef<T extends AttractorId>(id: T): BodyDefOf<T> {
  return (SOLAR_SYSTEM as Record<AttractorId, CelestialBodyDef>)[id] as BodyDefOf<T>;
}
