// 海王星系(海王星・トリトン・ネレイド)の見た目。physics 側 neptune-system.ts の運動の
// 名前付きフィールドと写像型で1:1 に対応し、天体を足して見た目を書き忘れるとコンパイルエラーになる。
import neptuneTextureUrl from '../../../assets/2k_neptune.jpg';
import type { NeptuneSystemMotions } from '../../../physics/solar-system/neptune-system';
import { CelestialSurface } from '../../../render/celestial-surface';
import type { CelestialEntity } from '../celestial-entity';
import { PointEntity } from '../point-entity';
import { SphereEntity } from '../sphere-entity';

// 海王星系の運動に見た目を対応づける。
export function neptuneSystemEntities(
  m: NeptuneSystemMotions,
): { readonly [K in keyof NeptuneSystemMotions]: CelestialEntity } {
  return {
    neptune: new PointEntity(
      m.neptune, '海王星', 'planet',
      // 平均輝度 0.1228(A_B は公表ボンド)
      CelestialSurface.textured({ url: neptuneTextureUrl, albedoScale: 2.3609, bondAlbedo: 0.29, averageHue: [0.3358, 0.9100, 3.8476] }),
    ),
    triton: new SphereEntity(
      m.triton, 'トリトン', 'satellite',
      // A_B=0.43(幾何 0.76 x q=0.564)
      CelestialSurface.solid([0.4794, 0.4216, 0.3680]),
    ),
    nereid: new SphereEntity(
      m.nereid, 'ネレイド', 'satellite',
      // A_B=0.071(幾何 0.155 x q=0.461)
      CelestialSurface.solid([0.0816, 0.0693, 0.0563]),
    ),
  };
}
