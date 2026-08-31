// 木星系(木星と14個の衛星)。静的事実・運動・見た目を1体につき1箇所で組む。
import callistoTextureUrl from '../../../assets/2k_callisto.jpg';
import europaTextureUrl from '../../../assets/2k_europa.jpg';
import ganymedeTextureUrl from '../../../assets/2k_ganymede.jpg';
import ioTextureUrl from '../../../assets/2k_io.jpg';
import jupiterTextureUrl from '../../../assets/2k_jupiter.jpg';
import {
  PhaseOffsets, PlanetDef, planetDefForSimZero, SatelliteDef, satelliteDefForSimZero, SatelliteMotion, StarMotion,
} from '../../../physics/celestial-motion';
import { planetSystem } from '../../../physics/planet-system';
import { planetOrbit } from '../../../physics/planet-orbit';
import { GRAVITATIONAL_CONSTANT, MU_JUPITER } from './constants';
import { CelestialSurface } from '../../../render/celestial-surface';
import type { CelestialEntity } from '../celestial-entity/celestial-entity';
import { PointEntity } from '../celestial-entity/point-entity';
import { SphereEntity } from '../celestial-entity/sphere-entity';
import { JUPITER_LAPLACE_BASIS, JUPITER_POLE } from './poles';
import { JUPITER_RINGS } from './rings';
import { jplSatelliteOrbit } from './satellite-orbit-builders';

// 木星系に登録された天体の id。表示名も構築の網羅性もこの集合が決める。
export type JupiterSystemBodyId =
  | 'jupiter' | 'metis' | 'adrastea' | 'amalthea' | 'thebe' | 'io' | 'europa' | 'ganymede' | 'callisto'
  | 'himalia' | 'elara' | 'ananke' | 'carme' | 'pasiphae' | 'sinope';

export const JUPITER: PlanetDef = {
  id: 'jupiter',
  mu: MU_JUPITER,
  radius: 7.1492e7, // 赤道半径(外接球)。出典: pck00011.tpc BODY_RADII(1 bar 基準)
  shape: { kind: 'spheroid', equatorRadius: 7.1492e7, polarRadius: 6.6854e7 },
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
  rings: JUPITER_RINGS,
};

// 木星の内側小衛星(環境軌道群)4個。基準面はガリレオ衛星と同じ木星系ラプラス面。
// GM・平均半径は JPL Planetary Satellite Physical Parameters。歳差周期はいずれも未測定。
const METIS: SatelliteDef = {
  id: 'metis',
  mu: 0.00250e9,
  radius: 2.15e4,
  orbit: jplSatelliteOrbit({ a: 1.28000e8, e: 0.000, incDeg: 0.0, periodDays: 0.294779, nodePeriodYears: 0, apsisPeriodYears: 0, basisToEci: JUPITER_LAPLACE_BASIS }),
};

const ADRASTEA: SatelliteDef = {
  id: 'adrastea',
  mu: 0.00014e9,
  radius: 8.2e3,
  orbit: jplSatelliteOrbit({ a: 1.29000e8, e: 0.000, incDeg: 0.0, periodDays: 0.298260, nodePeriodYears: 0, apsisPeriodYears: 0, basisToEci: JUPITER_LAPLACE_BASIS }),
};

const AMALTHEA: SatelliteDef = {
  id: 'amalthea',
  mu: 0.16456e9,
  radius: 8.35e4,
  orbit: jplSatelliteOrbit({ a: 1.81400e8, e: 0.003, incDeg: 0.4, periodDays: 0.499918, nodePeriodYears: 0, apsisPeriodYears: 0, basisToEci: JUPITER_LAPLACE_BASIS }),
};

const THEBE: SatelliteDef = {
  id: 'thebe',
  mu: 0.03015e9,
  radius: 4.93e4,
  orbit: jplSatelliteOrbit({ a: 2.21900e8, e: 0.018, incDeg: 1.1, periodDays: 0.676105, nodePeriodYears: 0, apsisPeriodYears: 0, basisToEci: JUPITER_LAPLACE_BASIS }),
};

