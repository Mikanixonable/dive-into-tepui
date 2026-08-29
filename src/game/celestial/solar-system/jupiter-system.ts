// 木星系(木星と14個の衛星)の見た目。physics 側 jupiter-system.ts の運動の名前付きフィールドと
// 写像型で1:1 に対応し、天体を足して見た目を書き忘れるとコンパイルエラーになる。
import callistoTextureUrl from '../../../assets/2k_callisto.jpg';
import europaTextureUrl from '../../../assets/2k_europa.jpg';
import ganymedeTextureUrl from '../../../assets/2k_ganymede.jpg';
import ioTextureUrl from '../../../assets/2k_io.jpg';
import jupiterTextureUrl from '../../../assets/2k_jupiter.jpg';
import type { JupiterSystemMotions } from '../../../physics/solar-system/jupiter-system';
import { CelestialSurface } from '../../../render/celestial-surface';
import type { CelestialEntity } from '../celestial-entity';
import { PointEntity } from '../point-entity';
import { SphereEntity } from '../sphere-entity';

// 木星系の天体の表示名。
export const JUPITER_SYSTEM_NAMES: { readonly [K in keyof JupiterSystemMotions]: string } = {
  jupiter: '木星',
  metis: 'メティス',
  adrastea: 'アドラステア',
  amalthea: 'アマルテア',
  thebe: 'テーベ',
  io: 'イオ',
  europa: 'エウロパ',
  ganymede: 'ガニメデ',
  callisto: 'カリスト',
  himalia: 'ヒマリア',
  elara: 'エララ',
  ananke: 'アナンケ',
  carme: 'カルメ',
  pasiphae: 'パシファエ',
  sinope: 'シノーペ',
};

// 木星系の運動に見た目を対応づける。
export function jupiterSystemEntities(
  m: JupiterSystemMotions,
): { readonly [K in keyof JupiterSystemMotions]: CelestialEntity } {
  const names = JUPITER_SYSTEM_NAMES;
  return {
    jupiter: new PointEntity(
      m.jupiter, names.jupiter, 'planet',
      // 平均輝度 0.4116(A_B は公表ボンド)
      CelestialSurface.textured({ url: jupiterTextureUrl, albedoScale: 1.2222, bondAlbedo: 0.503, averageHue: [1.0987, 0.9845, 0.8629] }),
    ),
    // メティス A_B=0.024(幾何 0.061 x q=0.393)
    metis: new SphereEntity(m.metis, names.metis, 'satellite', CelestialSurface.solid([0.0285, 0.0231, 0.0193])),
    // アドラステア A_B=0.039(幾何 0.10 x q=0.393)
    adrastea: new SphereEntity(m.adrastea, names.adrastea, 'satellite', CelestialSurface.solid([0.0463, 0.0376, 0.0314])),
    // アマルテア A_B=0.035(幾何 0.090 x q=0.393)
    amalthea: new SphereEntity(m.amalthea, names.amalthea, 'satellite', CelestialSurface.solid([0.0673, 0.0271, 0.0181])),
    // テーベ A_B=0.018(幾何 0.047 x q=0.393)
    thebe: new SphereEntity(m.thebe, names.thebe, 'satellite', CelestialSurface.solid([0.0214, 0.0174, 0.0145])),
    io: new SphereEntity(
      m.io, names.io, 'satellite',
      // 平均輝度 0.2621(A_B は幾何 0.63 x q=0.564)
      CelestialSurface.textured({ url: ioTextureUrl, albedoScale: 1.3543, bondAlbedo: 0.355, averageHue: [1.3697, 0.9471, 0.4357] }),
    ),
    europa: new SphereEntity(
      m.europa, names.europa, 'satellite',
      // 平均輝度 0.3127(A_B は幾何 0.67 x q=0.564)
      CelestialSurface.textured({ url: europaTextureUrl, albedoScale: 1.2089, bondAlbedo: 0.378, averageHue: [1, 1, 1] }),
    ),
    ganymede: new SphereEntity(
      m.ganymede, names.ganymede, 'satellite',
      // 平均輝度 0.1777(A_B は幾何 0.43 x q=0.564)
      CelestialSurface.textured({ url: ganymedeTextureUrl, albedoScale: 1.3675, bondAlbedo: 0.243, averageHue: [1.0763, 0.9959, 0.8162] }),
    ),
    callisto: new SphereEntity(
      m.callisto, names.callisto, 'satellite',
      // 平均輝度 0.0491(A_B は公表ボンド)
      CelestialSurface.textured({ url: callistoTextureUrl, albedoScale: 2.2403, bondAlbedo: 0.11, averageHue: [1, 1, 1] }),
    ),
    // ヒマリア A_B=0.016(幾何 0.04 x q=0.393)
    himalia: new SphereEntity(m.himalia, names.himalia, 'satellite', CelestialSurface.solid([0.0190, 0.0156, 0.0114])),
    // エララ A_B=0.016(分類既定 幾何 0.04 x q=0.393)
    elara: new SphereEntity(m.elara, names.elara, 'satellite', CelestialSurface.solid([0.0206, 0.0151, 0.0108])),
    // アナンケ A_B=0.016(分類既定 幾何 0.04 x q=0.393)
    ananke: new SphereEntity(m.ananke, names.ananke, 'satellite', CelestialSurface.solid([0.0188, 0.0156, 0.0121])),
    // カルメ A_B=0.016(分類既定 幾何 0.04 x q=0.393)
    carme: new SphereEntity(m.carme, names.carme, 'satellite', CelestialSurface.solid([0.0190, 0.0154, 0.0129])),
    // パシファエ A_B=0.016(分類既定 幾何 0.04 x q=0.393)
    pasiphae: new SphereEntity(m.pasiphae, names.pasiphae, 'satellite', CelestialSurface.solid([0.0197, 0.0153, 0.0116])),
    // シノーペ A_B=0.016(分類既定 幾何 0.04 x q=0.393)
    sinope: new SphereEntity(m.sinope, names.sinope, 'satellite', CelestialSurface.solid([0.0203, 0.0152, 0.0112])),
  };
}
