// 準惑星・大型小惑星とその衛星。静的事実・運動・見た目を1体につき1箇所で組む。
import { OriginCenteredEphemeris } from '../../../physics/absolute-ephemeris';
import {
  EciOrigin, PhaseOffsets, PlanetDef, PlanetMotion, SatelliteDef, SatelliteMotion, StarMotion,
} from '../../../physics/celestial-motion';
import { AU, planetOrbit } from '../../../physics/planet-orbit';
import { GRAVITATIONAL_CONSTANT } from './constants';
import { CelestialSurface } from '../../../render/celestial-surface';
import type { CelestialEntity } from '../celestial-entity/celestial-entity';
import { SphereEntity } from '../celestial-entity/sphere-entity';
import { PLUTO_POLE, equatorBasis } from './poles';
import { jplSatelliteOrbit } from './satellite-orbit-builders';

// 準惑星・大型小惑星とその衛星に登録された天体の id。表示名も構築の網羅性もこの集合が決める。
export type DwarfPlanetId =
  | 'ceres' | 'vesta' | 'pallas'
  | 'pluto' | 'charon' | 'styx' | 'nix' | 'kerberos' | 'hydra'
  | 'haumea' | 'hiiaka' | 'namaka'
  | 'makemake'
  | 'eris' | 'dysnomia';

// 準惑星・大型小惑星・彗星核。永年摂動項は解いておらず raanRate 等は
// すべて 0 — 二体ケプラー軌道のみで、木星等による摂動(彗星核では非重力効果も)は含まない。
// 軌道要素は JPL Small-Body Database(sbdb.api、full-prec=true)から取得した黄道座標・
// J2000 の a/e/i/Ω(om)/ω(w)/M(ma) と、その要素の元期(JD)。ハレー・エンケの元期の平均近点角
// は取得元期のものなので、そこから J2000 まで平均運動で外挿している(冥王星のみ後述の別出典)。
// lRateDegPerCentury は平均運動 n = 360°/period を世紀あたりへ換算したもの — 周期はケプラー第3
// 法則 T = 2π√(a³/μ_sun) から SBDB の a のみで独立に計算し(SBDB の per フィールドとも一致)、
// n = 360°/T。l0Deg(J2000 の平均黄経)は取得元期の平均黄経 L = M+ω+Ω を、この n で J2000 まで
// 外挿して求めた。
export const CERES: PlanetDef = {
  id: 'ceres',
  mu: 6.26e10,
  radius: 4.831e5, // 三軸の最長半軸(外接球)
  // 出典: pck00011.tpc BODY_RADII(直径 966.2 × 962.0 × 891.8 km を半径に換算)
  shape: { kind: 'triaxial', a: 4.831e5, b: 4.81e5, c: 4.459e5 },
  // 出典: https://ssd-api.jpl.nasa.gov/sbdb.api?sstr=Ceres&full-prec=true (元期 JD2461200.5)
  orbit: planetOrbit({
    a: 2.765552595034094 * AU,
    e: 0.07969229514816586,
    incDeg: 10.58802780183462,
    raanDeg: 80.24862682043221,
    lonPeriDeg: 153.5428414,
    l0Deg: 158.7455645,
    lRateDegPerCentury: 7827.470059933903,
    raanRateDegPerCentury: 0,
    incRateDegPerCentury: 0,
    lonPeriRateDegPerCentury: 0,
    eRatePerCentury: 0,
    aRatePerCenturyAu: 0,
  }),
};

const VESTA: PlanetDef = {
  id: 'vesta',
  mu: 1.73e10,
  radius: 2.863e5, // 三軸の最長半軸(外接球)
  // 出典: pck00011.tpc BODY_RADII(直径 572.6 × 557.2 × 446.4 km を半径に換算)
  shape: { kind: 'triaxial', a: 2.863e5, b: 2.786e5, c: 2.232e5 },
  // 出典: https://ssd-api.jpl.nasa.gov/sbdb.api?sstr=Vesta&full-prec=true (元期 JD2461200.5)
  orbit: planetOrbit({
    a: 2.361365965127599 * AU,
    e: 0.09020374382834395,
    incDeg: 7.143925545058711,
    raanDeg: 103.701293265032,
    lonPeriDeg: 255.1699411,
    l0Deg: 233.7490091,
    lRateDegPerCentury: 9920.860648673672,
    raanRateDegPerCentury: 0,
    incRateDegPerCentury: 0,
    lonPeriRateDegPerCentury: 0,
    eRatePerCentury: 0,
    aRatePerCenturyAu: 0,
  }),
};

