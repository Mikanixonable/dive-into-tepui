// 火星と2個の衛星の静的事実と、その運動を組む構築関数。
import { OriginCenteredEphemeris } from '../absolute-ephemeris';
import {
  EciOrigin, PhaseOffsets, PlanetDef, PlanetMotion, SatelliteDef, SatelliteMotion, StarMotion,
} from '../celestial-motion';
import { AU, planetOrbit } from '../planet-orbit';
import { MU_MARS } from './constants';
import { MARS_POLE } from './poles';
import { equatorialSatelliteOrbit } from './satellite-orbit-builders';

export const MARS: PlanetDef = {
  id: 'mars',
  mu: MU_MARS,
  radius: 3.39619e6, // 赤道半径(外接球)。出典: pck00011.tpc BODY_RADII
  shape: { kind: 'spheroid', equatorRadius: 3.39619e6, polarRadius: 3.3762e6 },
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
};

export const PHOBOS: SatelliteDef = {
  id: 'phobos',
  mu: 7.112e5,
  radius: 1.295e4, // 三軸の最長半軸(外接球)
  // 出典: pck00011.tpc BODY_RADII(直径 25.90 × 22.60 × 18.32 km を半径に換算)
  shape: { kind: 'triaxial', a: 1.295e4, b: 1.13e4, c: 9.16e3 },
  orbit: equatorialSatelliteOrbit({ a: 9.376e6, e: 0.0151, incDeg: 1.08, planetMu: MU_MARS, planetPole: MARS_POLE }),
};

export const DEIMOS: SatelliteDef = {
  id: 'deimos',
  mu: 9.85e4,
  radius: 8.04e3, // 三軸の最長半軸(外接球)
  // 出典: pck00011.tpc BODY_RADII(直径 16.08 × 11.78 × 10.22 km を半径に換算)
  shape: { kind: 'triaxial', a: 8.04e3, b: 5.89e3, c: 5.11e3 },
  orbit: equatorialSatelliteOrbit({ a: 2.3458e7, e: 0.00033, incDeg: 1.79, planetMu: MU_MARS, planetPole: MARS_POLE }),
};

export type MarsSystemMotions = {
  readonly mars: PlanetMotion;
  readonly phobos: SatelliteMotion;
  readonly deimos: SatelliteMotion;
};

// 火星と2個の衛星の運動を組む。
export function marsSystem(
  sun: StarMotion, phases: PhaseOffsets, epochOffsetSec: number,
  pack: OriginCenteredEphemeris | null, origin: EciOrigin,
): MarsSystemMotions {
  const mars = new PlanetMotion(MARS, sun, phases[MARS.id] ?? 0, epochOffsetSec, pack, origin);
  const phobos = new SatelliteMotion(PHOBOS, mars, phases[PHOBOS.id] ?? 0, epochOffsetSec, pack, origin);
  const deimos = new SatelliteMotion(DEIMOS, mars, phases[DEIMOS.id] ?? 0, epochOffsetSec, pack, origin);
  return { mars, phobos, deimos };
}
