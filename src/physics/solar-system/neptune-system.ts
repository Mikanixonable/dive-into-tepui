// 海王星と2個の衛星の静的事実と、その運動を組む構築関数。
import { OriginCenteredEphemeris } from '../absolute-ephemeris';
import {
  EciOrigin, PhaseOffsets, PlanetDef, PlanetMotion, SatelliteDef, SatelliteMotion, StarMotion,
} from '../celestial-motion';
import { AU, planetOrbit } from '../planet-orbit';
import { MU_NEPTUNE } from './constants';
import { NEPTUNE_POLE } from './poles';
import { NEPTUNE_RINGS } from './rings';
import { equatorialSatelliteOrbit, jplSatelliteOrbit } from './satellite-orbit-builders';

export const NEPTUNE: PlanetDef = {
  id: 'neptune',
  mu: MU_NEPTUNE,
  radius: 2.47606e7, // 赤道半径(外接球)。出典: pck00011.tpc BODY_RADII
  shape: { kind: 'spheroid', equatorRadius: 2.47606e7, polarRadius: 2.42853e7 },
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
  rings: NEPTUNE_RINGS,
};

export const TRITON: SatelliteDef = {
  id: 'triton',
  mu: 1.4276e12,
  radius: 1.3534e6,
  // 傾斜 90° 超が逆行を表す。
  orbit: equatorialSatelliteOrbit({ a: 3.5476e8, e: 0.000016, incDeg: 156.885, planetMu: MU_NEPTUNE, planetPole: NEPTUNE_POLE }),
};

// ネレイド。トリトンの潮汐力に大きく乱された高離心率の遠方軌道で、黄道基準の平均要素を使う
// (出典・GM/半径の扱いはヒマリア群と同じ)。GM は未測定。
export const NEREID: SatelliteDef = {
  id: 'nereid',
  mu: 0,
  radius: 1.7e5,
  orbit: jplSatelliteOrbit({ a: 5.5139e9, e: 0.751, incDeg: 5.1, periodDays: 360.133039, nodePeriodYears: 0, apsisPeriodYears: 0 }),
};

export type NeptuneSystemMotions = {
  readonly neptune: PlanetMotion;
  readonly triton: SatelliteMotion;
  readonly nereid: SatelliteMotion;
};

// 海王星と2個の衛星の運動を組む。
export function neptuneSystem(
  sun: StarMotion, phases: PhaseOffsets, epochOffsetSec: number,
  pack: OriginCenteredEphemeris | null, origin: EciOrigin,
): NeptuneSystemMotions {
  const neptune = new PlanetMotion(NEPTUNE, sun, phases[NEPTUNE.id] ?? 0, epochOffsetSec, pack, origin);
  const triton = new SatelliteMotion(TRITON, neptune, phases[TRITON.id] ?? 0, epochOffsetSec, pack, origin);
  const nereid = new SatelliteMotion(NEREID, neptune, phases[NEREID.id] ?? 0, epochOffsetSec, pack, origin);
  return { neptune, triton, nereid };
}
