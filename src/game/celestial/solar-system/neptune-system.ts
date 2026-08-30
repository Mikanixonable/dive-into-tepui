// 海王星系(海王星・トリトン・ネレイド)。静的事実・運動・見た目を1体につき1箇所で組む。
import neptuneTextureUrl from '../../../assets/2k_neptune.jpg';
import { HelioEphemeris } from '../../../physics/absolute-ephemeris';
import {
  EciOrigin, PhaseOffsets, PlanetDef, planetDefAtEpoch, SatelliteDef, satelliteDefAtEpoch, SatelliteMotion, StarMotion,
} from '../../../physics/celestial-motion';
import { planetSystem } from '../../../physics/planet-system';
import { AU, planetOrbit } from '../../../physics/planet-orbit';
import { MU_NEPTUNE } from './constants';
import { CelestialSurface } from '../../../render/celestial-surface';
import type { CelestialEntity } from '../celestial-entity/celestial-entity';
import { PointEntity } from '../celestial-entity/point-entity';
import { SphereEntity } from '../celestial-entity/sphere-entity';
import { NEPTUNE_POLE } from './poles';
import { NEPTUNE_RINGS } from './rings';
import { equatorialSatelliteOrbit, jplSatelliteOrbit } from './satellite-orbit-builders';

// 海王星系に登録された天体の id。表示名も構築の網羅性もこの集合が決める。
export type NeptuneSystemBodyId = 'neptune' | 'triton' | 'nereid';

const NEPTUNE: PlanetDef = {
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

const TRITON: SatelliteDef = {
  id: 'triton',
  mu: 1.4276e12,
  radius: 1.3534e6,
  // 傾斜 90° 超が逆行を表す。
  orbit: equatorialSatelliteOrbit({ a: 3.5476e8, e: 0.000016, incDeg: 156.885, planetMu: MU_NEPTUNE, planetPole: NEPTUNE_POLE }),
};

// ネレイド。トリトンの潮汐力に大きく乱された高離心率の遠方軌道で、黄道基準の平均要素を使う
// (出典・GM/半径の扱いはヒマリア群と同じ)。GM は未測定。
const NEREID: SatelliteDef = {
  id: 'nereid',
  mu: 0,
  radius: 1.7e5,
  orbit: jplSatelliteOrbit({ a: 5.5139e9, e: 0.751, incDeg: 5.1, periodDays: 360.133039, nodePeriodYears: 0, apsisPeriodYears: 0 }),
};

// 海王星系の天体の表示名。
export const NEPTUNE_SYSTEM_NAMES: Record<NeptuneSystemBodyId, string> = {
  neptune: '海王星',
  triton: 'トリトン',
  nereid: 'ネレイド',
};

// 海王星系を組む。宣言順がそのまま重力源配列・一覧の順序になる。
export function neptuneSystem(
  sun: StarMotion, phases: PhaseOffsets, epochOffsetSec: number,
  pack: HelioEphemeris | null, origin: EciOrigin,
): Record<NeptuneSystemBodyId, CelestialEntity> {
  const neptune = planetSystem(planetDefAtEpoch(NEPTUNE, phases, epochOffsetSec), sun, pack, origin);
  return {
    neptune: new PointEntity(
      neptune.body, NEPTUNE_SYSTEM_NAMES.neptune, 'planet',
      // 平均輝度 0.1228(A_B は公表ボンド)
      CelestialSurface.textured({ url: neptuneTextureUrl, albedoScale: 2.3609, bondAlbedo: 0.29, averageHue: [0.3358, 0.9100, 3.8476] }),
    ),
    triton: new SphereEntity(
      new SatelliteMotion(satelliteDefAtEpoch(TRITON, phases, epochOffsetSec), neptune, pack, origin),
      NEPTUNE_SYSTEM_NAMES.triton, 'satellite',
      // A_B=0.43(幾何 0.76 x q=0.564)
      CelestialSurface.solid([0.4794, 0.4216, 0.3680]),
    ),
    nereid: new SphereEntity(
      new SatelliteMotion(satelliteDefAtEpoch(NEREID, phases, epochOffsetSec), neptune, pack, origin),
      NEPTUNE_SYSTEM_NAMES.nereid, 'satellite',
      // A_B=0.071(幾何 0.155 x q=0.461)
      CelestialSurface.solid([0.0816, 0.0693, 0.0563]),
    ),
  };
}
