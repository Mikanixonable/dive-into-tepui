// 火星系(火星・フォボス・ダイモス)。静的事実・運動・見た目を1体につき1箇所で組む。
import * as THREE from 'three/webgpu';
import marsTextureUrl from '../../../assets/2k_mars.jpg';
import phobosTextureUrl from '../../../assets/2k_phobos.jpg';
import { HelioEphemeris } from '../../../physics/absolute-ephemeris';
import {
  EciOrigin, PhaseOffsets, PlanetDef, PlanetMotion, SatelliteDef, SatelliteMotion, StarMotion,
} from '../../../physics/celestial-motion';
import { AU, planetOrbit } from '../../../physics/planet-orbit';
import { MU_MARS } from './constants';
import type { AtmosphereOptics } from '../../../render/atmosphere';
import type { CelestialTexture } from '../../../render/celestial-textures';
import { CelestialSurface } from '../../../render/celestial-surface';
import type { CelestialEntity } from '../celestial-entity/celestial-entity';
import { PointEntity } from '../celestial-entity/point-entity';
import { SphereEntity } from '../celestial-entity/sphere-entity';
import { MARS_POLE } from './poles';
import { equatorialSatelliteOrbit } from './satellite-orbit-builders';

// 火星系に登録された天体の id。表示名も構築の網羅性もこの集合が決める。
export type MarsSystemBodyId = 'mars' | 'phobos' | 'deimos';

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

const DEIMOS: SatelliteDef = {
  id: 'deimos',
  mu: 9.85e4,
  radius: 8.04e3, // 三軸の最長半軸(外接球)
  // 出典: pck00011.tpc BODY_RADII(直径 16.08 × 11.78 × 10.22 km を半径に換算)
  shape: { kind: 'triaxial', a: 8.04e3, b: 5.89e3, c: 5.11e3 },
  orbit: equatorialSatelliteOrbit({ a: 2.3458e7, e: 0.00033, incDeg: 1.79, planetMu: MU_MARS, planetPole: MARS_POLE }),
};

// 地球の 1/166 の柱密度へ CO2 の散乱断面積を掛けた分子散乱と、光学的厚み 0.3 の浮遊塵。
// **塵が分子散乱を2桁上回る**ので、空の色は青ではなく塵の色になる。塵は地球のエーロゾルと
// 違って大気全体へ混ざるため、スケールハイトが分子と同じになる。
export const MARS_ATMOSPHERE_OPTICS: AtmosphereOptics = {
  rayleigh: new THREE.Vector3(8.6e-8, 2.0e-7, 4.9e-7),
  rayleighScaleHeight: 11.1e3,
  mie: 2.7e-5,
  mieScaleHeight: 11.1e3,
  mieAnisotropy: 0.65,
};

// 平均輝度 0.1830(A_B は公表ボンド)。render-lab の火星ケースも同じテクスチャ・測光を読む。
export const MARS_TEXTURE: CelestialTexture = {
  url: marsTextureUrl, albedoScale: 1.3663, bondAlbedo: 0.25, averageHue: [2.6054, 0.5946, 0.2888],
};

// 火星系の天体の表示名。
export const MARS_SYSTEM_NAMES: Record<MarsSystemBodyId, string> = {
  mars: '火星',
  phobos: 'フォボス',
  deimos: 'ダイモス',
};

// 火星系を組む。宣言順がそのまま重力源配列・一覧の順序になる。
export function marsSystem(
  sun: StarMotion, phases: PhaseOffsets, epochOffsetSec: number,
  pack: HelioEphemeris | null, origin: EciOrigin,
): Record<MarsSystemBodyId, CelestialEntity> {
  const mars = new PlanetMotion(MARS, sun, phases[MARS.id] ?? 0, epochOffsetSec, pack, origin);
  return {
    mars: new PointEntity(
      mars, MARS_SYSTEM_NAMES.mars, 'planet', CelestialSurface.textured(MARS_TEXTURE), MARS_ATMOSPHERE_OPTICS,
    ),
    phobos: new SphereEntity(
      new SatelliteMotion(PHOBOS, mars, phases[PHOBOS.id] ?? 0, epochOffsetSec, pack, origin),
      MARS_SYSTEM_NAMES.phobos, 'satellite',
      // 平均輝度 0.2774(A_B は幾何 0.071 x q=0.393)
      CelestialSurface.textured({ url: phobosTextureUrl, albedoScale: 0.1009, bondAlbedo: 0.028, averageHue: [1, 1, 1] }),
    ),
    deimos: new SphereEntity(
      new SatelliteMotion(DEIMOS, mars, phases[DEIMOS.id] ?? 0, epochOffsetSec, pack, origin),
      MARS_SYSTEM_NAMES.deimos, 'satellite',
      // A_B=0.027(幾何 0.068 x q=0.393)
      CelestialSurface.solid([0.0330, 0.0259, 0.0199]),
    ),
  };
}