const IO: SatelliteDef = {
  id: 'io',
  mu: 5.9599e12,
  radius: 1.83e6, // 三軸の最長半軸(外接球)
  // 出典: pck00011.tpc BODY_RADII(直径 3660.0 × 3637.4 × 3630.6 km を半径に換算)
  shape: { kind: 'triaxial', a: 1.83e6, b: 1.8187e6, c: 1.8153e6 },
  orbit: jplSatelliteOrbit({ a: 4.218e8, e: 0.0033, incDeg: 0.04, periodDays: 1.762732, nodePeriodYears: 0, apsisPeriodYears: 1.333, basisToEci: JUPITER_LAPLACE_BASIS }),
};

const EUROPA: SatelliteDef = {
  id: 'europa',
  mu: 3.2027e12,
  radius: 1.5608e6,
  orbit: jplSatelliteOrbit({ a: 6.711e8, e: 0.0072, incDeg: 0.47, periodDays: 3.525463, nodePeriodYears: 30.202, apsisPeriodYears: 1.394, basisToEci: JUPITER_LAPLACE_BASIS }),
};

const GANYMEDE: SatelliteDef = {
  id: 'ganymede',
  mu: 9.8878e12,
  radius: 2.6312e6,
  orbit: jplSatelliteOrbit({ a: 1.0704e9, e: 0.0013, incDeg: 0.20, periodDays: 7.155588, nodePeriodYears: 137.812, apsisPeriodYears: 68.301, basisToEci: JUPITER_LAPLACE_BASIS }),
};

const CALLISTO: SatelliteDef = {
  id: 'callisto',
  mu: 7.1793e12,
  radius: 2.4103e6,
  orbit: jplSatelliteOrbit({ a: 1.8827e9, e: 0.0048, incDeg: 0.19, periodDays: 16.690440, nodePeriodYears: 577.264, apsisPeriodYears: 277.921, basisToEci: JUPITER_LAPLACE_BASIS }),
};

// 木星の不規則衛星(ヒマリア群・アナンケ群・カルメ群・パシファエ群)。ガリレオ衛星と違い
// 太陽摂動が支配的な遠方軌道なので、ラプラス面ではなく黄道基準の平均要素を使う(JPL
// Solar System Dynamics はこの6衛星をこの基準で公開している)。歳差周期は未測定のため
// 0(歳差なし)。GM・平均半径は Planetary Satellite Physical Parameters が一次だが、
// エララ・アナンケ・カルメ・パシファエ・シノーペの半径はその表に無いため、Wikipedia
// "List of natural satellites"(一次は Sheppard の測光サイズ推定)の値を使う。
// この5体は GM も未測定なので、同じ捕獲小天体でただ一つ GM を持つヒマリアと半径から
// 求めた密度 883 kg/m^3 を、それぞれの半径に掛けて質量を見積もる。
const HIMALIA: SatelliteDef = {
  id: 'himalia',
  mu: 0.15155e9,
  radius: 8.5e4,
  orbit: jplSatelliteOrbit({ a: 1.14390e10, e: 0.160, incDeg: 28.4, periodDays: 249.9090, nodePeriodYears: 0, apsisPeriodYears: 0 }),
};

const ELARA: SatelliteDef = {
  id: 'elara',
  mu: GRAVITATIONAL_CONSTANT * 2.36e17,
  radius: 3.995e4,
  orbit: jplSatelliteOrbit({ a: 1.171070e10, e: 0.212, incDeg: 27.8, periodDays: 258.8861, nodePeriodYears: 0, apsisPeriodYears: 0 }),
};

// 傾斜角 90° 超が逆行を表す。
const ANANKE: SatelliteDef = {
  id: 'ananke',
  mu: GRAVITATIONAL_CONSTANT * 1.14e16,
  radius: 1.455e4,
  orbit: jplSatelliteOrbit({ a: 2.10295e10, e: 0.238, incDeg: 147.6, periodDays: 623.1097, nodePeriodYears: 0, apsisPeriodYears: 0 }),
};

const CARME: SatelliteDef = {
  id: 'carme',
  mu: GRAVITATIONAL_CONSTANT * 4.68e16,
  radius: 2.33e4,
  orbit: jplSatelliteOrbit({ a: 2.31392e10, e: 0.261, incDeg: 164.6, periodDays: 719.2806, nodePeriodYears: 0, apsisPeriodYears: 0 }),
};

