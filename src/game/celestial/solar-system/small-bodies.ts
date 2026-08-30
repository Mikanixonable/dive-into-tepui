// 彗星核・小惑星・太陽系外縁天体。静的事実・運動・見た目を1体につき1箇所で組む。
import { HelioEphemeris } from '../../../physics/absolute-ephemeris';
import {
  PhaseOffsets, PlanetDef, planetDefForSimZero, SatelliteDef, satelliteDefForSimZero, SatelliteMotion, StarMotion,
} from '../../../physics/celestial-motion';
import { planetSystem } from '../../../physics/planet-system';
import { keplerPeriod } from '../../../physics/elements';
import { JULIAN_CENTURY, KeplerOrbit } from '../../../physics/kepler-orbit';
import { AU, planetOrbit } from '../../../physics/planet-orbit';
import { GRAVITATIONAL_CONSTANT, MU_SUN } from './constants';
import { CelestialSurface } from '../../../render/celestial-surface';
import type { CelestialEntity } from '../celestial-entity/celestial-entity';
import { SphereEntity } from '../celestial-entity/sphere-entity';
import { CHARIKLO_RINGS, QUAOAR_RINGS } from './rings';
import { jplSatelliteOrbit } from './satellite-orbit-builders';

// 小天体に登録された天体の id。表示名も構築の網羅性もこの集合が決める。
export type SmallBodyId =
  | 'halley' | 'encke'
  | 'sedna' | 'quaoar' | 'weywot' | 'chariklo' | 'hygiea' | 'eros' | 'ryugu' | 'bennu'
  | 'orcus' | 'vanth' | 'gonggong' | 'salacia' | 'varuna' | 'ixion' | 'arrokoth' | 'chiron'
  | 'interamnia' | 'europa52' | 'davida' | 'juno' | 'psyche' | 'eunomia' | 'sylvia' | 'apophis'
  | 'didymos' | 'tempel1' | 'wild2' | 'hartley2' | 'cruithne' | 'kamooalewa' | 'tk7' | 'eureka';

// 長半径 a [m] から、周回天体の平均運動をケプラー第3法則で世紀あたりの度へ換算する。
// SBDB の公開周期を別途転記すると a と食い違いうるため、常にこれで導く。
function lRateFromSemiMajorAxis(a: number): number {
  return (360 * JULIAN_CENTURY) / keplerPeriod(a, MU_SUN);
}

// JPL Small-Body Database の単一元期の接触要素をそのまま受ける日心軌道。永年変化率は
// いずれも 0(SBDB は単一元期の要素しか公開しない)で、平均運動は長半径から導く。
function sbdbOrbit(p: {
  aAu: number;
  e: number;
  incDeg: number;
  raanDeg: number;
  lonPeriDeg: number;
  l0Deg: number;
}): KeplerOrbit {
  const a = p.aAu * AU;
  return planetOrbit({
    a,
    e: p.e,
    incDeg: p.incDeg,
    raanDeg: p.raanDeg,
    lonPeriDeg: p.lonPeriDeg,
    l0Deg: p.l0Deg,
    lRateDegPerCentury: lRateFromSemiMajorAxis(a),
    raanRateDegPerCentury: 0,
    incRateDegPerCentury: 0,
    lonPeriRateDegPerCentury: 0,
    eRatePerCentury: 0,
    aRatePerCenturyAu: 0,
  });
}

// 彗星核の μ/半径は観測が乏しく粗い推定値。
const HALLEY: PlanetDef = {
  id: 'halley',
  mu: GRAVITATIONAL_CONSTANT * 2.2e14, // 粗い推定値(核質量 ~2.2e14 kg 相当)
  radius: 5.5e3, // 粗い推定値(核長径の半分程度)
  // 出典: https://ssd-api.jpl.nasa.gov/sbdb.api?sstr=1P&full-prec=true (元期 JD2439875.5、
  // 1968年の近日点通過に近い元期)。非重力効果(彗星核からのガス噴出による軌道擾乱)は
  // 未収録なので、周期・形状は正確だが軌道上の位置は年代が離れるほど粗くなる。
  orbit: planetOrbit({
    a: 17.92863504856923 * AU,
    e: 0.9679359956953211,
    incDeg: 162.1905300439129,
    raanDeg: 59.09894720612437,
    lonPeriDeg: 171.3403787,
    l0Deg: 237.2306867,
    lRateDegPerCentury: 474.2130029037993,
    raanRateDegPerCentury: 0,
    incRateDegPerCentury: 0,
    lonPeriRateDegPerCentury: 0,
    eRatePerCentury: 0,
    aRatePerCenturyAu: 0,
  }),
};

