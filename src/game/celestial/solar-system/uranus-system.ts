// 天王星系(天王星・6衛星)の見た目。physics 側 uranus-system.ts の運動の名前付きフィールドと
// 写像型で1:1 に対応し、天体を足して見た目を書き忘れるとコンパイルエラーになる。
import uranusTextureUrl from '../../../assets/2k_uranus.jpg';
import type { UranusSystemMotions } from '../../../physics/solar-system/uranus-system';
import { CelestialSurface } from '../../../render/celestial-surface';
import type { CelestialEntity } from '../celestial-entity';
import { PointEntity } from '../point-entity';
import { SphereEntity } from '../sphere-entity';

// 天王星系の運動に見た目を対応づける。
export function uranusSystemEntities(
  m: UranusSystemMotions,
): { readonly [K in keyof UranusSystemMotions]: CelestialEntity } {
  return {
    uranus: new PointEntity(
      m.uranus, '天王星', 'planet',
      // 平均輝度 0.5640(A_B は公表ボンド)
      CelestialSurface.textured({ url: uranusTextureUrl, albedoScale: 0.5320, bondAlbedo: 0.3, averageHue: [0.6079, 1.0981, 1.1831] }),
    ),
    puck: new SphereEntity(
      m.puck, 'パック', 'satellite',
      // A_B=0.051(幾何 0.11 x q=0.461)
      CelestialSurface.solid([0.0536, 0.0508, 0.0455]),
    ),
    miranda: new SphereEntity(
      m.miranda, 'ミランダ', 'satellite',
      // A_B=0.18(幾何 0.32 x q=0.564)
      CelestialSurface.solid([0.1875, 0.1791, 0.1668]),
    ),
    ariel: new SphereEntity(
      m.ariel, 'アリエル', 'satellite',
      // A_B=0.3(幾何 0.53 x q=0.564)
      CelestialSurface.solid([0.3059, 0.2996, 0.2871]),
    ),
    umbriel: new SphereEntity(
      m.umbriel, 'ウンブリエル', 'satellite',
      // A_B=0.15(幾何 0.26 x q=0.564)
      CelestialSurface.solid([0.1562, 0.1490, 0.1420]),
    ),
    titania: new SphereEntity(
      m.titania, 'チタニア', 'satellite',
      // A_B=0.2(幾何 0.35 x q=0.564)
      CelestialSurface.solid([0.2044, 0.2000, 0.1872]),
    ),
    oberon: new SphereEntity(
      m.oberon, 'オベロン', 'satellite',
      // A_B=0.17(幾何 0.31 x q=0.564)
      CelestialSurface.solid([0.1773, 0.1694, 0.1543]),
    ),
  };
}
