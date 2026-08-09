// 天体の静的事実の表: 恒星/惑星/衛星の判別 union(CelestialBodyDef)と、太陽系の各天体の
// 重力定数・半径・軌道モデル(SOLAR_SYSTEM)。宣言順が Ephemeris が返す重力源配列の順になる。
import { Quat } from './attitude';
import { AttractorId } from './attractor';
import { equatorBasisToEci } from './body-orientation';
import { raDecToEci } from './ecliptic';
import { keplerPeriod } from './elements';
import { AU, PlanetOrbit, planetOrbit } from './planet-orbit';
import { PerturbationTerm, SatelliteOrbit, satelliteOrbit } from './satellite-orbit';
import { Vec3, len } from './vec3';

// 万有引力定数 [m^3/(kg・s^2)]。MU_* は測定された GM を直接持つ値なのでこれで割り直さないこと —
// 質量から GM を導く側(Asteroid など)だけがこれを使う。
export const GRAVITATIONAL_CONSTANT = 6.6743e-11;

export const MU_SUN = 1.32712440018e20; // [m^3/s^2]
export const R_SUN = 6.957e8; // [m]
export const MU_MOON = 4.9048695e12;
export const R_MOON = 1.7374e6;
export const MU_EARTH = 3.986004418e14; // 地球重力定数 [m^3/s^2]
export const R_EARTH = 6.371e6; // 地球平均半径 [m]
export const R_EARTH_EQ = 6.378137e6; // 赤道半径 [m]
export const SIDEREAL_DAY = 86164.0905; // 恒星日 [s]
// 衛星を抱える惑星の重力定数 [m^3/s^2]。衛星の平均運動をケプラー第3法則で出すのに要るため、
// 惑星本体の定義と衛星の軌道が同じ1つの値を読む。
export const MU_MARS = 4.282837e13;
export const MU_JUPITER = 1.26686534e17;
export const MU_SATURN = 3.7931187e16;
export const MU_NEPTUNE = 6.836529e15;

// 位置ベクトルから地球海抜高度を返す。
export function earthAltitudeOf(r: Vec3): number {
  return len(r) - R_EARTH;
}

// 2次の重力場係数(いずれも非正規化)。正規化係数を収録した外部データで更新する際は換算が要る。
export const J2_EARTH = 1.08262668e-3;
// GRAIL による測定値。基準半径 1738.0 km は月の表面半径 R_MOON とは別の量なので分けて持つ。
export const J2_MOON = 203.3e-6;
export const C22_MOON = 22.4e-6;
export const R_MOON_GRAVITY = 1.7380e6; // [m]
// 月の赤道が黄道に対して傾く角(カッシーニ第2法則)。
export const MOON_OBLIQUITY = 1.543 * (Math.PI / 180); // [rad]

// registry の中から恒星を1つ探す。0個なら null。このステップがサポートするのは主星が
// ちょうど1つ、または0個の星系のみで、複数の恒星が相互に公転しあう連星系は対象外 — 2つ以上
// 見つかったら例外にする。
export function starOf(registry: CelestialRegistry): AttractorId | null {
  let star: AttractorId | null = null;
  for (const [id, def] of Object.entries(registry)) {
    if (def.kind !== 'star') continue;
    if (star !== null) throw new Error(`starOf: レジストリに複数の恒星がある(連星系は非対応): ${star}, ${id}`);
    star = id;
  }
  return star;
}

// 天体を、表示上の「親」— 衛星ならその惑星、惑星ならそのレジストリの恒星 — へ写す。
// 恒星自身は親を持たないので null(レジストリに恒星が無い場合も同じく null)。
// null が階層の根であることを呼び出し側が使えるよう、恒星が自分自身を返すことはない。
export function primaryOf(registry: CelestialRegistry, id: AttractorId): AttractorId | null {
  const def = bodyDef(registry, id);
  if (def.kind === 'star') return null;
  return def.kind === 'satellite' ? def.planet : starOf(registry);
}

// 自転軸と自転位相の決め方。'eciPole' は ECI の極軸そのもの(この座標系を定義している天体)、
// 'cassini' は同期回転する衛星のカッシーニ状態で、黄道に対する赤道の傾き obliquity [rad]
// と軌道面法線から軸が、親を向き続ける平均黄経方向から位相が決まる。'iau' は極の赤経・赤緯と
// 自転位相 W をそれぞれ時刻の一次式で与える(周期項・高次項は扱わない)。'iau' の係数は
// いずれも NAIF pck00011.tpc(WGCCRE 2015 準拠)の BODY_POLE_RA / BODY_POLE_DEC / BODY_PM。
export type PoleModel =
  | { readonly kind: 'eciPole' }
  | { readonly kind: 'cassini'; readonly obliquity: number }
  | {
      readonly kind: 'iau';
      readonly ra0Deg: number;
      readonly ra1DegPerCentury: number;
      readonly dec0Deg: number;
      readonly dec1DegPerCentury: number;
      readonly w0Deg: number;
      readonly wRateDegPerDay: number;
    };