const ENCKE: PlanetDef = {
  id: 'encke',
  mu: GRAVITATIONAL_CONSTANT * 6e13, // 粗い推定値(核質量 ~6e13 kg 相当)
  radius: 2.4e3,
  // 出典: https://ssd-api.jpl.nasa.gov/sbdb.api?sstr=2P&full-prec=true (元期 JD2459847.5)
  orbit: planetOrbit({
    a: 2.219688710074586 * AU,
    e: 0.8477496967533629,
    incDeg: 11.41227811179314,
    raanDeg: 334.1935846036774,
    lonPeriDeg: 161.327831,
    l0Deg: 90.0257458,
    lRateDegPerCentury: 10885.695675063265,
    raanRateDegPerCentury: 0,
    incRateDegPerCentury: 0,
    lonPeriRateDegPerCentury: 0,
    eRatePerCentury: 0,
    aRatePerCenturyAu: 0,
  }),
};

// 太陽を公転する小天体32個。永年変化率はいずれも0(SBDBは単一元期の接触要素のみを公開)。
// 軌道要素は JPL Small-Body Database(sbdb.api、full-prec=true、元期 JD2461200.5)の
// 黄道座標・J2000 の a/e/i/Ω(om)/ω(w)/M(ma) から、raanDeg=Ω・lonPeriDeg=Ω+ω・
// l0Deg=Ω+ω+M として求めた(360を超えて構わない)。lRateDegPerCentury は
// lRateFromSemiMajorAxis(a) がケプラー第3法則から導く。SBDB の元期は天体ごとに異なり、
// tempel1(JD2457470.5)・wild2(JD2458808.5)・
// hartley2(JD2457152.5)・bennu(JD2455562.5)だけが上記と別の元期を持つ — この実装は
// どの元期も simTime=0 に対応させるので、同一の実在時刻の空を再現しているわけではない。
// GM は SBDB(なければ 0 = 質量未測定)、直径は SBDB または各天体の観測文献。
// セドナのみ直径が未測定なので、掩蔽・熱赤外観測から広く引用される推定値(半径 500 km)を
// 代わりに使う — 描画にも衝突判定にも半径が要るため、値が無いままにはできない。
// 三軸半径 [km](a>=b>=c)は探査機・掩蔽・レーダー・適応光学など天体ごとに別の観測による。
const SEDNA: PlanetDef = {
  id: 'sedna',
  mu: 0,
  radius: 500000.0,
  orbit: sbdbOrbit({ aAu: 543.7195289, e: 0.8598825, incDeg: 11.9252758, raanDeg: 144.5061663, lonPeriDeg: 455.6049389, l0Deg: 814.2006333 }),
};

export const QUAOAR: PlanetDef = {
  id: 'quaoar',
  mu: 0,
  radius: 545000.0,
  rings: QUAOAR_RINGS,
  orbit: sbdbOrbit({ aAu: 43.1561765, e: 0.0352002, incDeg: 7.9915758, raanDeg: 188.9191248, lonPeriDeg: 352.1281758, l0Deg: 644.9769333 }),
};

// クワオアーの衛星ウェイウォット。基準面は黄道面(出典・扱いはハウメアの衛星と同じ)。
const WEYWOT: SatelliteDef = {
  id: 'weywot',
  mu: GRAVITATIONAL_CONSTANT * 2.4e18,
  radius: 72e3,
  orbit: jplSatelliteOrbit({ a: 13329e3, e: 0.01111, incDeg: 13.62, periodDays: 12.42727, nodePeriodYears: 0, apsisPeriodYears: 0 }),
};

const CHARIKLO: PlanetDef = {
  id: 'chariklo',
  mu: 0,
  radius: 143800.0, // 三軸の最長半軸(外接球)
  shape: { kind: 'triaxial', a: 143800.0, b: 135200.0, c: 99100.0 },
  rings: CHARIKLO_RINGS,
  orbit: sbdbOrbit({ aAu: 15.7343733, e: 0.1708196, incDeg: 23.4319043, raanDeg: 300.476891, lonPeriDeg: 541.6834978, l0Deg: 671.7725806 }),
};

