// 地球系(地球・月)。静的事実・運動・見た目を1体につき1箇所で組む。
import * as THREE from 'three/webgpu';
import earthTextureUrl from '../../../assets/earth.jpg';
import cloudsTextureUrl from '../../../assets/8k_clouds.jpg';
import moonTextureUrl from '../../../assets/8k_moon.jpg';
import { HelioEphemeris } from '../../../physics/absolute-ephemeris';
import { AtmosphereDef } from '../../../physics/atmosphere';
import {
  PhaseOffsets, PlanetDef, planetDefAtEpoch, SatelliteDef, satelliteDefAtEpoch, SatelliteMotion, StarMotion,
} from '../../../physics/celestial-motion';
import { planetSystem } from '../../../physics/planet-system';
import { planetOrbit } from '../../../physics/planet-orbit';
import { satelliteOrbit } from '../../../physics/satellite-orbit';
import {
  C22_MOON, J2_EARTH, J2_MOON, MOON_OBLIQUITY, MU_EARTH, MU_MOON, R_EARTH_EQ, R_MOON, R_MOON_GRAVITY,
  SIDEREAL_DAY,
} from './constants';
import { Aurora, type AuroraOptics } from '../../../render/aurora';
import type { AtmosphereOptics } from '../../../render/atmosphere';
import { CelestialSurface } from '../../../render/celestial-surface';
import type { CelestialTexture } from '../../../render/celestial-textures';
import { EarthCoastline } from '../../../render/earth-coastline';
import { MoonSurfaceMarkings } from '../../../render/moon-surface-markings';
import type { CelestialEntity } from '../celestial-entity/celestial-entity';
import { GeostationaryOverlay } from '../celestial-entity/geostationary-overlay';
import { PointEntity } from '../celestial-entity/point-entity';
import { SphereEntity } from '../celestial-entity/sphere-entity';
import { MOON_DIST_TERMS, MOON_LAT_TERMS, MOON_LON_TERMS } from './moon-terms';

// 地球系に登録された天体の id。表示名も構築の網羅性もこの集合が決める。
export type EarthSystemBodyId = 'earth' | 'moon';

// 地球の大気。基準楕円体は海面の回転楕円体(WGS84)で、衝突球の半径(radius)や 2 次重力場の
// 基準半径(refRadius)とは別の理由で選ばれた別の量なので、値が一致していても別に宣言する。
// 層テーブルは Vallado, "Fundamentals of Astrodynamics and Applications" の CIRA-72 /
// U.S. Standard Atmosphere 準拠(高度 0〜1000 km を 28 区間)。
export const EARTH_ATMOSPHERE: AtmosphereDef = {
  equatorRadius: 6.378137e6,
  polarRadius: 6.356752e6,
  spinRate: (2 * Math.PI) / SIDEREAL_DAY,
  layers: [
    [0, 1.225, 7.249e3],
    [25e3, 3.899e-2, 6.349e3],
    [30e3, 1.774e-2, 6.682e3],
    [40e3, 3.972e-3, 7.554e3],
    [50e3, 1.057e-3, 8.382e3],
    [60e3, 3.206e-4, 7.714e3],
    [70e3, 8.77e-5, 6.549e3],
    [80e3, 1.905e-5, 5.799e3],
    [90e3, 3.396e-6, 5.382e3],
    [100e3, 5.297e-7, 5.877e3],
    [110e3, 9.661e-8, 7.263e3],
    [120e3, 2.438e-8, 9.473e3],
    [130e3, 8.484e-9, 12.636e3],
    [140e3, 3.845e-9, 16.149e3],
    [150e3, 2.07e-9, 22.523e3],
    [180e3, 5.464e-10, 29.74e3],
    [200e3, 2.789e-10, 37.105e3],
    [250e3, 7.248e-11, 45.546e3],
    [300e3, 2.418e-11, 53.628e3],
    [350e3, 9.518e-12, 53.298e3],
    [400e3, 3.725e-12, 58.515e3],
    [450e3, 1.585e-12, 60.828e3],
    [500e3, 6.967e-13, 63.822e3],
    [600e3, 1.454e-13, 71.835e3],
    [700e3, 3.614e-14, 88.667e3],
    [800e3, 1.17e-14, 124.64e3],
    [900e3, 5.245e-15, 181.05e3],
    [1000e3, 3.019e-15, 268.0e3],
  ],
};

export const EARTH: PlanetDef = {
  id: 'earth',
  mu: MU_EARTH,
  // 衝突球・高度基準は赤道半径(外接球) — R_EARTH(平均半径)は大気・熱等のゲームプレイ側が
  // 引き続き使う別の量。
  radius: R_EARTH_EQ,
  lagrangeLabels: true,
  // 出典: pck00011.tpc BODY_RADII(Re=6378.1366km, Rp=6356.7519km)。
  shape: { kind: 'spheroid', equatorRadius: R_EARTH_EQ, polarRadius: 6.3567519e6 },
  // JPL 低精度惑星暦の "EM Bary"(地球-月重心)行、黄道基準・J2000 相当。
  orbit: planetOrbit({
    a: 1.495978707e11,
    e: 0.01671123,
    incDeg: 0,
    raanDeg: 0,
    lonPeriDeg: 102.93768,
    l0Deg: 100.46457166,
    lRateDegPerCentury: 35999.37244981,
    raanRateDegPerCentury: 0,
    incRateDegPerCentury: -0.01294668,
    lonPeriRateDegPerCentury: 0.32327364,
    eRatePerCentury: -0.00004392,
    aRatePerCenturyAu: 0.00000562,
  }),
  pole: { kind: 'eciPole', spinRate: (2 * Math.PI) / SIDEREAL_DAY },
  // 赤道断面の楕円性 C22 は J2 の約 1/690 しかないため軸対称として扱う。
  degree2: { j2: J2_EARTH, c22: 0, refRadius: R_EARTH_EQ },
  atmosphere: EARTH_ATMOSPHERE,
};