// 2次の重力場の静的な記述。時刻ごとの自転軸・長軸の実ベクトルは ephemeris.ts が組む。
export type Degree2GravityDef = {
  readonly j2: number;
  readonly c22: number; // 0 なら軸対称
  readonly refRadius: number; // 係数が定義された基準半径 [m]
};

// ラグランジュ点をフォーカス対象のラベルとして出すかどうか(省略時 = 出さない)。全公転天体で
// 出すと 5 点 × 天体数のラベルが画面を埋めるので、実際に軌道設計の目標になる系だけを立てる。
type LagrangeLabelFlag = { readonly lagrangeLabels?: boolean };

export type CelestialBodyDef =
  | { readonly kind: 'star'; readonly id: AttractorId; readonly mu: number; readonly radius: number }
  | ({
      readonly kind: 'planet';
      readonly id: AttractorId;
      readonly mu: number;
      readonly radius: number;
      readonly orbit: PlanetOrbit; // 中心は必ず恒星
      readonly pole?: PoleModel; // 省略時は自転軸を持たない
      readonly degree2?: Degree2GravityDef; // 省略時は質点として扱う
    } & LagrangeLabelFlag)
  | ({
      readonly kind: 'satellite';
      readonly id: AttractorId;
      readonly mu: number;
      readonly radius: number;
      readonly planet: AttractorId; // 中心は必ず惑星
      readonly orbit: SatelliteOrbit;
      readonly pole?: PoleModel;
      readonly degree2?: Degree2GravityDef;
    } & LagrangeLabelFlag);

// 天体レジストリ: id から静的事実(CelestialBodyDef)を引く表。SOLAR_SYSTEM が「現実の太陽系」
// という名前つきの既定値で、ステージごとに別のレジストリへ差し替えられる。
export type CelestialRegistry = Readonly<Record<AttractorId, CelestialBodyDef>>;

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

type IauPole = Extract<PoleModel, { readonly kind: 'iau' }>;

// 衛星を抱える惑星の自転軸。衛星の軌道要素はこの軸が張る赤道面の上で与えるため、
// 惑星本体の pole と衛星の基準面が同じ1つの定義を読む。
const MARS_POLE: IauPole = {
  kind: 'iau',
  ra0Deg: 317.269202, ra1DegPerCentury: -0.10927547,
  dec0Deg: 54.432516, dec1DegPerCentury: -0.05827105,
  w0Deg: 176.049863, wRateDegPerDay: 350.891982443297,
};
const JUPITER_POLE: IauPole = {
  kind: 'iau',
  ra0Deg: 268.056595, ra1DegPerCentury: -0.006499,
  dec0Deg: 64.495303, dec1DegPerCentury: 0.002413,
  w0Deg: 284.95, wRateDegPerDay: 870.536,
};
const SATURN_POLE: IauPole = {
  kind: 'iau',
  ra0Deg: 40.589, ra1DegPerCentury: -0.036,
  dec0Deg: 83.537, dec1DegPerCentury: -0.004,
  w0Deg: 38.9, wRateDegPerDay: 810.7939024,
};
const NEPTUNE_POLE: IauPole = {
  kind: 'iau',
  ra0Deg: 299.36, ra1DegPerCentury: 0.0,
  dec0Deg: 43.46, dec1DegPerCentury: 0.0,
  w0Deg: 249.978, wRateDegPerDay: 541.1397757,
};

// 惑星の赤道面を基準面とする回転。極の一次項は世紀あたり 0.11° 以下なので元期の極で固定する
// (「衛星の軌道面が親の赤道面に対して静止している」という近似そのものが、内側衛星の
// ラプラス面 ≈ 惑星赤道面という近似と同程度の粗さで、極のこの緩やかな動きはその中に埋もれる)。
function equatorBasis(pole: IauPole): Quat {
  return equatorBasisToEci(raDecToEci(pole.ra0Deg, pole.dec0Deg));
}

