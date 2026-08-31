// 木星と14個の衛星の静的事実と、その運動を組む構築関数。
import { OriginCenteredEphemeris } from '../absolute-ephemeris';
import {
  EciOrigin, PhaseOffsets, PlanetDef, PlanetMotion, SatelliteDef, SatelliteMotion, StarMotion,
} from '../celestial-motion';
import { planetOrbit } from '../planet-orbit';
import { MU_JUPITER } from './constants';
import { JUPITER_LAPLACE_BASIS, JUPITER_POLE } from './poles';
import { JUPITER_RINGS } from './rings';
import { jplSatelliteOrbit } from './satellite-orbit-builders';

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
export const METIS: SatelliteDef = {
  id: 'metis',
  mu: 0.00250e9,
  radius: 2.15e4,
  orbit: jplSatelliteOrbit({ a: 1.28000e8, e: 0.000, incDeg: 0.0, periodDays: 0.294779, nodePeriodYears: 0, apsisPeriodYears: 0, basisToEci: JUPITER_LAPLACE_BASIS }),
};

export const ADRASTEA: SatelliteDef = {
  id: 'adrastea',
  mu: 0.00014e9,
  radius: 8.2e3,
  orbit: jplSatelliteOrbit({ a: 1.29000e8, e: 0.000, incDeg: 0.0, periodDays: 0.298260, nodePeriodYears: 0, apsisPeriodYears: 0, basisToEci: JUPITER_LAPLACE_BASIS }),
};

export const AMALTHEA: SatelliteDef = {
  id: 'amalthea',
  mu: 0.16456e9,
  radius: 8.35e4,
  orbit: jplSatelliteOrbit({ a: 1.81400e8, e: 0.003, incDeg: 0.4, periodDays: 0.499918, nodePeriodYears: 0, apsisPeriodYears: 0, basisToEci: JUPITER_LAPLACE_BASIS }),
};

export const THEBE: SatelliteDef = {
  id: 'thebe',
  mu: 0.03015e9,
  radius: 4.93e4,
  orbit: jplSatelliteOrbit({ a: 2.21900e8, e: 0.018, incDeg: 1.1, periodDays: 0.676105, nodePeriodYears: 0, apsisPeriodYears: 0, basisToEci: JUPITER_LAPLACE_BASIS }),
};

export const IO: SatelliteDef = {
  id: 'io',
  mu: 5.9599e12,
  radius: 1.83e6, // 三軸の最長半軸(外接球)
  // 出典: pck00011.tpc BODY_RADII(直径 3660.0 × 3637.4 × 3630.6 km を半径に換算)
  shape: { kind: 'triaxial', a: 1.83e6, b: 1.8187e6, c: 1.8153e6 },
  orbit: jplSatelliteOrbit({ a: 4.218e8, e: 0.0033, incDeg: 0.04, periodDays: 1.762732, nodePeriodYears: 0, apsisPeriodYears: 1.333, basisToEci: JUPITER_LAPLACE_BASIS }),
};

export const EUROPA: SatelliteDef = {
  id: 'europa',
  mu: 3.2027e12,
  radius: 1.5608e6,
  orbit: jplSatelliteOrbit({ a: 6.711e8, e: 0.0072, incDeg: 0.47, periodDays: 3.525463, nodePeriodYears: 30.202, apsisPeriodYears: 1.394, basisToEci: JUPITER_LAPLACE_BASIS }),
};

export const GANYMEDE: SatelliteDef = {
  id: 'ganymede',
  mu: 9.8878e12,
  radius: 2.6312e6,
  orbit: jplSatelliteOrbit({ a: 1.0704e9, e: 0.0013, incDeg: 0.20, periodDays: 7.155588, nodePeriodYears: 137.812, apsisPeriodYears: 68.301, basisToEci: JUPITER_LAPLACE_BASIS }),
};