const PALLAS: PlanetDef = {
  id: 'pallas',
  mu: 1.36e10,
  radius: 2.56e5,
  // 三軸データ(568×532×448 / 550×516×476 km)は測定手法間で収束しておらず、一方を選ぶ根拠が
  // ないため shape なし(真球)のままとする。
  // 出典: https://ssd-api.jpl.nasa.gov/sbdb.api?sstr=Pallas&full-prec=true (元期 JD2461200.5)
  orbit: planetOrbit({
    a: 2.769559010737709 * AU,
    e: 0.2307000995648547,
    incDeg: 34.93279321851542,
    raanDeg: 172.8866193357694,
    lonPeriDeg: 123.8565355,
    l0Deg: 113.3779016,
    lRateDegPerCentury: 7810.491496842745,
    raanRateDegPerCentury: 0,
    incRateDegPerCentury: 0,
    lonPeriRateDegPerCentury: 0,
    eRatePerCentury: 0,
    aRatePerCenturyAu: 0,
  }),
};

// 冥王星は SBDB に対象がないため、a/e/i/Ω/ω は既知値(a=39.482 AU, e=0.2488, i=17.16°,
// Ω=110.30°, ω=113.83°)を、平均近点角 M0 は JPL Standish の J2000 表(この Ω/ω と数百分の
// 1° の差で近い値)の L0=238.92903833°・ϖ=224.06891629° から M0=L0−ϖ≈14.860° を借りて
// 近似値として使う。
export const PLUTO: PlanetDef = {
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
  pole: PLUTO_POLE,
};

// 冥王星の衛星5個。基準面は冥王星-カロン共通重心の赤道面(equatorBasis(PLUTO_POLE))。
// 出典は天王星衛星と同じ JPL Solar System Dynamics 表。歳差周期は5体とも未公開(=0)。
const CHARON: SatelliteDef = {
  id: 'charon',
  mu: 106.1e9,
  radius: 606.0e3,
  orbit: jplSatelliteOrbit({ a: 19600e3, e: 0.000, incDeg: 0.0, periodDays: 6.387222, nodePeriodYears: 0, apsisPeriodYears: 0, basisToEci: equatorBasis(PLUTO_POLE) }),
};

const STYX: SatelliteDef = {
  id: 'styx',
  // GM は上限値(< 0.0003 km^3/s^2)しか無く実測でないため 0 として扱う。
  mu: 0,
  radius: 5.2e3,
  orbit: jplSatelliteOrbit({ a: 43200e3, e: 0.025, incDeg: 0.0, periodDays: 20.16, nodePeriodYears: 0, apsisPeriodYears: 0, basisToEci: equatorBasis(PLUTO_POLE) }),
};

const NIX: SatelliteDef = {
  id: 'nix',
  mu: 0.0015e9,
  radius: 18.0e3,
  orbit: jplSatelliteOrbit({ a: 49300e3, e: 0.015, incDeg: 0.0, periodDays: 24.85, nodePeriodYears: 0, apsisPeriodYears: 0, basisToEci: equatorBasis(PLUTO_POLE) }),
};

const KERBEROS: SatelliteDef = {
  id: 'kerberos',
  // GM は上限値(< 0.0002 km^3/s^2)しか無く実測でないため 0 として扱う。
  mu: 0,
  radius: 6.0e3,
  orbit: jplSatelliteOrbit({ a: 58300e3, e: 0.010, incDeg: 0.4, periodDays: 32.17, nodePeriodYears: 0, apsisPeriodYears: 0, basisToEci: equatorBasis(PLUTO_POLE) }),
};