// 親惑星の赤道面を基準面に取る衛星の二体ケプラー軌道。要素は JPL Solar System Dynamics の
// 衛星平均要素(親惑星の赤道面基準)。歳差・周期摂動は実測値を持たないので置かない。
function equatorialSatelliteOrbit(p: {
  a: number;
  e: number;
  incDeg: number;
  planetMu: number;
  planetPole: IauPole;
}): SatelliteOrbit {
  return satelliteOrbit({
    a: p.a,
    e: p.e,
    incDeg: p.incDeg,
    raan0Deg: 0,
    lonPeri0Deg: 0,
    l0Deg: 0,
    periodSec: keplerPeriod(p.a, p.planetMu),
    nodePeriodSec: Infinity,
    perigeePeriodSec: Infinity,
    basisToEci: equatorBasis(p.planetPole),
    lonTerms: [],
    latTerms: [],
    distTerms: [],
  });
}

const JULIAN_YEAR_DAYS = 365.25;

// JPL Solar System Dynamics の衛星平均要素表の列(周期は日、歳差周期は年)をそのまま受ける
// 衛星軌道。基準面は既定で黄道面。公転周期は a とケプラー第3法則から導かず表の値をそのまま
// 使う — 遠方の衛星の平均運動は太陽摂動で二体値からずれており、公開された実測周期の方が近い。
// Ω/ω/M0 は表から転記していないので常に 0(登録済みの全衛星と同じ)。
function jplSatelliteOrbit(p: {
  a: number;
  e: number;
  incDeg: number;
  periodDays: number;
  nodePeriodYears: number;
  apsisPeriodYears: number;
  basisToEci?: Quat;
}): SatelliteOrbit {
  return satelliteOrbit({
    a: p.a,
    e: p.e,
    incDeg: p.incDeg,
    raan0Deg: 0,
    lonPeri0Deg: 0,
    l0Deg: 0,
    periodSec: p.periodDays * 86400,
    nodePeriodSec: p.nodePeriodYears * JULIAN_YEAR_DAYS * 86400,
    perigeePeriodSec: p.apsisPeriodYears * JULIAN_YEAR_DAYS * 86400,
    basisToEci: p.basisToEci,
    lonTerms: [],
    latTerms: [],
    distTerms: [],
  });
}

