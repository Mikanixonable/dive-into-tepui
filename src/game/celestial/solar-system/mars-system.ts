// 火星系(火星・フォボス・ダイモス)の見た目。physics 側 mars-system.ts の運動の名前付き
// フィールドと写像型で1:1 に対応し、天体を足して見た目を書き忘れるとコンパイルエラーになる。
import * as THREE from 'three/webgpu';
import marsTextureUrl from '../../../assets/2k_mars.jpg';
import phobosTextureUrl from '../../../assets/2k_phobos.jpg';
import type { MarsSystemMotions } from '../../../physics/solar-system/mars-system';
import type { AtmosphereOptics } from '../../../render/atmosphere';
import type { CelestialTexture } from '../../../render/celestial-textures';
import { CelestialSurface } from '../../../render/celestial-surface';
import type { CelestialEntity } from '../celestial-entity';
import { PointEntity } from '../point-entity';
import { SphereEntity } from '../sphere-entity';

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

// 火星系の運動に見た目を対応づける。
export function marsSystemEntities(
  m: MarsSystemMotions,
): { readonly [K in keyof MarsSystemMotions]: CelestialEntity } {
  return {
    mars: new PointEntity(m.mars, '火星', 'planet', CelestialSurface.textured(MARS_TEXTURE), MARS_ATMOSPHERE_OPTICS),
    phobos: new SphereEntity(
      m.phobos, 'フォボス', 'satellite',
      // 平均輝度 0.2774(A_B は幾何 0.071 x q=0.393)
      CelestialSurface.textured({ url: phobosTextureUrl, albedoScale: 0.1009, bondAlbedo: 0.028, averageHue: [1, 1, 1] }),
    ),
    deimos: new SphereEntity(
      m.deimos, 'ダイモス', 'satellite',
      // A_B=0.027(幾何 0.068 x q=0.393)
      CelestialSurface.solid([0.0330, 0.0259, 0.0199]),
    ),
  };
}