const HYDRA: SatelliteDef = {
  id: 'hydra',
  mu: 0.0020e9,
  radius: 18.5e3,
  orbit: jplSatelliteOrbit({ a: 65200e3, e: 0.009, incDeg: 0.3, periodDays: 38.20, nodePeriodYears: 0, apsisPeriodYears: 0, basisToEci: equatorBasis(PLUTO_POLE) }),
};

const HAUMEA: PlanetDef = {
  id: 'haumea',
  mu: 2.67e11,
  radius: 1.05e6, // 三軸の最長半軸(外接球)
  // 出典: 2019年掩蔽解析(直径 2100 × 1680 × 1074 km を半径に換算)。太陽系で最も極端な
  // 三軸楕円体
  shape: { kind: 'triaxial', a: 1.05e6, b: 8.4e5, c: 5.37e5 },
  // 出典: https://ssd-api.jpl.nasa.gov/sbdb.api?sstr=Haumea&full-prec=true (元期 JD2461200.5)
  orbit: planetOrbit({
    a: 43.06029023650952 * AU,
    e: 0.1944430148898797,
    incDeg: 28.20847393040364,
    raanDeg: 121.7860561329425,
    lonPeriDeg: 2.4766034,
    l0Deg: 192.0076876,
    lRateDegPerCentury: 127.40276965460927,
    raanRateDegPerCentury: 0,
    incRateDegPerCentury: 0,
    lonPeriRateDegPerCentury: 0,
    eRatePerCentury: 0,
    aRatePerCenturyAu: 0,
  }),
};

// ハウメアの衛星2個。基準面は黄道面 — JPL 系列(木星・土星・天王星・冥王星の各衛星)より
// 精度・基準面の一貫性が低い二次引用(一次は各々 Ratzka et al. 2007 / Wikipedia 経由)。
// 質量 [kg] から GRAVITATIONAL_CONSTANT で GM を導く。
// 歳差周期は2体とも未公開(=0)。
const HIIAKA: SatelliteDef = {
  id: 'hiiaka',
  mu: GRAVITATIONAL_CONSTANT * 1.6e19,
  radius: 185e3,
  orbit: jplSatelliteOrbit({ a: 49371e3, e: 0.0542, incDeg: 77.394, periodDays: 49.462, nodePeriodYears: 0, apsisPeriodYears: 0 }),
};

const NAMAKA: SatelliteDef = {
  id: 'namaka',
  mu: GRAVITATIONAL_CONSTANT * 1.18e18,
  radius: 75e3,
  // 傾斜角 13° はハウメアの赤道面基準の値とされるが実測精度が粗いため、姉妹衛星ヒイアカと
  // 同じ黄道面基準の近似値として扱う。
  orbit: jplSatelliteOrbit({ a: 25506e3, e: 0.2179, incDeg: 13, periodDays: 18.2783, nodePeriodYears: 0, apsisPeriodYears: 0 }),
};

const MAKEMAKE: PlanetDef = {
  id: 'makemake',
  mu: 2.1e11,
  radius: 7.15e5,
  // 出典: https://ssd-api.jpl.nasa.gov/sbdb.api?sstr=Makemake&full-prec=true (元期 JD2461200.5)
  orbit: planetOrbit({
    a: 45.57093317300052 * AU,
    e: 0.1588889953992523,
    incDeg: 29.02785603743067,
    raanDeg: 79.2948338209406,
    lonPeriDeg: 16.3871072,
    l0Deg: 155.3903285,
    lRateDegPerCentury: 117.02062563483054,
    raanRateDegPerCentury: 0,
    incRateDegPerCentury: 0,
    lonPeriRateDegPerCentury: 0,
    eRatePerCentury: 0,
    aRatePerCenturyAu: 0,
  }),
};

