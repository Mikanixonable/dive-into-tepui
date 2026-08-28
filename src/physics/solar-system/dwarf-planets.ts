// 準惑星・大型小惑星とその衛星の静的事実と、その運動を組む構築関数。
import { OriginCenteredEphemeris } from '../absolute-ephemeris';
import {
  EciOrigin, PhaseOffsets, PlanetDef, PlanetMotion, SatelliteDef, SatelliteMotion, StarMotion,
} from '../celestial-motion';
import { AU, planetOrbit } from '../planet-orbit';
import { GRAVITATIONAL_CONSTANT } from './constants';
import { PLUTO_POLE, equatorBasis } from './poles';
import { jplSatelliteOrbit } from './satellite-orbit-builders';

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

export const VESTA: PlanetDef = {
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

export const PALLAS: PlanetDef = {
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
export const CHARON: SatelliteDef = {
  id: 'charon',
  mu: 106.1e9,
  radius: 606.0e3,
  orbit: jplSatelliteOrbit({ a: 19600e3, e: 0.000, incDeg: 0.0, periodDays: 6.387222, nodePeriodYears: 0, apsisPeriodYears: 0, basisToEci: equatorBasis(PLUTO_POLE) }),
};

export const STYX: SatelliteDef = {
  id: 'styx',
  // GM は上限値(< 0.0003 km^3/s^2)しか無く実測でないため 0 として扱う。
  mu: 0,
  radius: 5.2e3,
  orbit: jplSatelliteOrbit({ a: 43200e3, e: 0.025, incDeg: 0.0, periodDays: 20.16, nodePeriodYears: 0, apsisPeriodYears: 0, basisToEci: equatorBasis(PLUTO_POLE) }),
};

export const NIX: SatelliteDef = {
  id: 'nix',
  mu: 0.0015e9,
  radius: 18.0e3,
  orbit: jplSatelliteOrbit({ a: 49300e3, e: 0.015, incDeg: 0.0, periodDays: 24.85, nodePeriodYears: 0, apsisPeriodYears: 0, basisToEci: equatorBasis(PLUTO_POLE) }),
};

export const KERBEROS: SatelliteDef = {
  id: 'kerberos',
  // GM は上限値(< 0.0002 km^3/s^2)しか無く実測でないため 0 として扱う。
  mu: 0,
  radius: 6.0e3,
  orbit: jplSatelliteOrbit({ a: 58300e3, e: 0.010, incDeg: 0.4, periodDays: 32.17, nodePeriodYears: 0, apsisPeriodYears: 0, basisToEci: equatorBasis(PLUTO_POLE) }),
};

export const HYDRA: SatelliteDef = {
  id: 'hydra',
  mu: 0.0020e9,
  radius: 18.5e3,
  orbit: jplSatelliteOrbit({ a: 65200e3, e: 0.009, incDeg: 0.3, periodDays: 38.20, nodePeriodYears: 0, apsisPeriodYears: 0, basisToEci: equatorBasis(PLUTO_POLE) }),
};

export const HAUMEA: PlanetDef = {
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
export const HIIAKA: SatelliteDef = {
  id: 'hiiaka',
  mu: GRAVITATIONAL_CONSTANT * 1.6e19,
  radius: 185e3,
  orbit: jplSatelliteOrbit({ a: 49371e3, e: 0.0542, incDeg: 77.394, periodDays: 49.462, nodePeriodYears: 0, apsisPeriodYears: 0 }),
};

export const NAMAKA: SatelliteDef = {
  id: 'namaka',
  mu: GRAVITATIONAL_CONSTANT * 1.18e18,
  radius: 75e3,
  // 傾斜角 13° はハウメアの赤道面基準の値とされるが実測精度が粗いため、姉妹衛星ヒイアカと
  // 同じ黄道面基準の近似値として扱う。
  orbit: jplSatelliteOrbit({ a: 25506e3, e: 0.2179, incDeg: 13, periodDays: 18.2783, nodePeriodYears: 0, apsisPeriodYears: 0 }),
};

export const MAKEMAKE: PlanetDef = {
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

export const ERIS: PlanetDef = {
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
export const DYSNOMIA: SatelliteDef = {
  id: 'dysnomia',
  mu: GRAVITATIONAL_CONSTANT * 8.2e19,
  radius: 307.5e3,
  orbit: jplSatelliteOrbit({ a: 37273e3, e: 0.0062, incDeg: 61.59, periodDays: 15.785899, nodePeriodYears: 0, apsisPeriodYears: 0 }),
};

export type DwarfPlanetMotions = {
  readonly ceres: PlanetMotion;
  readonly vesta: PlanetMotion;
  readonly pallas: PlanetMotion;
  readonly pluto: PlanetMotion;
  readonly charon: SatelliteMotion;
  readonly styx: SatelliteMotion;
  readonly nix: SatelliteMotion;
  readonly kerberos: SatelliteMotion;
  readonly hydra: SatelliteMotion;
  readonly haumea: PlanetMotion;
  readonly hiiaka: SatelliteMotion;
  readonly namaka: SatelliteMotion;
  readonly makemake: PlanetMotion;
  readonly eris: PlanetMotion;
  readonly dysnomia: SatelliteMotion;
};

// 準惑星・大型小惑星とその衛星の運動を組む。
export function dwarfPlanets(
  sun: StarMotion, phases: PhaseOffsets, epochOffsetSec: number,
  pack: OriginCenteredEphemeris | null, origin: EciOrigin,
): DwarfPlanetMotions {
  const ceres = new PlanetMotion(CERES, sun, phases[CERES.id] ?? 0, epochOffsetSec, pack, origin);
  const vesta = new PlanetMotion(VESTA, sun, phases[VESTA.id] ?? 0, epochOffsetSec, pack, origin);
  const pallas = new PlanetMotion(PALLAS, sun, phases[PALLAS.id] ?? 0, epochOffsetSec, pack, origin);
  const pluto = new PlanetMotion(PLUTO, sun, phases[PLUTO.id] ?? 0, epochOffsetSec, pack, origin);
  const charon = new SatelliteMotion(CHARON, pluto, phases[CHARON.id] ?? 0, epochOffsetSec, pack, origin);
  const styx = new SatelliteMotion(STYX, pluto, phases[STYX.id] ?? 0, epochOffsetSec, pack, origin);
  const nix = new SatelliteMotion(NIX, pluto, phases[NIX.id] ?? 0, epochOffsetSec, pack, origin);
  const kerberos = new SatelliteMotion(KERBEROS, pluto, phases[KERBEROS.id] ?? 0, epochOffsetSec, pack, origin);
  const hydra = new SatelliteMotion(HYDRA, pluto, phases[HYDRA.id] ?? 0, epochOffsetSec, pack, origin);
  const haumea = new PlanetMotion(HAUMEA, sun, phases[HAUMEA.id] ?? 0, epochOffsetSec, pack, origin);
  const hiiaka = new SatelliteMotion(HIIAKA, haumea, phases[HIIAKA.id] ?? 0, epochOffsetSec, pack, origin);
  const namaka = new SatelliteMotion(NAMAKA, haumea, phases[NAMAKA.id] ?? 0, epochOffsetSec, pack, origin);
  const makemake = new PlanetMotion(MAKEMAKE, sun, phases[MAKEMAKE.id] ?? 0, epochOffsetSec, pack, origin);
  const eris = new PlanetMotion(ERIS, sun, phases[ERIS.id] ?? 0, epochOffsetSec, pack, origin);
  const dysnomia = new SatelliteMotion(DYSNOMIA, eris, phases[DYSNOMIA.id] ?? 0, epochOffsetSec, pack, origin);
  return {
    ceres, vesta, pallas, pluto, charon, styx, nix, kerberos, hydra, haumea, hiiaka, namaka, makemake, eris, dysnomia,
  };
}
