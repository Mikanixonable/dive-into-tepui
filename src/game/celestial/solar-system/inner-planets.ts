// 内惑星(水星・金星)の見た目。physics 側 inner-planets.ts の運動の名前付きフィールドと
// 写像型で1:1 に対応し、天体を足して見た目を書き忘れるとコンパイルエラーになる。
import mercuryTextureUrl from '../../../assets/2k_mercury.jpg';
import venusTextureUrl from '../../../assets/2k_venus_atmosphere.jpg';
import type { InnerPlanetMotions } from '../../../physics/solar-system/inner-planets';
import { CelestialSurface } from '../../../render/celestial-surface';
import type { CelestialEntity } from '../celestial-entity';
import { PointEntity } from '../point-entity';

// 内惑星の運動に見た目を対応づける。
export function innerPlanetEntities(
  m: InnerPlanetMotions,
): { readonly [K in keyof InnerPlanetMotions]: CelestialEntity } {
  return {
    mercury: new PointEntity(
      m.mercury, '水星', 'planet',
      // 平均輝度 0.2306(A_B は公表ボンド)
      CelestialSurface.textured({ url: mercuryTextureUrl, albedoScale: 0.3815, bondAlbedo: 0.088, averageHue: [1.0088, 0.9974, 0.9997] }),
    ),
    venus: new PointEntity(
      m.venus, '金星', 'planet',
      // 平均輝度 0.5561(A_B は公表ボンド)
      CelestialSurface.textured({ url: venusTextureUrl, albedoScale: 1.3666, bondAlbedo: 0.76, averageHue: [1.4227, 0.9352, 0.3977] }),
    ),
  };
}