const ERIS: PlanetDef = {
  id: 'eris',
  mu: 1.108e12,
  radius: 1.163e6,
  // 出典: https://ssd-api.jpl.nasa.gov/sbdb.api?sstr=Eris&full-prec=true (元期 JD2461200.5)
  orbit: planetOrbit({
    a: 67.93394687853566 * AU,
    e: 0.4382385347971672,
    incDeg: 43.9258279471791,
    raanDeg: 36.00477044417249,
    lonPeriDeg: 186.799694,
    l0Deg: 21.578056,
    lRateDegPerCentury: 64.29304982186218,
    raanRateDegPerCentury: 0,
    incRateDegPerCentury: 0,
    lonPeriRateDegPerCentury: 0,
    eRatePerCentury: 0,
    aRatePerCenturyAu: 0,
  }),
};

// エリスの衛星ディスノミア。基準面は黄道面(出典・扱いはハウメアの衛星と同じ)。
const DYSNOMIA: SatelliteDef = {
  id: 'dysnomia',
  mu: GRAVITATIONAL_CONSTANT * 8.2e19,
  radius: 307.5e3,
  orbit: jplSatelliteOrbit({ a: 37273e3, e: 0.0062, incDeg: 61.59, periodDays: 15.785899, nodePeriodYears: 0, apsisPeriodYears: 0 }),
};

// 準惑星・大型小惑星とその衛星の表示名。
export const DWARF_PLANET_NAMES: Record<DwarfPlanetId, string> = {
  ceres: 'ケレス',
  vesta: 'ベスタ',
  pallas: 'パラス',
  pluto: '冥王星',
  charon: 'カロン',
  styx: 'ステュクス',
  nix: 'ニクス',
  kerberos: 'ケルベロス',
  hydra: 'ヒドラ',
  haumea: 'ハウメア',
  hiiaka: 'ヒイアカ',
  namaka: 'ナマカ',
  makemake: 'マケマケ',
  eris: 'エリス',
  dysnomia: 'ディスノミア',
};