export const CALLISTO: SatelliteDef = {
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
export const HIMALIA: SatelliteDef = {
  id: 'himalia',
  mu: 0.15155e9,
  radius: 8.5e4,
  orbit: jplSatelliteOrbit({ a: 1.14390e10, e: 0.160, incDeg: 28.4, periodDays: 249.9090, nodePeriodYears: 0, apsisPeriodYears: 0 }),
};

export const ELARA: SatelliteDef = {
  id: 'elara',
  mu: 0,
  radius: 3.995e4,
  orbit: jplSatelliteOrbit({ a: 1.171070e10, e: 0.212, incDeg: 27.8, periodDays: 258.8861, nodePeriodYears: 0, apsisPeriodYears: 0 }),
};

// 傾斜角 90° 超が逆行を表す。
export const ANANKE: SatelliteDef = {
  id: 'ananke',
  mu: 0,
  radius: 1.455e4,
  orbit: jplSatelliteOrbit({ a: 2.10295e10, e: 0.238, incDeg: 147.6, periodDays: 623.1097, nodePeriodYears: 0, apsisPeriodYears: 0 }),
};

export const CARME: SatelliteDef = {
  id: 'carme',
  mu: 0,
  radius: 2.33e4,
  orbit: jplSatelliteOrbit({ a: 2.31392e10, e: 0.261, incDeg: 164.6, periodDays: 719.2806, nodePeriodYears: 0, apsisPeriodYears: 0 }),
};

export const PASIPHAE: SatelliteDef = {
  id: 'pasiphae',
  mu: 0,
  radius: 2.89e4,
  orbit: jplSatelliteOrbit({ a: 2.34632e10, e: 0.412, incDeg: 148.3, periodDays: 734.4215, nodePeriodYears: 0, apsisPeriodYears: 0 }),
};

export const SINOPE: SatelliteDef = {
  id: 'sinope',
  mu: 0,
  radius: 1.75e4,
  orbit: jplSatelliteOrbit({ a: 2.36793e10, e: 0.262, incDeg: 157.3, periodDays: 744.5951, nodePeriodYears: 0, apsisPeriodYears: 0 }),
};

export type JupiterSystemMotions = {
  readonly jupiter: PlanetMotion;
  readonly metis: SatelliteMotion;
  readonly adrastea: SatelliteMotion;
  readonly amalthea: SatelliteMotion;
  readonly thebe: SatelliteMotion;
  readonly io: SatelliteMotion;
  readonly europa: SatelliteMotion;
  readonly ganymede: SatelliteMotion;
  readonly callisto: SatelliteMotion;
  readonly himalia: SatelliteMotion;
  readonly elara: SatelliteMotion;
  readonly ananke: SatelliteMotion;
  readonly carme: SatelliteMotion;
  readonly pasiphae: SatelliteMotion;
  readonly sinope: SatelliteMotion;
};

// 木星と14個の衛星の運動を組む。
export function jupiterSystem(
  sun: StarMotion, phases: PhaseOffsets, epochOffsetSec: number,
  pack: OriginCenteredEphemeris | null, origin: EciOrigin,
): JupiterSystemMotions {
  const jupiter = new PlanetMotion(JUPITER, sun, phases[JUPITER.id] ?? 0, epochOffsetSec, pack, origin);
  const metis = new SatelliteMotion(METIS, jupiter, phases[METIS.id] ?? 0, epochOffsetSec, pack, origin);
  const adrastea = new SatelliteMotion(ADRASTEA, jupiter, phases[ADRASTEA.id] ?? 0, epochOffsetSec, pack, origin);
  const amalthea = new SatelliteMotion(AMALTHEA, jupiter, phases[AMALTHEA.id] ?? 0, epochOffsetSec, pack, origin);
  const thebe = new SatelliteMotion(THEBE, jupiter, phases[THEBE.id] ?? 0, epochOffsetSec, pack, origin);
  const io = new SatelliteMotion(IO, jupiter, phases[IO.id] ?? 0, epochOffsetSec, pack, origin);
  const europa = new SatelliteMotion(EUROPA, jupiter, phases[EUROPA.id] ?? 0, epochOffsetSec, pack, origin);
  const ganymede = new SatelliteMotion(GANYMEDE, jupiter, phases[GANYMEDE.id] ?? 0, epochOffsetSec, pack, origin);
  const callisto = new SatelliteMotion(CALLISTO, jupiter, phases[CALLISTO.id] ?? 0, epochOffsetSec, pack, origin);
  const himalia = new SatelliteMotion(HIMALIA, jupiter, phases[HIMALIA.id] ?? 0, epochOffsetSec, pack, origin);
  const elara = new SatelliteMotion(ELARA, jupiter, phases[ELARA.id] ?? 0, epochOffsetSec, pack, origin);
  const ananke = new SatelliteMotion(ANANKE, jupiter, phases[ANANKE.id] ?? 0, epochOffsetSec, pack, origin);
  const carme = new SatelliteMotion(CARME, jupiter, phases[CARME.id] ?? 0, epochOffsetSec, pack, origin);
  const pasiphae = new SatelliteMotion(PASIPHAE, jupiter, phases[PASIPHAE.id] ?? 0, epochOffsetSec, pack, origin);
  const sinope = new SatelliteMotion(SINOPE, jupiter, phases[SINOPE.id] ?? 0, epochOffsetSec, pack, origin);
  return {
    jupiter, metis, adrastea, amalthea, thebe, io, europa, ganymede, callisto, himalia, elara, ananke, carme,
    pasiphae, sinope,
  };
}
