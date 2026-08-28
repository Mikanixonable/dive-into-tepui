// 天王星と6個の衛星の静的事実と、その運動を組む構築関数。
import { OriginCenteredEphemeris } from '../absolute-ephemeris';
import {
  EciOrigin, PhaseOffsets, PlanetDef, PlanetMotion, SatelliteDef, SatelliteMotion, StarMotion,
} from '../celestial-motion';
import { AU, planetOrbit } from '../planet-orbit';
import { URANUS_POLE, equatorBasis } from './poles';
import { URANUS_RINGS } from './rings';
import { jplSatelliteOrbit } from './satellite-orbit-builders';

export const URANUS: PlanetDef = {
  id: 'uranus',
  mu: 5.793939e15,
  radius: 2.55566e7, // 赤道半径(外接球)。出典: pck00011.tpc BODY_RADII
  shape: { kind: 'spheroid', equatorRadius: 2.55566e7, polarRadius: 2.49685e7 },
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
  pole: URANUS_POLE,
  rings: URANUS_RINGS,
};

// 天王星の主要衛星6個。基準面は天王星の赤道面(equatorBasis(URANUS_POLE))。
// 出典: JPL Solar System Dynamics 衛星平均要素表 / Planetary Satellite Physical Parameters。
export const PUCK: SatelliteDef = {
  id: 'puck',
  // GM は表に無い(6衛星中パックだけ未測定)。半径は Wikipedia "Puck (moon)" 経由
  // (一次は Karkoschka 2001 の Voyager 2 画像解析、平均半径 81±2 km)。
  mu: 0,
  radius: 81e3,
  orbit: jplSatelliteOrbit({ a: 86004e3, e: 0.000, incDeg: 0.3, periodDays: 0.761833, nodePeriodYears: 0, apsisPeriodYears: 0, basisToEci: equatorBasis(URANUS_POLE) }),
};

export const MIRANDA: SatelliteDef = {
  id: 'miranda',
  mu: 4.3e9,
  radius: 235.8e3,
  orbit: jplSatelliteOrbit({ a: 129846e3, e: 0.001, incDeg: 4.4, periodDays: 1.413479, nodePeriodYears: 0, apsisPeriodYears: 0, basisToEci: equatorBasis(URANUS_POLE) }),
};

export const ARIEL: SatelliteDef = {
  id: 'ariel',
  mu: 83.5e9,
  radius: 578.9e3,
  orbit: jplSatelliteOrbit({ a: 190929e3, e: 0.001, incDeg: 0.0, periodDays: 2.520379, nodePeriodYears: 0, apsisPeriodYears: 28.901, basisToEci: equatorBasis(URANUS_POLE) }),
};

export const UMBRIEL: SatelliteDef = {
  id: 'umbriel',
  mu: 85.1e9,
  radius: 584.7e3,
  orbit: jplSatelliteOrbit({ a: 265986e3, e: 0.004, incDeg: 0.1, periodDays: 4.144177, nodePeriodYears: 129.745, apsisPeriodYears: 64.126, basisToEci: equatorBasis(URANUS_POLE) }),
};

export const TITANIA: SatelliteDef = {
  id: 'titania',
  mu: 226.9e9,
  radius: 788.9e3,
  orbit: jplSatelliteOrbit({ a: 436298e3, e: 0.002, incDeg: 0.1, periodDays: 8.705869, nodePeriodYears: 1644.649, apsisPeriodYears: 579.928, basisToEci: equatorBasis(URANUS_POLE) }),
};

export const OBERON: SatelliteDef = {
  id: 'oberon',
  mu: 205.3e9,
  radius: 761.4e3,
  orbit: jplSatelliteOrbit({ a: 583511e3, e: 0.002, incDeg: 0.1, periodDays: 13.463237, nodePeriodYears: 192.798, apsisPeriodYears: 158.604, basisToEci: equatorBasis(URANUS_POLE) }),
};

export type UranusSystemMotions = {
  readonly uranus: PlanetMotion;
  readonly puck: SatelliteMotion;
  readonly miranda: SatelliteMotion;
  readonly ariel: SatelliteMotion;
  readonly umbriel: SatelliteMotion;
  readonly titania: SatelliteMotion;
  readonly oberon: SatelliteMotion;
};

// 天王星と6個の衛星の運動を組む。
export function uranusSystem(
  sun: StarMotion, phases: PhaseOffsets, epochOffsetSec: number,
  pack: OriginCenteredEphemeris | null, origin: EciOrigin,
): UranusSystemMotions {
  const uranus = new PlanetMotion(URANUS, sun, phases[URANUS.id] ?? 0, epochOffsetSec, pack, origin);
  const puck = new SatelliteMotion(PUCK, uranus, phases[PUCK.id] ?? 0, epochOffsetSec, pack, origin);
  const miranda = new SatelliteMotion(MIRANDA, uranus, phases[MIRANDA.id] ?? 0, epochOffsetSec, pack, origin);
  const ariel = new SatelliteMotion(ARIEL, uranus, phases[ARIEL.id] ?? 0, epochOffsetSec, pack, origin);
  const umbriel = new SatelliteMotion(UMBRIEL, uranus, phases[UMBRIEL.id] ?? 0, epochOffsetSec, pack, origin);
  const titania = new SatelliteMotion(TITANIA, uranus, phases[TITANIA.id] ?? 0, epochOffsetSec, pack, origin);
  const oberon = new SatelliteMotion(OBERON, uranus, phases[OBERON.id] ?? 0, epochOffsetSec, pack, origin);
  return { uranus, puck, miranda, ariel, umbriel, titania, oberon };
}