// 準惑星・大型小惑星とその衛星を組む。宣言順がそのまま重力源配列・一覧の順序になる。
export function dwarfPlanets(
  sun: StarMotion, phases: PhaseOffsets, epochOffsetSec: number,
  pack: OriginCenteredEphemeris | null, origin: EciOrigin,
): Record<DwarfPlanetId, CelestialEntity> {
  // 衛星を持つ天体の運動は、子の主天体として渡すため先に組む。
  const pluto = new PlanetMotion(PLUTO, sun, phases[PLUTO.id] ?? 0, epochOffsetSec, pack, origin);
  const haumea = new PlanetMotion(HAUMEA, sun, phases[HAUMEA.id] ?? 0, epochOffsetSec, pack, origin);
  const eris = new PlanetMotion(ERIS, sun, phases[ERIS.id] ?? 0, epochOffsetSec, pack, origin);
  return {
    ceres: new SphereEntity(
      new PlanetMotion(CERES, sun, phases[CERES.id] ?? 0, epochOffsetSec, pack, origin),
      DWARF_PLANET_NAMES.ceres, 'dwarf',
      // A_B=0.035(幾何 0.090 x q=0.393)
      CelestialSurface.solid([0.0382, 0.0345, 0.0310]),
    ),
    vesta: new SphereEntity(
      new PlanetMotion(VESTA, sun, phases[VESTA.id] ?? 0, epochOffsetSec, pack, origin),
      DWARF_PLANET_NAMES.vesta, 'smallBody',
      // A_B=0.195(幾何 0.423 x q=0.461)
      CelestialSurface.solid([0.2156, 0.1925, 0.1593]),
    ),
    pallas: new SphereEntity(
      new PlanetMotion(PALLAS, sun, phases[PALLAS.id] ?? 0, epochOffsetSec, pack, origin),
      DWARF_PLANET_NAMES.pallas, 'smallBody',
      // A_B=0.061(幾何 0.155 x q=0.393)
      CelestialSurface.solid([0.0616, 0.0616, 0.0533]),
    ),
    pluto: new SphereEntity(
      pluto, DWARF_PLANET_NAMES.pluto, 'dwarf',
      // A_B=0.72(公表ボンド 0.72(NASA Pluto Fact Sheet。幾何は 0.52))
      CelestialSurface.solid([0.9026, 0.6880, 0.4994]),
    ),
    charon: new SphereEntity(
      new SatelliteMotion(CHARON, pluto, phases[CHARON.id] ?? 0, epochOffsetSec, pack, origin),
      DWARF_PLANET_NAMES.charon, 'satellite',
      // A_B=0.21(幾何 0.38 x q=0.564)
      CelestialSurface.solid([0.2182, 0.2090, 0.1957]),
    ),
    styx: new SphereEntity(
      new SatelliteMotion(STYX, pluto, phases[STYX.id] ?? 0, epochOffsetSec, pack, origin),
      DWARF_PLANET_NAMES.styx, 'satellite',
      // A_B=0.37(幾何 0.65 x q=0.564)
      CelestialSurface.solid([0.4236, 0.3598, 0.3131]),
    ),
    nix: new SphereEntity(
      new SatelliteMotion(NIX, pluto, phases[NIX.id] ?? 0, epochOffsetSec, pack, origin),
      DWARF_PLANET_NAMES.nix, 'satellite',
      // A_B=0.32(幾何 0.56 x q=0.564)
      CelestialSurface.solid([0.3664, 0.3112, 0.2708]),
    ),
    kerberos: new SphereEntity(
      new SatelliteMotion(KERBEROS, pluto, phases[KERBEROS.id] ?? 0, epochOffsetSec, pack, origin),
      DWARF_PLANET_NAMES.kerberos, 'satellite',
      // A_B=0.32(幾何 0.56 x q=0.564)
      CelestialSurface.solid([0.3664, 0.3112, 0.2708]),
    ),
    hydra: new SphereEntity(
      new SatelliteMotion(HYDRA, pluto, phases[HYDRA.id] ?? 0, epochOffsetSec, pack, origin),
      DWARF_PLANET_NAMES.hydra, 'satellite',
      // A_B=0.47(幾何 0.83 x q=0.564)
      CelestialSurface.solid([0.5381, 0.4570, 0.3977]),
    ),
    haumea: new SphereEntity(
      haumea, DWARF_PLANET_NAMES.haumea, 'dwarf',
      // A_B=0.29(幾何 0.51 x q=0.564)
      CelestialSurface.solid([0.2900, 0.2900, 0.2900]),
    ),
    hiiaka: new SphereEntity(
      new SatelliteMotion(HIIAKA, haumea, phases[HIIAKA.id] ?? 0, epochOffsetSec, pack, origin),
      DWARF_PLANET_NAMES.hiiaka, 'satellite',
      // A_B=0.28(分類既定 幾何 0.5 x q=0.564(母天体ハウメアと同じ氷質を仮定))
      CelestialSurface.solid([0.3206, 0.2723, 0.2369]),
    ),
    namaka: new SphereEntity(
      new SatelliteMotion(NAMAKA, haumea, phases[NAMAKA.id] ?? 0, epochOffsetSec, pack, origin),
      DWARF_PLANET_NAMES.namaka, 'satellite',
      // A_B=0.28(分類既定 幾何 0.5 x q=0.564(母天体ハウメアと同じ氷質を仮定))
      CelestialSurface.solid([0.3206, 0.2723, 0.2369]),
    ),
    makemake: new SphereEntity(
      new PlanetMotion(MAKEMAKE, sun, phases[MAKEMAKE.id] ?? 0, epochOffsetSec, pack, origin),
      DWARF_PLANET_NAMES.makemake, 'dwarf',
      // A_B=0.46(幾何 0.81 x q=0.564)
      CelestialSurface.solid([0.7020, 0.4110, 0.2331]),
    ),
    eris: new SphereEntity(
      eris, DWARF_PLANET_NAMES.eris, 'dwarf',
      // A_B=0.54(幾何 0.96 x q=0.564)
      CelestialSurface.solid([0.5400, 0.5400, 0.5400]),
    ),
    dysnomia: new SphereEntity(
      new SatelliteMotion(DYSNOMIA, eris, phases[DYSNOMIA.id] ?? 0, epochOffsetSec, pack, origin),
      DWARF_PLANET_NAMES.dysnomia, 'satellite',
      // A_B=0.016(幾何 0.04 x q=0.393)
      CelestialSurface.solid([0.0183, 0.0156, 0.0135]),
    ),
  };
}