const HYGIEA: PlanetDef = {
  id: 'hygiea',
  mu: 7000000000.0,
  radius: 217000.0, // 三軸の最長半軸(外接球)
  shape: { kind: 'triaxial', a: 217000.0, b: 213000.0, c: 210000.0 },
  orbit: sbdbOrbit({ aAu: 3.150974, e: 0.1067093, incDeg: 3.8295299, raanDeg: 283.1198928, lonPeriDeg: 595.5441315, l0Deg: 847.5785557 }),
};

const EROS: PlanetDef = {
  id: 'eros',
  mu: 446300.0,
  radius: 17200.0, // 三軸の最長半軸(外接球)
  shape: { kind: 'triaxial', a: 17200.0, b: 5600.0, c: 5600.0 },
  orbit: sbdbOrbit({ aAu: 1.4582437, e: 0.222878, incDeg: 10.8285441, raanDeg: 304.2679713, lonPeriDeg: 483.1861032, l0Deg: 545.6975582 }),
};

const RYUGU: PlanetDef = {
  id: 'ryugu',
  mu: 30.0,
  radius: 448.0,
  orbit: sbdbOrbit({ aAu: 1.1909189, e: 0.191073, incDeg: 5.8664425, raanDeg: 251.2897124, lonPeriDeg: 462.8987063, l0Deg: 525.2393806 }),
};

const BENNU: PlanetDef = {
  id: 'bennu',
  mu: 4.8904,
  radius: 252.35, // 三軸の最長半軸(外接球)
  shape: { kind: 'triaxial', a: 252.35, b: 245.9, c: 228.35 },
  orbit: sbdbOrbit({ aAu: 1.126391, e: 0.2037451, incDeg: 6.0349438, raanDeg: 2.0608662, lonPeriDeg: 68.283927, l0Deg: 169.987879 }),
};

export const ORCUS: PlanetDef = {
  id: 'orcus',
  mu: 0,
  radius: 479200.0,
  orbit: sbdbOrbit({ aAu: 39.377, e: 0.22052, incDeg: 20.5568, raanDeg: 268.4054, lonPeriDeg: 341.9739, l0Deg: 531.0712 }),
};

// オルクスの衛星ヴァンス。基準面は黄道面(出典・扱いはハウメアの衛星と同じ)。
const VANTH: SatelliteDef = {
  id: 'vanth',
  mu: GRAVITATIONAL_CONSTANT * 8.7e19,
  radius: 221.25e3,
  orbit: jplSatelliteOrbit({ a: 8999.8e3, e: 0.00091, incDeg: 90.54, periodDays: 9.539154, nodePeriodYears: 0, apsisPeriodYears: 0 }),
};

const GONGGONG: PlanetDef = {
  id: 'gonggong',
  mu: 0,
  radius: 615000.0,
  orbit: sbdbOrbit({ aAu: 66.867, e: 0.50425, incDeg: 30.8991, raanDeg: 336.8383, lonPeriDeg: 543.4615, l0Deg: 655.1263 }),
};

const SALACIA: PlanetDef = {
  id: 'salacia',
  mu: 0,
  radius: 419000.0,
  orbit: sbdbOrbit({ aAu: 42.055, e: 0.1046, incDeg: 23.9272, raanDeg: 280.2543, lonPeriDeg: 589.2316, l0Deg: 723.9095 }),
};

const VARUNA: PlanetDef = {
  id: 'varuna',
  mu: 0,
  radius: 450000.0,
  orbit: sbdbOrbit({ aAu: 43.2, e: 0.051615, incDeg: 17.1405, raanDeg: 97.2158, lonPeriDeg: 370.5748, l0Deg: 486.2427 }),
};

const IXION: PlanetDef = {
  id: 'ixion',
  mu: 0,
  radius: 348390.0,
  orbit: sbdbOrbit({ aAu: 39.346, e: 0.24356, incDeg: 19.6625, raanDeg: 71.0808, lonPeriDeg: 371.7031, l0Deg: 666.6707 }),
};

const ARROKOTH: PlanetDef = {
  id: 'arrokoth',
  mu: 0,
  radius: 17500.0, // 三軸の最長半軸(外接球)
  shape: { kind: 'triaxial', a: 17500.0, b: 10000.0, c: 5000.0 },
  orbit: sbdbOrbit({ aAu: 44.053, e: 0.03556, incDeg: 2.4506, raanDeg: 159.0377, lonPeriDeg: 347.8884, l0Deg: 658.8723 }),
};