export const MOON: SatelliteDef = {
  id: 'moon',
  mu: MU_MOON,
  radius: R_MOON,
  lagrangeLabels: true,
  orbit: satelliteOrbit({
    a: 3.844e8,
    e: 0.0549,
    incDeg: 5.145,
    raan0Deg: 0,
    lonPeri0Deg: 0,
    l0Deg: 0,
    periodSec: 27.321661 * 86400,
    nodePeriodSec: 18.612958 * 365.25 * 86400,
    perigeePeriodSec: 8.85 * 365.25 * 86400,
    lonTerms: MOON_LON_TERMS,
    latTerms: MOON_LAT_TERMS,
    distTerms: MOON_DIST_TERMS,
  }),
  pole: { kind: 'cassini', obliquity: MOON_OBLIQUITY },
  // J2 に対する C22 の比が地球の約 1/690 に対して約 1/9 と大きく、軸対称近似が成り立たない。
  degree2: { j2: J2_MOON, c22: C22_MOON, refRadius: R_MOON_GRAVITY },
};

// 標準大気の分子散乱と、視程 50km 相当のエーロゾル。render-lab の大気ケースも同じ値を読む。
export const EARTH_ATMOSPHERE_OPTICS: AtmosphereOptics = {
  rayleigh: new THREE.Vector3(5.802e-6, 13.558e-6, 33.1e-6),
  rayleighScaleHeight: 8.0e3,
  mie: 3.996e-6,
  mieScaleHeight: 1.2e3,
  mieAnisotropy: 0.8,
};

// 地表・雲・雲影を合成したアルベドの測光。平均輝度 0.3104 は合成後の式で測った値で、
// A_B=0.306 との比が倍率。averageHue も合成後の式で測った色み。
export const EARTH_TEXTURE: CelestialTexture = {
  url: earthTextureUrl,
  albedoScale: 0.9858,
  bondAlbedo: 0.306,
  averageHue: [0.9695, 0.9937, 1.1519],
};

// 地球のオーロラ。オーバル緯度は磁極の配置、発光高度は降り込む粒子が大気を励起する層、
// 色は酸素の緑(557.7nm)と赤(630nm)の輝線による。
const EARTH_AURORA_OPTICS: AuroraOptics = {
  bodyRadius: 6.371e6,
  ovalLatitudeDeg: 66,
  baseAltitude: 95e3,
  coreAltitude: 120e3,
  topAltitude: 480e3,
  topAltitudeVariation: 180e3,
  layerColors: [
    [0.0, 0.1, 0.05],
    [0.1, 0.9, 0.4],
    [0.7, 0.15, 0.2],
    [0.1, 0.01, 0.02],
  ],
};

// 地球系の天体の表示名。
export const EARTH_SYSTEM_NAMES: Record<EarthSystemBodyId, string> = {
  earth: '地球',
  moon: '月',
};

// 両極それぞれ2層のカーテン。同じ極の層は geomSeed を揃えて平行にし、半径・緯度・明滅を
// ずらして厚みを出す。
function earthAuroras(): readonly Aurora[] {
  const o = EARTH_AURORA_OPTICS;
  return [
    new Aurora(o, 1, 1.3, 1.3, 0, 0, 0),
    new Aurora(o, 1, 1.3, 2.7, 45e3, 1.5, 1),
    new Aurora(o, -1, 4.1, 4.1, 0, 0, 2),
    new Aurora(o, -1, 4.1, 5.5, 45e3, 1.5, 3),
  ];
}

// 地球系を組む。宣言順がそのまま重力源配列・一覧の順序になる。
// earthSpinPhase0 は地球の自転初期位相 [rad]。
export function earthSystem(
  sun: StarMotion, phases: PhaseOffsets, epochOffsetSec: number,
  pack: HelioEphemeris | null, earthSpinPhase0 = 0,
): Record<EarthSystemBodyId, CelestialEntity> {
  const earth = planetSystem(planetDefAtEpoch(EARTH, phases, epochOffsetSec), sun, pack, earthSpinPhase0);
  return {
    earth: new PointEntity(
      earth.body, EARTH_SYSTEM_NAMES.earth, 'planet',
      CelestialSurface.clouded(EARTH_TEXTURE, cloudsTextureUrl),
      EARTH_ATMOSPHERE_OPTICS, new EarthCoastline(), earthAuroras(),
      GeostationaryOverlay.of(earth.body),
    ),
    moon: new SphereEntity(
      new SatelliteMotion(satelliteDefAtEpoch(MOON, phases, epochOffsetSec), earth, pack),
      EARTH_SYSTEM_NAMES.moon, 'satellite',
      // 平均輝度 0.3180(A_B は公表ボンド)
      CelestialSurface.textured({ url: moonTextureUrl, albedoScale: 0.3459, bondAlbedo: 0.11, averageHue: [1.0458, 0.9880, 0.9844] }),
      null, new MoonSurfaceMarkings(),
    ),
  };
}
