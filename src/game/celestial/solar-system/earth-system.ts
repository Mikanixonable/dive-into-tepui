// 地球系(地球・月)の見た目。physics 側 earth-system.ts の運動の名前付きフィールドと
// 写像型で1:1 に対応し、天体を足して見た目を書き忘れるとコンパイルエラーになる。
import * as THREE from 'three/webgpu';
import moonTextureUrl from '../../../assets/8k_moon.jpg';
import type { EarthSystemMotions } from '../../../physics/solar-system/earth-system';
import type { AtmosphereOptics } from '../../../render/atmosphere';
import { CelestialSurface } from '../../../render/celestial-surface';
import { MoonSurfaceMarkings } from '../../../render/moon-surface-markings';
import type { CelestialEntity } from '../celestial-entity';
import { Earth } from '../earth';
import { SphereEntity } from '../sphere-entity';

// 標準大気の分子散乱と、視程 50km 相当のエーロゾル。render-lab の大気ケースも同じ値を読む。
export const EARTH_ATMOSPHERE_OPTICS: AtmosphereOptics = {
  rayleigh: new THREE.Vector3(5.802e-6, 13.558e-6, 33.1e-6),
  rayleighScaleHeight: 8.0e3,
  mie: 3.996e-6,
  mieScaleHeight: 1.2e3,
  mieAnisotropy: 0.8,
};

// 地球系の運動に見た目を対応づける。
export function earthSystemEntities(
  m: EarthSystemMotions,
): { readonly [K in keyof EarthSystemMotions]: CelestialEntity } {
  return {
    earth: new Earth(m.earth, '地球', EARTH_ATMOSPHERE_OPTICS),
    moon: new SphereEntity(
      m.moon, '月', 'satellite',
      // 平均輝度 0.3180(A_B は公表ボンド)
      CelestialSurface.textured({ url: moonTextureUrl, albedoScale: 0.3459, bondAlbedo: 0.11, averageHue: [1.0458, 0.9880, 0.9844] }),
      null, () => new MoonSurfaceMarkings(),
    ),
  };
}