const CHIRON: PlanetDef = {
  id: 'chiron',
  mu: 0,
  radius: 63000.0, // 三軸の最長半軸(外接球)
  shape: { kind: 'triaxial', a: 63000.0, b: 54500.0, c: 34000.0 },
  orbit: sbdbOrbit({ aAu: 13.68427, e: 0.379766, incDeg: 6.93057, raanDeg: 209.2961, lonPeriDeg: 548.5839, l0Deg: 765.3038 }),
};

const INTERAMNIA: PlanetDef = {
  id: 'interamnia',
  mu: 0,
  radius: 181000.0, // 三軸の最長半軸(外接球)
  shape: { kind: 'triaxial', a: 181000.0, b: 174000.0, c: 155000.0 },
  orbit: sbdbOrbit({ aAu: 3.056812, e: 0.155059, incDeg: 17.3153, raanDeg: 280.1672, lonPeriDeg: 374.2289, l0Deg: 595.3737 }),
};

const EUROPA52: PlanetDef = {
  id: 'europa52',
  mu: 0,
  radius: 151959.0,
  orbit: sbdbOrbit({ aAu: 3.094136, e: 0.112483, incDeg: 7.4815, raanDeg: 128.5734, lonPeriDeg: 471.3774, l0Deg: 820.3002 }),
};

const DAVIDA: PlanetDef = {
  id: 'davida',
  mu: 0,
  radius: 178500.0, // 三軸の最長半軸(外接球)
  shape: { kind: 'triaxial', a: 178500.0, b: 147000.0, c: 115500.0 },
  orbit: sbdbOrbit({ aAu: 3.161793, e: 0.189373, incDeg: 15.9498, raanDeg: 107.5541, lonPeriDeg: 444.084, l0Deg: 514.52 }),
};

const JUNO: PlanetDef = {
  id: 'juno',
  mu: 0,
  radius: 123298.0,
  orbit: sbdbOrbit({ aAu: 2.67099, e: 0.2557, incDeg: 12.9866, raanDeg: 169.8116, lonPeriDeg: 417.7067, l0Deg: 680.439 }),
};

const PSYCHE: PlanetDef = {
  id: 'psyche',
  mu: 0,
  radius: 139000.0, // 三軸の最長半軸(外接球)
  shape: { kind: 'triaxial', a: 139000.0, b: 119000.0, c: 85500.0 },
  orbit: sbdbOrbit({ aAu: 2.92572, e: 0.134932, incDeg: 3.0987, raanDeg: 149.9754, lonPeriDeg: 380.0081, l0Deg: 459.7775 }),
};

const EUNOMIA: PlanetDef = {
  id: 'eunomia',
  mu: 0,
  radius: 170000.0, // 三軸の最長半軸(外接球)
  shape: { kind: 'triaxial', a: 170000.0, b: 124000.0, c: 114500.0 },
  orbit: sbdbOrbit({ aAu: 2.641959, e: 0.187771, incDeg: 11.7614, raanDeg: 292.8808, lonPeriDeg: 391.3421, l0Deg: 551.0312 }),
};

const SYLVIA: PlanetDef = {
  id: 'sylvia',
  mu: 0,
  radius: 181500.0, // 三軸の最長半軸(外接球)
  shape: { kind: 'triaxial', a: 181500.0, b: 124500.0, c: 95500.0 },
  orbit: sbdbOrbit({ aAu: 3.490931, e: 0.094242, incDeg: 10.8493, raanDeg: 72.946, lonPeriDeg: 340.0475, l0Deg: 463.9674 }),
};

const APOPHIS: PlanetDef = {
  id: 'apophis',
  mu: 0,
  radius: 170.0,
  orbit: sbdbOrbit({ aAu: 0.922359, e: 0.191149, incDeg: 3.340997, raanDeg: 203.8937, lonPeriDeg: 330.5733, l0Deg: 505.9037 }),
};

const DIDYMOS: PlanetDef = {
  id: 'didymos',
  mu: GRAVITATIONAL_CONSTANT * 5.2e11,
  radius: 398.5, // 三軸の最長半軸(外接球)
  shape: { kind: 'triaxial', a: 398.5, b: 391.5, c: 380.5 },
  orbit: sbdbOrbit({ aAu: 1.64271, e: 0.383123, incDeg: 3.413877, raanDeg: 72.9858, lonPeriDeg: 392.5665, l0Deg: 653.4278 }),
};