const PASIPHAE: SatelliteDef = {
  id: 'pasiphae',
  mu: GRAVITATIONAL_CONSTANT * 8.93e16,
  radius: 2.89e4,
  orbit: jplSatelliteOrbit({ a: 2.34632e10, e: 0.412, incDeg: 148.3, periodDays: 734.4215, nodePeriodYears: 0, apsisPeriodYears: 0 }),
};

const SINOPE: SatelliteDef = {
  id: 'sinope',
  mu: GRAVITATIONAL_CONSTANT * 1.98e16,
  radius: 1.75e4,
  orbit: jplSatelliteOrbit({ a: 2.36793e10, e: 0.262, incDeg: 157.3, periodDays: 744.5951, nodePeriodYears: 0, apsisPeriodYears: 0 }),
};

// 木星系の天体の表示名。
export const JUPITER_SYSTEM_NAMES: Record<JupiterSystemBodyId, string> = {
  jupiter: '木星',
  metis: 'メティス',
  adrastea: 'アドラステア',
  amalthea: 'アマルテア',
  thebe: 'テーベ',
  io: 'イオ',
  europa: 'エウロパ',
  ganymede: 'ガニメデ',
  callisto: 'カリスト',
  himalia: 'ヒマリア',
  elara: 'エララ',
  ananke: 'アナンケ',
  carme: 'カルメ',
  pasiphae: 'パシファエ',
  sinope: 'シノーペ',
};

