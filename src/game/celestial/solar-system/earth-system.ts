// 地球系(地球・月)の見た目。physics 側 earth-system.ts の運動の名前付きフィールドと
// 写像型で1:1 に対応し、天体を足して見た目を書き忘れるとコンパイルエラーになる。
import * as THREE from 'three/webgpu';
import earthTextureUrl from '../../../assets/earth.jpg';
import cloudsTextureUrl from '../../../assets/8k_clouds.jpg';
import moonTextureUrl from '../../../assets/8k_moon.jpg';
import type { EarthSystemMotions } from '../../../physics/solar-system/earth-system';
import { Aurora, type AuroraOptics } from '../../../render/aurora';
import type { AtmosphereOptics } from '../../../render/atmosphere';
import { CelestialSurface } from '../../../render/celestial-surface';
import type { CelestialTexture } from '../../../render/celestial-textures';
import { EarthCoastline } from '../../../render/earth-coastline';
import { MoonSurfaceMarkings } from '../../../render/moon-surface-markings';
import type { CelestialEntity } from '../celestial-entity';
import { GeostationaryOverlay } from '../geostationary-overlay';
import { PointEntity } from '../point-entity';
import { SphereEntity } from '../sphere-entity';

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
export const EARTH_SYSTEM_NAMES: { readonly [K in keyof EarthSystemMotions]: string } = {
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

// 地球系の運動に見た目を対応づける。
export function earthSystemEntities(
  m: EarthSystemMotions,
): { readonly [K in keyof EarthSystemMotions]: CelestialEntity } {
  return {
    earth: new PointEntity(
      m.earth, EARTH_SYSTEM_NAMES.earth, 'planet',
      CelestialSurface.clouded(EARTH_TEXTURE, cloudsTextureUrl),
      EARTH_ATMOSPHERE_OPTICS, new EarthCoastline(), earthAuroras(),
      GeostationaryOverlay.of(m.earth),
    ),
    moon: new SphereEntity(
      m.moon, EARTH_SYSTEM_NAMES.moon, 'satellite',
      // 平均輝度 0.3180(A_B は公表ボンド)
      CelestialSurface.textured({ url: moonTextureUrl, albedoScale: 0.3459, bondAlbedo: 0.11, averageHue: [1.0458, 0.9880, 0.9844] }),
      null, new MoonSurfaceMarkings(),
    ),
  };
}