const TEMPEL1: PlanetDef = {
  id: 'tempel1',
  mu: 0,
  radius: 3000.0,
  orbit: sbdbOrbit({ aAu: 3.146134, e: 0.5097, incDeg: 10.4734, raanDeg: 68.7536, lonPeriDeg: 247.9509, l0Deg: 584.5363 }),
};

const WILD2: PlanetDef = {
  id: 'wild2',
  mu: 0,
  radius: 2000.0,
  orbit: sbdbOrbit({ aAu: 3.449746, e: 0.5374, incDeg: 3.237, raanDeg: 136.1102, lonPeriDeg: 177.8354, l0Deg: 365.4321 }),
};

const HARTLEY2: PlanetDef = {
  id: 'hartley2',
  mu: 0,
  radius: 800.0,
  orbit: sbdbOrbit({ aAu: 3.475652, e: 0.6936, incDeg: 13.5995, raanDeg: 219.7422, lonPeriDeg: 401.064, l0Deg: 652.8462 }),
};

const CRUITHNE: PlanetDef = {
  id: 'cruithne',
  mu: 0,
  radius: 1035.5,
  orbit: sbdbOrbit({ aAu: 0.997797, e: 0.5149, incDeg: 19.8024, raanDeg: 126.1887, lonPeriDeg: 170.0717, l0Deg: 352.2041 }),
};

const KAMOOALEWA: PlanetDef = {
  id: 'kamooalewa',
  mu: 0,
  radius: 34.0, // 三軸の最長半軸(外接球)
  shape: { kind: 'triaxial', a: 34.0, b: 23.0, c: 19.5 },
  orbit: sbdbOrbit({ aAu: 1.00081, e: 0.10224, incDeg: 7.8026, raanDeg: 65.5932, lonPeriDeg: 369.9564, l0Deg: 613.3436 }),
};

const TK7: PlanetDef = {
  id: 'tk7',
  mu: 0,
  radius: 189.5,
  orbit: sbdbOrbit({ aAu: 0.998508, e: 0.19027, incDeg: 20.9057, raanDeg: 96.4145, lonPeriDeg: 142.4843, l0Deg: 286.9046 }),
};

const EUREKA: PlanetDef = {
  id: 'eureka',
  mu: 0,
  radius: 939.0,
  orbit: sbdbOrbit({ aAu: 1.523573, e: 0.06485, incDeg: 20.2811, raanDeg: 245.0121, lonPeriDeg: 340.4941, l0Deg: 677.4051 }),
};

// 彗星核・小惑星・太陽系外縁天体の表示名。
export const SMALL_BODY_NAMES: Record<SmallBodyId, string> = {
  halley: 'ハレー彗星',
  encke: 'エンケ彗星',
  sedna: 'セドナ',
  quaoar: 'クワオアー',
  weywot: 'ウェイウォット',
  chariklo: 'カリクロー',
  hygiea: 'ヒギエア',
  eros: 'エロス',
  ryugu: 'リュウグウ',
  bennu: 'ベンヌ',
  orcus: 'オルクス',
  vanth: 'ヴァンス',
  gonggong: 'ゴンゴン',
  salacia: 'サラキア',
  varuna: 'ヴァルナ',
  ixion: 'イクシオン',
  arrokoth: 'アロコス',
  chiron: 'キロン',
  interamnia: 'インテラムニア',
  europa52: 'エウロパ (52)',
  davida: 'ダビダ',
  juno: 'ジュノー',
  psyche: 'プシケ',
  eunomia: 'エウノミア',
  sylvia: 'シルビア',
  apophis: 'アポフィス',
  didymos: 'ディディモス',
  tempel1: 'テンペル第1彗星',
  wild2: 'ワイルド第2彗星',
  hartley2: 'ハートレー第2彗星',
  cruithne: 'クルースン',
  kamooalewa: 'カモオアレワ',
  tk7: '2010 TK7',
  eureka: 'エウレカ',
};