// 木星系を組む。宣言順がそのまま重力源配列・一覧の順序になる。
export function jupiterSystem(
  sun: StarMotion, phases: PhaseOffsets, simZeroEt: number,
): Record<JupiterSystemBodyId, CelestialEntity> {
  const jupiter = planetSystem(planetDefForSimZero(JUPITER, phases, simZeroEt), sun);
  return {
    jupiter: new PointEntity(
      jupiter.body, JUPITER_SYSTEM_NAMES.jupiter, 'planet',
      // 平均輝度 0.4116(A_B は公表ボンド)
      CelestialSurface.textured({ url: jupiterTextureUrl, albedoScale: 1.2222, bondAlbedo: 0.503, averageHue: [1.0987, 0.9845, 0.8629] }),
    ),
    // メティス A_B=0.024(幾何 0.061 x q=0.393)
    metis: new SphereEntity(
      new SatelliteMotion(satelliteDefForSimZero(METIS, phases, simZeroEt), jupiter),
      JUPITER_SYSTEM_NAMES.metis, 'satellite', CelestialSurface.solid([0.0285, 0.0231, 0.0193]),
    ),
    // アドラステア A_B=0.039(幾何 0.10 x q=0.393)
    adrastea: new SphereEntity(
      new SatelliteMotion(satelliteDefForSimZero(ADRASTEA, phases, simZeroEt), jupiter),
      JUPITER_SYSTEM_NAMES.adrastea, 'satellite', CelestialSurface.solid([0.0463, 0.0376, 0.0314]),
    ),
    // アマルテア A_B=0.035(幾何 0.090 x q=0.393)
    amalthea: new SphereEntity(
      new SatelliteMotion(satelliteDefForSimZero(AMALTHEA, phases, simZeroEt), jupiter),
      JUPITER_SYSTEM_NAMES.amalthea, 'satellite', CelestialSurface.solid([0.0673, 0.0271, 0.0181]),
    ),
    // テーベ A_B=0.018(幾何 0.047 x q=0.393)
    thebe: new SphereEntity(
      new SatelliteMotion(satelliteDefForSimZero(THEBE, phases, simZeroEt), jupiter),
      JUPITER_SYSTEM_NAMES.thebe, 'satellite', CelestialSurface.solid([0.0214, 0.0174, 0.0145]),
    ),
    io: new SphereEntity(
      new SatelliteMotion(satelliteDefForSimZero(IO, phases, simZeroEt), jupiter),
      JUPITER_SYSTEM_NAMES.io, 'satellite',
      // 平均輝度 0.2621(A_B は幾何 0.63 x q=0.564)
      CelestialSurface.textured({ url: ioTextureUrl, albedoScale: 1.3543, bondAlbedo: 0.355, averageHue: [1.3697, 0.9471, 0.4357] }),
    ),
    europa: new SphereEntity(
      new SatelliteMotion(satelliteDefForSimZero(EUROPA, phases, simZeroEt), jupiter),
      JUPITER_SYSTEM_NAMES.europa, 'satellite',
      // 平均輝度 0.3127(A_B は幾何 0.67 x q=0.564)
      CelestialSurface.textured({ url: europaTextureUrl, albedoScale: 1.2089, bondAlbedo: 0.378, averageHue: [1, 1, 1] }),
    ),
    ganymede: new SphereEntity(
      new SatelliteMotion(satelliteDefForSimZero(GANYMEDE, phases, simZeroEt), jupiter),
      JUPITER_SYSTEM_NAMES.ganymede, 'satellite',
      // 平均輝度 0.1777(A_B は幾何 0.43 x q=0.564)
      CelestialSurface.textured({ url: ganymedeTextureUrl, albedoScale: 1.3675, bondAlbedo: 0.243, averageHue: [1.0763, 0.9959, 0.8162] }),
    ),
    callisto: new SphereEntity(
      new SatelliteMotion(satelliteDefForSimZero(CALLISTO, phases, simZeroEt), jupiter),
      JUPITER_SYSTEM_NAMES.callisto, 'satellite',
      // 平均輝度 0.0491(A_B は公表ボンド)
      CelestialSurface.textured({ url: callistoTextureUrl, albedoScale: 2.2403, bondAlbedo: 0.11, averageHue: [1, 1, 1] }),
    ),
    // ヒマリア A_B=0.016(幾何 0.04 x q=0.393)
    himalia: new SphereEntity(
      new SatelliteMotion(satelliteDefForSimZero(HIMALIA, phases, simZeroEt), jupiter),
      JUPITER_SYSTEM_NAMES.himalia, 'satellite', CelestialSurface.solid([0.0190, 0.0156, 0.0114]),
    ),
    // エララ A_B=0.016(分類既定 幾何 0.04 x q=0.393)
    elara: new SphereEntity(
      new SatelliteMotion(satelliteDefForSimZero(ELARA, phases, simZeroEt), jupiter),
      JUPITER_SYSTEM_NAMES.elara, 'satellite', CelestialSurface.solid([0.0206, 0.0151, 0.0108]),
    ),
    // アナンケ A_B=0.016(分類既定 幾何 0.04 x q=0.393)
    ananke: new SphereEntity(
      new SatelliteMotion(satelliteDefForSimZero(ANANKE, phases, simZeroEt), jupiter),
      JUPITER_SYSTEM_NAMES.ananke, 'satellite', CelestialSurface.solid([0.0188, 0.0156, 0.0121]),
    ),
    // カルメ A_B=0.016(分類既定 幾何 0.04 x q=0.393)
    carme: new SphereEntity(
      new SatelliteMotion(satelliteDefForSimZero(CARME, phases, simZeroEt), jupiter),
      JUPITER_SYSTEM_NAMES.carme, 'satellite', CelestialSurface.solid([0.0190, 0.0154, 0.0129]),
    ),
    // パシファエ A_B=0.016(分類既定 幾何 0.04 x q=0.393)
    pasiphae: new SphereEntity(
      new SatelliteMotion(satelliteDefForSimZero(PASIPHAE, phases, simZeroEt), jupiter),
      JUPITER_SYSTEM_NAMES.pasiphae, 'satellite', CelestialSurface.solid([0.0197, 0.0153, 0.0116]),
    ),
    // シノーペ A_B=0.016(分類既定 幾何 0.04 x q=0.393)
    sinope: new SphereEntity(
      new SatelliteMotion(satelliteDefForSimZero(SINOPE, phases, simZeroEt), jupiter),
      JUPITER_SYSTEM_NAMES.sinope, 'satellite', CelestialSurface.solid([0.0203, 0.0152, 0.0112]),
    ),
  };
}