// 型注釈ではなく satisfies で受けることで、id ごとの具体型(地球なら惑星、月なら衛星)が
// 保たれ、「地球は必ず惑星」を型から引き出せる。
export const SOLAR_SYSTEM = {
  earth: {
    kind: 'planet',
    id: 'earth',
    mu: MU_EARTH,
    radius: R_EARTH,
    lagrangeLabels: true,
    // JPL 低精度惑星暦の "EM Bary"(地球-月重心)行、黄道基準・J2000 相当。
    orbit: planetOrbit({
      a: 1.495978707e11,
      e: 0.01671123,
      incDeg: 0,
      raanDeg: 0,
      lonPeriDeg: 102.93768,
      l0Deg: 100.46457166,
      lRateDegPerCentury: 35999.37244981,
      raanRateDegPerCentury: 0,
      incRateDegPerCentury: -0.01294668,
      lonPeriRateDegPerCentury: 0.32327364,
      eRatePerCentury: -0.00004392,
      aRatePerCenturyAu: 0.00000562,
    }),
    pole: { kind: 'eciPole' },
    // 赤道断面の楕円性 C22 は J2 の約 1/690 しかないため軸対称として扱う。
    degree2: { j2: J2_EARTH, c22: 0, refRadius: R_EARTH_EQ },
  },
  moon: {
    kind: 'satellite',
    id: 'moon',
    mu: MU_MOON,
    radius: R_MOON,
    lagrangeLabels: true,
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
    pole: { kind: 'cassini', obliquity: MOON_OBLIQUITY },
    // J2 に対する C22 の比が地球の約 1/690 に対して約 1/9 と大きく、軸対称近似が成り立たない。
    degree2: { j2: J2_MOON, c22: C22_MOON, refRadius: R_MOON_GRAVITY },
  },
  // 水星〜海王星の要素・永年変化率はいずれも JPL Standish "Keplerian Elements for Approximate
  // Positions of the Major Planets" Table 1(黄道基準・J2000、有効期間 1800–2050AD)。
  mercury: {
    kind: 'planet',
    id: 'mercury',
    mu: 2.2032e13,
    radius: 2.4397e6,
    // ϖ̇ の 0.16047689 deg/Cy = 577.7″/Cy には一般相対論による近日点移動 42.98″/Cy が既に
    // 含まれている(この表は PPN 相対論込みで数値積分された JPL DE 暦へのフィット)。
    // 惑星摂動のみの古典値 531.6″/Cy に補正項を足す形にしてはならない。
    orbit: planetOrbit({
      a: 0.38709927 * AU,
      e: 0.20563593,
      incDeg: 7.00497902,
      raanDeg: 48.33076593,
      lonPeriDeg: 77.45779628,
      l0Deg: 252.25032350,
      lRateDegPerCentury: 149472.67411175,
      raanRateDegPerCentury: -0.12534081,
      incRateDegPerCentury: -0.00594749,
      lonPeriRateDegPerCentury: 0.16047689,
      eRatePerCentury: 0.00001906,
      aRatePerCenturyAu: 0.00000037,
    }),
    pole: {
      kind: 'iau',
      ra0Deg: 281.0103,
      ra1DegPerCentury: -0.0328,
      dec0Deg: 61.4155,
      dec1DegPerCentury: -0.0049,
      w0Deg: 329.5988,
      wRateDegPerDay: 6.1385108,
    },
  },
  venus: {
    kind: 'planet',
    id: 'venus',
    mu: 3.24859e14,
    radius: 6.0518e6,
    orbit: planetOrbit({
      a: 0.72333566 * AU,
      e: 0.00677672,
      incDeg: 3.39467605,
      raanDeg: 76.67984255,
      lonPeriDeg: 131.60246718,
      l0Deg: 181.97909950,
      lRateDegPerCentury: 58517.81538729,
      raanRateDegPerCentury: -0.27769418,
      incRateDegPerCentury: -0.00078890,
      lonPeriRateDegPerCentury: 0.00268329,
      eRatePerCentury: -0.00004107,
      aRatePerCenturyAu: 0.00000390,
    }),
    pole: {
      kind: 'iau',
      ra0Deg: 272.76,
      ra1DegPerCentury: 0.0,
      dec0Deg: 67.16,
      dec1DegPerCentury: 0.0,
      w0Deg: 160.2,
      wRateDegPerDay: -1.4813688,
    },
  },
  mars: {
    kind: 'planet',
    id: 'mars',
    mu: MU_MARS,
    radius: 3.3895e6,
    orbit: planetOrbit({
      a: 1.52371034 * AU,
      e: 0.09339410,
      incDeg: 1.84969142,
      raanDeg: 49.55953891,
      lonPeriDeg: -23.94362959,
      l0Deg: -4.55343205,
      lRateDegPerCentury: 19140.30268499,
      raanRateDegPerCentury: -0.29257343,
      incRateDegPerCentury: -0.00813131,
      lonPeriRateDegPerCentury: 0.44441088,
      eRatePerCentury: 0.00007882,
      aRatePerCenturyAu: 0.00001847,
    }),
    pole: MARS_POLE,
  },
  phobos: {
    kind: 'satellite',
    id: 'phobos',
    mu: 7.112e5,
    radius: 1.1267e4,
    planet: 'mars',
    orbit: equatorialSatelliteOrbit({ a: 9.376e6, e: 0.0151, incDeg: 1.08, planetMu: MU_MARS, planetPole: MARS_POLE }),
  },
  deimos: {
    kind: 'satellite',
    id: 'deimos',
    mu: 9.85e4,
    radius: 6.2e3,
    planet: 'mars',
    orbit: equatorialSatelliteOrbit({ a: 2.3458e7, e: 0.00033, incDeg: 1.79, planetMu: MU_MARS, planetPole: MARS_POLE }),
  },
  jupiter: {
    kind: 'planet',
    id: 'jupiter',
    mu: MU_JUPITER,
    radius: 6.9911e7,
    lagrangeLabels: true,
    orbit: planetOrbit({
      a: 7.78340821e11,
      e: 0.04838624,
      incDeg: 1.30439695,
      raanDeg: 100.47390909,
      lonPeriDeg: 14.72847983,
      l0Deg: 34.39644051,
      lRateDegPerCentury: 3034.74612775,
      raanRateDegPerCentury: 0.20469106,
      incRateDegPerCentury: -0.00183714,
      lonPeriRateDegPerCentury: 0.21252668,
      eRatePerCentury: -0.00013253,
      aRatePerCenturyAu: -0.00011607,
    }),
    pole: JUPITER_POLE,
  },
  io: {
    kind: 'satellite',
    id: 'io',
    mu: 5.9599e12,
    radius: 1.8216e6,
    planet: 'jupiter',
    orbit: equatorialSatelliteOrbit({ a: 4.218e8, e: 0.0033, incDeg: 0.04, planetMu: MU_JUPITER, planetPole: JUPITER_POLE }),
  },
  europa: {
    kind: 'satellite',
    id: 'europa',
    mu: 3.2027e12,
    radius: 1.5608e6,
    planet: 'jupiter',
    orbit: equatorialSatelliteOrbit({ a: 6.711e8, e: 0.0072, incDeg: 0.47, planetMu: MU_JUPITER, planetPole: JUPITER_POLE }),
  },
  ganymede: {
    kind: 'satellite',
    id: 'ganymede',
    mu: 9.8878e12,
    radius: 2.6312e6,
    planet: 'jupiter',
    orbit: equatorialSatelliteOrbit({ a: 1.0704e9, e: 0.0013, incDeg: 0.20, planetMu: MU_JUPITER, planetPole: JUPITER_POLE }),
  },
  callisto: {
    kind: 'satellite',
    id: 'callisto',
    mu: 7.1793e12,
    radius: 2.4103e6,
    planet: 'jupiter',
    orbit: equatorialSatelliteOrbit({ a: 1.8827e9, e: 0.0048, incDeg: 0.19, planetMu: MU_JUPITER, planetPole: JUPITER_POLE }),
  },
  // 木星の不規則衛星(ヒマリア群・アナンケ群・カルメ群・パシファエ群)。ガリレオ衛星と違い
  // 太陽摂動が支配的な遠方軌道なので、ラプラス面ではなく黄道基準の平均要素を使う(JPL
  // Solar System Dynamics はこの6衛星をこの基準で公開している)。歳差周期は未測定のため
  // 0(歳差なし)。GM・平均半径は Planetary Satellite Physical Parameters が一次だが、
  // エララ・アナンケ・カルメ・パシファエ・シノーペの半径はその表に無いため、Wikipedia
  // "List of natural satellites"(一次は Sheppard の測光サイズ推定)の値を使う。
  himalia: {
    kind: 'satellite',
    id: 'himalia',
    mu: 0.15155e9,
    radius: 8.5e4,
    planet: 'jupiter',
    orbit: jplSatelliteOrbit({ a: 1.14390e10, e: 0.160, incDeg: 28.4, periodDays: 249.9090, nodePeriodYears: 0, apsisPeriodYears: 0 }),
  },
  elara: {
    kind: 'satellite',
    id: 'elara',
    mu: 0,
    radius: 3.995e4,
    planet: 'jupiter',
    orbit: jplSatelliteOrbit({ a: 1.171070e10, e: 0.212, incDeg: 27.8, periodDays: 258.8861, nodePeriodYears: 0, apsisPeriodYears: 0 }),
  },
  // 傾斜角 90° 超が逆行を表す。
  ananke: {
    kind: 'satellite',
    id: 'ananke',
    mu: 0,
    radius: 1.455e4,
    planet: 'jupiter',
    orbit: jplSatelliteOrbit({ a: 2.10295e10, e: 0.238, incDeg: 147.6, periodDays: 623.1097, nodePeriodYears: 0, apsisPeriodYears: 0 }),
  },
  carme: {
    kind: 'satellite',
    id: 'carme',
    mu: 0,
    radius: 2.33e4,
    planet: 'jupiter',
    orbit: jplSatelliteOrbit({ a: 2.31392e10, e: 0.261, incDeg: 164.6, periodDays: 719.2806, nodePeriodYears: 0, apsisPeriodYears: 0 }),
  },
  pasiphae: {
    kind: 'satellite',
    id: 'pasiphae',
    mu: 0,
    radius: 2.89e4,
    planet: 'jupiter',
    orbit: jplSatelliteOrbit({ a: 2.34632e10, e: 0.412, incDeg: 148.3, periodDays: 734.4215, nodePeriodYears: 0, apsisPeriodYears: 0 }),
  },
  sinope: {
    kind: 'satellite',
    id: 'sinope',
    mu: 0,
    radius: 1.75e4,
    planet: 'jupiter',
    orbit: jplSatelliteOrbit({ a: 2.36793e10, e: 0.262, incDeg: 157.3, periodDays: 744.5951, nodePeriodYears: 0, apsisPeriodYears: 0 }),
  },
  saturn: {
    kind: 'planet',
    id: 'saturn',
    mu: MU_SATURN,
    radius: 5.8232e7,
    lagrangeLabels: true,
    orbit: planetOrbit({
      a: 9.53667594 * AU,
      e: 0.05386179,
      incDeg: 2.48599187,
      raanDeg: 113.66242448,
      lonPeriDeg: 92.59887831,
      l0Deg: 49.95424423,
      lRateDegPerCentury: 1222.49362201,
      raanRateDegPerCentury: -0.28867794,
      incRateDegPerCentury: 0.00193609,
      lonPeriRateDegPerCentury: -0.41897216,
      eRatePerCentury: -0.00050991,
      aRatePerCenturyAu: -0.00125060,
    }),
    pole: SATURN_POLE,
  },
  titan: {
    kind: 'satellite',
    id: 'titan',
    mu: 8.9781e12,
    radius: 2.5747e6,
    planet: 'saturn',
    orbit: equatorialSatelliteOrbit({ a: 1.22187e9, e: 0.0288, incDeg: 0.35, planetMu: MU_SATURN, planetPole: SATURN_POLE }),
  },
  uranus: {
    kind: 'planet',
    id: 'uranus',
    mu: 5.793939e15,
    radius: 2.5362e7,
    orbit: planetOrbit({
      a: 19.18916464 * AU,
      e: 0.04725744,
      incDeg: 0.77263783,
      raanDeg: 74.01692503,
      lonPeriDeg: 170.95427630,
      l0Deg: 313.23810451,
      lRateDegPerCentury: 428.48202785,
      raanRateDegPerCentury: 0.04240589,
      incRateDegPerCentury: -0.00242939,
      lonPeriRateDegPerCentury: 0.40805281,
      eRatePerCentury: -0.00004397,
      aRatePerCenturyAu: -0.00196176,
    }),
    pole: {
      kind: 'iau',
      ra0Deg: 257.311,
      ra1DegPerCentury: 0.0,
      dec0Deg: -15.175,
      dec1DegPerCentury: 0.0,
      w0Deg: 203.81,
      wRateDegPerDay: -501.1600928,
    },
  },
  neptune: {
    kind: 'planet',
    id: 'neptune',
    mu: MU_NEPTUNE,
    radius: 2.4622e7,
    orbit: planetOrbit({
      a: 30.06992276 * AU,
      e: 0.00859048,
      incDeg: 1.77004347,
      raanDeg: 131.78422574,
      lonPeriDeg: 44.96476227,
      l0Deg: -55.12002969,
      lRateDegPerCentury: 218.45945325,
      raanRateDegPerCentury: -0.00508664,
      incRateDegPerCentury: 0.00035372,
      lonPeriRateDegPerCentury: -0.32241464,
      eRatePerCentury: 0.00005105,
      aRatePerCenturyAu: 0.00026291,
    }),
    pole: NEPTUNE_POLE,
  },
  triton: {
    kind: 'satellite',
    id: 'triton',
    mu: 1.4276e12,
    radius: 1.3534e6,
    planet: 'neptune',
    // 傾斜 90° 超が逆行を表す。
    orbit: equatorialSatelliteOrbit({ a: 3.5476e8, e: 0.000016, incDeg: 156.885, planetMu: MU_NEPTUNE, planetPole: NEPTUNE_POLE }),
  },
  // ネレイド。トリトンの潮汐力に大きく乱された高離心率の遠方軌道で、黄道基準の平均要素を使う
  // (出典・GM/半径の扱いはヒマリア群と同じ)。GM は未測定。
  nereid: {
    kind: 'satellite',
    id: 'nereid',
    mu: 0,
    radius: 1.7e5,
    planet: 'neptune',
    orbit: jplSatelliteOrbit({ a: 5.5139e9, e: 0.751, incDeg: 5.1, periodDays: 360.133039, nodePeriodYears: 0, apsisPeriodYears: 0 }),
  },
  // 準惑星・大型小惑星・彗星核。永年摂動項は解いておらず raanRate 等は
  // すべて 0 — 二体ケプラー軌道のみで、木星等による摂動(彗星核では非重力効果も)は含まない。
  // 軌道要素は JPL Small-Body Database(sbdb.api、full-prec=true)から取得した黄道座標・
  // J2000 の a/e/i/Ω(om)/ω(w)/M(ma) と、その要素の元期(JD)。ハレー・エンケの元期の平均近点角
  // は取得元期のものなので、そこから J2000 まで平均運動で外挿している(冥王星のみ後述の別出典)。
  // lRateDegPerCentury は平均運動 n = 360°/period を世紀あたりへ換算したもの — 周期はケプラー第3
  // 法則 T = 2π√(a³/μ_sun) から SBDB の a のみで独立に計算し(SBDB の per フィールドとも一致)、
  // n = 360°/T。l0Deg(J2000 の平均黄経)は取得元期の平均黄経 L = M+ω+Ω を、この n で J2000 まで
  // 外挿して求めた。
  ceres: {
    kind: 'planet',
    id: 'ceres',
    mu: 6.26e10,
    radius: 4.7e5,
    // 出典: https://ssd-api.jpl.nasa.gov/sbdb.api?sstr=Ceres&full-prec=true (元期 JD2461200.5)
    orbit: planetOrbit({
      a: 2.765552595034094 * AU,
      e: 0.07969229514816586,
      incDeg: 10.58802780183462,
      raanDeg: 80.24862682043221,
      lonPeriDeg: 153.54284135064808,
      l0Deg: 158.7455644908673,
      lRateDegPerCentury: 7827.470059933903,
      raanRateDegPerCentury: 0,
      incRateDegPerCentury: 0,
      lonPeriRateDegPerCentury: 0,
      eRatePerCentury: 0,
      aRatePerCenturyAu: 0,
    }),
  },
  vesta: {
    kind: 'planet',
    id: 'vesta',
    mu: 1.73e10,
    radius: 2.63e5,
    // 出典: https://ssd-api.jpl.nasa.gov/sbdb.api?sstr=Vesta&full-prec=true (元期 JD2461200.5)
    orbit: planetOrbit({
      a: 2.361365965127599 * AU,
      e: 0.09020374382834395,
      incDeg: 7.143925545058711,
      raanDeg: 103.701293265032,
      lonPeriDeg: 255.16994108718842,
      l0Deg: 233.7490090526644,
      lRateDegPerCentury: 9920.860648673672,
      raanRateDegPerCentury: 0,
      incRateDegPerCentury: 0,
      lonPeriRateDegPerCentury: 0,
      eRatePerCentury: 0,
      aRatePerCenturyAu: 0,
    }),
  },
  pallas: {
    kind: 'planet',
    id: 'pallas',
    mu: 1.36e10,
    radius: 2.56e5,
    // 出典: https://ssd-api.jpl.nasa.gov/sbdb.api?sstr=Pallas&full-prec=true (元期 JD2461200.5)
    orbit: planetOrbit({
      a: 2.769559010737709 * AU,
      e: 0.2307000995648547,
      incDeg: 34.93279321851542,
      raanDeg: 172.8866193357694,
      lonPeriDeg: 123.856535500983,
      l0Deg: 113.37790163103682,
      lRateDegPerCentury: 7810.491496842745,
      raanRateDegPerCentury: 0,
      incRateDegPerCentury: 0,
      lonPeriRateDegPerCentury: 0,
      eRatePerCentury: 0,
      aRatePerCenturyAu: 0,
    }),
  },
  // 冥王星は SBDB に対象がないため、a/e/i/Ω/ω は既知値(a=39.482 AU, e=0.2488, i=17.16°,
  // Ω=110.30°, ω=113.83°)を、平均近点角 M0 は JPL Standish の J2000 表(この Ω/ω と数百分の
  // 1° の差で近い値)の L0=238.92903833°・ϖ=224.06891629° から M0=L0−ϖ≈14.860° を借りて
  // 近似値として使う。
  pluto: {
    kind: 'planet',
    id: 'pluto',
    mu: 8.71e11,
    radius: 1.1883e6,
    orbit: planetOrbit({
      a: 39.482 * AU,
      e: 0.2488,
      incDeg: 17.16,
      raanDeg: 110.30,
      lonPeriDeg: 224.13,
      l0Deg: 238.99012204,
      lRateDegPerCentury: 145.10941196758816,
      raanRateDegPerCentury: 0,
      incRateDegPerCentury: 0,
      lonPeriRateDegPerCentury: 0,
      eRatePerCentury: 0,
      aRatePerCenturyAu: 0,
    }),
  },
  haumea: {
    kind: 'planet',
    id: 'haumea',
    mu: 2.67e11,
    radius: 7.8e5, // 平均半径(準楕円体)
    // 出典: https://ssd-api.jpl.nasa.gov/sbdb.api?sstr=Haumea&full-prec=true (元期 JD2461200.5)
    orbit: planetOrbit({
      a: 43.06029023650952 * AU,
      e: 0.1944430148898797,
      incDeg: 28.20847393040364,
      raanDeg: 121.7860561329425,
      lonPeriDeg: 2.4766033838085946,
      l0Deg: 192.00768761548116,
      lRateDegPerCentury: 127.40276965460927,
      raanRateDegPerCentury: 0,
      incRateDegPerCentury: 0,
      lonPeriRateDegPerCentury: 0,
      eRatePerCentury: 0,
      aRatePerCenturyAu: 0,
    }),
  },
  makemake: {
    kind: 'planet',
    id: 'makemake',
    mu: 2.1e11,
    radius: 7.15e5,
    // 出典: https://ssd-api.jpl.nasa.gov/sbdb.api?sstr=Makemake&full-prec=true (元期 JD2461200.5)
    orbit: planetOrbit({
      a: 45.57093317300052 * AU,
      e: 0.1588889953992523,
      incDeg: 29.02785603743067,
      raanDeg: 79.2948338209406,
      lonPeriDeg: 16.387107160661287,
      l0Deg: 155.39032853134051,
      lRateDegPerCentury: 117.02062563483054,
      raanRateDegPerCentury: 0,
      incRateDegPerCentury: 0,
      lonPeriRateDegPerCentury: 0,
      eRatePerCentury: 0,
      aRatePerCenturyAu: 0,
    }),
  },
  eris: {
    kind: 'planet',
    id: 'eris',
    mu: 1.108e12,
    radius: 1.163e6,
    // 出典: https://ssd-api.jpl.nasa.gov/sbdb.api?sstr=Eris&full-prec=true (元期 JD2461200.5)
    orbit: planetOrbit({
      a: 67.93394687853566 * AU,
      e: 0.4382385347971672,
      incDeg: 43.9258279471791,
      raanDeg: 36.00477044417249,
      lonPeriDeg: 186.7996940282037,
      l0Deg: 21.578055953998067,
      lRateDegPerCentury: 64.29304982186218,
      raanRateDegPerCentury: 0,
      incRateDegPerCentury: 0,
      lonPeriRateDegPerCentury: 0,
      eRatePerCentury: 0,
      aRatePerCenturyAu: 0,
    }),
  },
  // 彗星核の μ/半径は観測が乏しく粗い推定値。
  halley: {
    kind: 'planet',
    id: 'halley',
    mu: 1.5e1, // 粗い推定値(核質量 ~2.2e14 kg 相当)
    radius: 5.5e3, // 粗い推定値(核長径の半分程度)
    // 出典: https://ssd-api.jpl.nasa.gov/sbdb.api?sstr=1P&full-prec=true (元期 JD2439875.5、
    // 1968年の近日点通過に近い元期)。非重力効果(彗星核からのガス噴出による軌道擾乱)は
    // 未収録なので、周期・形状は正確だが軌道上の位置は年代が離れるほど粗くなる。
    orbit: planetOrbit({
      a: 17.92863504856923 * AU,
      e: 0.9679359956953211,
      incDeg: 162.1905300439129,
      raanDeg: 59.09894720612437,
      lonPeriDeg: 171.34037866990076,
      l0Deg: 237.23068671379107,
      lRateDegPerCentury: 474.2130029037993,
      raanRateDegPerCentury: 0,
      incRateDegPerCentury: 0,
      lonPeriRateDegPerCentury: 0,
      eRatePerCentury: 0,
      aRatePerCenturyAu: 0,
    }),
  },
  encke: {
    kind: 'planet',
    id: 'encke',
    mu: 4e0, // 粗い推定値(核質量 ~6e13 kg 相当)
    radius: 2.4e3,
    // 出典: https://ssd-api.jpl.nasa.gov/sbdb.api?sstr=2P&full-prec=true (元期 JD2459847.5)
    orbit: planetOrbit({
      a: 2.219688710074586 * AU,
      e: 0.8477496967533629,
      incDeg: 11.41227811179314,
      raanDeg: 334.1935846036774,
      lonPeriDeg: 161.327830973245,
      l0Deg: 90.02574581888393,
      lRateDegPerCentury: 10885.695675063265,
      raanRateDegPerCentury: 0,
      incRateDegPerCentury: 0,
      lonPeriRateDegPerCentury: 0,
      eRatePerCentury: 0,
      aRatePerCenturyAu: 0,
    }),
  },
  sun: { kind: 'star', id: 'sun', mu: MU_SUN, radius: R_SUN },
} satisfies CelestialRegistry;

// SOLAR_SYSTEM を satisfies で受けているため、リテラルなキー集合(SolarSystemId)がそのまま
// 保たれる — CELESTIAL_BODIES(game/celestial/celestial-registry.ts)はこれを Record の
// キーに使うことで、天体を1体追加すると表示名の欠落がコンパイルエラーになる。
export type SolarSystemId = keyof typeof SOLAR_SYSTEM;
export type SolarSystemOrbitingId = { [K in SolarSystemId]: (typeof SOLAR_SYSTEM)[K]['kind'] extends 'star' ? never : K }[SolarSystemId];

// id を registry から引く。registry に無い id を渡すと例外になる。
export function bodyDef(registry: CelestialRegistry, id: AttractorId): CelestialBodyDef {
  const def = registry[id];
  if (def === undefined) throw new Error(`bodyDef: レジストリに登録されていない天体 id: ${id}`);
  return def;
}