// 彗星核・小惑星・太陽系外縁天体を組む。宣言順がそのまま重力源配列・一覧の順序になる。
export function smallBodies(
  sun: StarMotion, phases: PhaseOffsets, simZeroEt: number,
  pack: HelioEphemeris | null,
): Record<SmallBodyId, CelestialEntity> {
  // 衛星を持つ天体の運動は、子の主天体として渡すため先に組む。
  const quaoar = planetSystem(planetDefForSimZero(QUAOAR, phases, simZeroEt), sun, pack);
  const orcus = planetSystem(planetDefForSimZero(ORCUS, phases, simZeroEt), sun, pack);
  return {
    // ハレー彗星 A_B=0.016(幾何 0.04 x q=0.393)
    halley: new SphereEntity(
      planetSystem(planetDefForSimZero(HALLEY, phases, simZeroEt), sun, pack).body,
      SMALL_BODY_NAMES.halley, 'smallBody', CelestialSurface.solid([0.0160, 0.0160, 0.0160]),
    ),
    // エンケ彗星 A_B=0.02(幾何 0.05 x q=0.393)
    encke: new SphereEntity(
      planetSystem(planetDefForSimZero(ENCKE, phases, simZeroEt), sun, pack).body,
      SMALL_BODY_NAMES.encke, 'smallBody', CelestialSurface.solid([0.0200, 0.0200, 0.0200]),
    ),
    // セドナ A_B=0.15(幾何 0.32 x q=0.461)
    sedna: new SphereEntity(
      planetSystem(planetDefForSimZero(SEDNA, phases, simZeroEt), sun, pack).body,
      SMALL_BODY_NAMES.sedna, 'dwarf', CelestialSurface.solid([0.1759, 0.1453, 0.1203]),
    ),
    // クワオアー A_B=0.05(幾何 0.109 x q=0.461)
    quaoar: new SphereEntity(
      quaoar.body, SMALL_BODY_NAMES.quaoar, 'dwarf', CelestialSurface.solid([0.0616, 0.0479, 0.0363]),
    ),
    // ウェイウォット A_B=0.046(分類既定 幾何 0.10 x q=0.461)
    weywot: new SphereEntity(
      new SatelliteMotion(satelliteDefForSimZero(WEYWOT, phases, simZeroEt), quaoar, pack),
      SMALL_BODY_NAMES.weywot, 'satellite', CelestialSurface.solid([0.0527, 0.0447, 0.0389]),
    ),
    // カリクロー A_B=0.014(幾何 0.035 x q=0.393)
    chariklo: new SphereEntity(
      planetSystem(planetDefForSimZero(CHARIKLO, phases, simZeroEt), sun, pack).body,
      SMALL_BODY_NAMES.chariklo, 'smallBody', CelestialSurface.solid([0.0161, 0.0137, 0.0108]),
    ),
    // ヒギエア A_B=0.028(幾何 0.072 x q=0.393)
    hygiea: new SphereEntity(
      planetSystem(planetDefForSimZero(HYGIEA, phases, simZeroEt), sun, pack).body,
      SMALL_BODY_NAMES.hygiea, 'smallBody', CelestialSurface.solid([0.0301, 0.0278, 0.0239]),
    ),
    // エロス A_B=0.115(幾何 0.25 x q=0.461)
    eros: new SphereEntity(
      planetSystem(planetDefForSimZero(EROS, phases, simZeroEt), sun, pack).body,
      SMALL_BODY_NAMES.eros, 'smallBody', CelestialSurface.solid([0.1367, 0.1129, 0.0718]),
    ),
    // リュウグウ A_B=0.018(幾何 0.045 x q=0.393)
    ryugu: new SphereEntity(
      planetSystem(planetDefForSimZero(RYUGU, phases, simZeroEt), sun, pack).body,
      SMALL_BODY_NAMES.ryugu, 'smallBody', CelestialSurface.solid([0.0212, 0.0174, 0.0141]),
    ),
    // ベンヌ A_B=0.017(幾何 0.044 x q=0.393)
    bennu: new SphereEntity(
      planetSystem(planetDefForSimZero(BENNU, phases, simZeroEt), sun, pack).body,
      SMALL_BODY_NAMES.bennu, 'smallBody', CelestialSurface.solid([0.0196, 0.0166, 0.0138]),
    ),
    // オルクス A_B=0.106(幾何 0.23 x q=0.461)
    orcus: new SphereEntity(
      orcus.body, SMALL_BODY_NAMES.orcus, 'dwarf', CelestialSurface.solid([0.1053, 0.1053, 0.1146]),
    ),
    // ヴァンス A_B=0.031(幾何 0.08 x q=0.393)
    vanth: new SphereEntity(
      new SatelliteMotion(satelliteDefForSimZero(VANTH, phases, simZeroEt), orcus, pack),
      SMALL_BODY_NAMES.vanth, 'satellite', CelestialSurface.solid([0.0355, 0.0301, 0.0262]),
    ),
    // ゴンゴン A_B=0.065(幾何 0.14 x q=0.461)
    gonggong: new SphereEntity(
      planetSystem(planetDefForSimZero(GONGGONG, phases, simZeroEt), sun, pack).body,
      SMALL_BODY_NAMES.gonggong, 'dwarf', CelestialSurface.solid([0.1126, 0.0540, 0.0336]),
    ),
    // サラキア A_B=0.017(幾何 0.042 x q=0.393)
    salacia: new SphereEntity(
      planetSystem(planetDefForSimZero(SALACIA, phases, simZeroEt), sun, pack).body,
      SMALL_BODY_NAMES.salacia, 'dwarf', CelestialSurface.solid([0.0151, 0.0171, 0.0216]),
    ),
    // ヴァルナ A_B=0.059(幾何 0.127 x q=0.461)
    varuna: new SphereEntity(
      planetSystem(planetDefForSimZero(VARUNA, phases, simZeroEt), sun, pack).body,
      SMALL_BODY_NAMES.varuna, 'dwarf', CelestialSurface.solid([0.0645, 0.0585, 0.0476]),
    ),
    // イクシオン A_B=0.05(幾何 0.108 x q=0.461)
    ixion: new SphereEntity(
      planetSystem(planetDefForSimZero(IXION, phases, simZeroEt), sun, pack).body,
      SMALL_BODY_NAMES.ixion, 'dwarf', CelestialSurface.solid([0.0589, 0.0485, 0.0392]),
    ),
    // アロコス A_B=0.065(幾何 0.165 x q=0.393)
    arrokoth: new SphereEntity(
      planetSystem(planetDefForSimZero(ARROKOTH, phases, simZeroEt), sun, pack).body,
      SMALL_BODY_NAMES.arrokoth, 'smallBody', CelestialSurface.solid([0.1783, 0.0365, 0.0135]),
    ),
    // キロン A_B=0.063(幾何 0.16 x q=0.393)
    chiron: new SphereEntity(
      planetSystem(planetDefForSimZero(CHIRON, phases, simZeroEt), sun, pack).body,
      SMALL_BODY_NAMES.chiron, 'smallBody', CelestialSurface.solid([0.0695, 0.0623, 0.0512]),
    ),
    // インテラムニア A_B=0.029(幾何 0.074 x q=0.393)
    interamnia: new SphereEntity(
      planetSystem(planetDefForSimZero(INTERAMNIA, phases, simZeroEt), sun, pack).body,
      SMALL_BODY_NAMES.interamnia, 'smallBody', CelestialSurface.solid([0.0308, 0.0288, 0.0251]),
    ),
    // エウロパ (52) A_B=0.023(幾何 0.058 x q=0.393)
    europa52: new SphereEntity(
      planetSystem(planetDefForSimZero(EUROPA52, phases, simZeroEt), sun, pack).body,
      SMALL_BODY_NAMES.europa52, 'smallBody', CelestialSurface.solid([0.0251, 0.0228, 0.0192]),
    ),
    // ダビダ A_B=0.021(幾何 0.054 x q=0.393)
    davida: new SphereEntity(
      planetSystem(planetDefForSimZero(DAVIDA, phases, simZeroEt), sun, pack).body,
      SMALL_BODY_NAMES.davida, 'smallBody', CelestialSurface.solid([0.0230, 0.0208, 0.0173]),
    ),
    // ジュノー A_B=0.11(幾何 0.238 x q=0.461)
    juno: new SphereEntity(
      planetSystem(planetDefForSimZero(JUNO, phases, simZeroEt), sun, pack).body,
      SMALL_BODY_NAMES.juno, 'smallBody', CelestialSurface.solid([0.1285, 0.1070, 0.0849]),
    ),
    // プシケ A_B=0.055(幾何 0.12 x q=0.461)
    psyche: new SphereEntity(
      planetSystem(planetDefForSimZero(PSYCHE, phases, simZeroEt), sun, pack).body,
      SMALL_BODY_NAMES.psyche, 'smallBody', CelestialSurface.solid([0.0606, 0.0540, 0.0479]),
    ),
    // エウノミア A_B=0.096(幾何 0.209 x q=0.461)
    eunomia: new SphereEntity(
      planetSystem(planetDefForSimZero(EUNOMIA, phases, simZeroEt), sun, pack).body,
      SMALL_BODY_NAMES.eunomia, 'smallBody', CelestialSurface.solid([0.1125, 0.0942, 0.0654]),
    ),
    // シルビア A_B=0.018(幾何 0.045 x q=0.393)
    sylvia: new SphereEntity(
      planetSystem(planetDefForSimZero(SYLVIA, phases, simZeroEt), sun, pack).body,
      SMALL_BODY_NAMES.sylvia, 'smallBody', CelestialSurface.solid([0.0198, 0.0177, 0.0157]),
    ),
    // アポフィス A_B=0.161(幾何 0.35 x q=0.461)
    apophis: new SphereEntity(
      planetSystem(planetDefForSimZero(APOPHIS, phases, simZeroEt), sun, pack).body,
      SMALL_BODY_NAMES.apophis, 'smallBody', CelestialSurface.solid([0.1698, 0.1595, 0.1496]),
    ),
    // ディディモス A_B=0.069(幾何 0.15 x q=0.461)
    didymos: new SphereEntity(
      planetSystem(planetDefForSimZero(DIDYMOS, phases, simZeroEt), sun, pack).body,
      SMALL_BODY_NAMES.didymos, 'smallBody', CelestialSurface.solid([0.0733, 0.0685, 0.0616]),
    ),
    // テンペル第1彗星 A_B=0.016(幾何 0.04 x q=0.393)
    tempel1: new SphereEntity(
      planetSystem(planetDefForSimZero(TEMPEL1, phases, simZeroEt), sun, pack).body,
      SMALL_BODY_NAMES.tempel1, 'smallBody', CelestialSurface.solid([0.0160, 0.0160, 0.0160]),
    ),
    // ワイルド第2彗星 A_B=0.012(幾何 0.03 x q=0.393)
    wild2: new SphereEntity(
      planetSystem(planetDefForSimZero(WILD2, phases, simZeroEt), sun, pack).body,
      SMALL_BODY_NAMES.wild2, 'smallBody', CelestialSurface.solid([0.0120, 0.0120, 0.0120]),
    ),
    // ハートレー第2彗星 A_B=0.011(幾何 0.028 x q=0.393)
    hartley2: new SphereEntity(
      planetSystem(planetDefForSimZero(HARTLEY2, phases, simZeroEt), sun, pack).body,
      SMALL_BODY_NAMES.hartley2, 'smallBody', CelestialSurface.solid([0.0110, 0.0110, 0.0110]),
    ),
    // クルースン A_B=0.069(分類既定 幾何 0.15 x q=0.461)
    cruithne: new SphereEntity(
      planetSystem(planetDefForSimZero(CRUITHNE, phases, simZeroEt), sun, pack).body,
      SMALL_BODY_NAMES.cruithne, 'smallBody', CelestialSurface.solid([0.0763, 0.0682, 0.0557]),
    ),
    // カモオアレワ A_B=0.111(幾何 0.24 x q=0.461)
    kamooalewa: new SphereEntity(
      planetSystem(planetDefForSimZero(KAMOOALEWA, phases, simZeroEt), sun, pack).body,
      SMALL_BODY_NAMES.kamooalewa, 'smallBody', CelestialSurface.solid([0.1394, 0.1073, 0.0643]),
    ),
    // 2010 TK7 A_B=0.039(分類既定 幾何 0.10 x q=0.393)
    tk7: new SphereEntity(
      planetSystem(planetDefForSimZero(TK7, phases, simZeroEt), sun, pack).body,
      SMALL_BODY_NAMES.tk7, 'smallBody', CelestialSurface.solid([0.0432, 0.0383, 0.0337]),
    ),
    // エウレカ A_B=0.18(幾何 0.39 x q=0.461)
    eureka: new SphereEntity(
      planetSystem(planetDefForSimZero(EUREKA, phases, simZeroEt), sun, pack).body,
      SMALL_BODY_NAMES.eureka, 'smallBody', CelestialSurface.solid([0.2377, 0.1718, 0.0912]),
    ),
  };
}
