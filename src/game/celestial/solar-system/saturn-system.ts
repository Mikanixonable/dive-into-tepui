// 土星系(土星と15個の衛星)の見た目。physics 側 saturn-system.ts の運動の名前付きフィールドと
// 写像型で1:1 に対応し、天体を足して見た目を書き忘れるとコンパイルエラーになる。
import saturnTextureUrl from '../../../assets/2k_saturn.jpg';
import titanTextureUrl from '../../../assets/2k_titan.jpg';
import type { SaturnSystemMotions } from '../../../physics/solar-system/saturn-system';
import type { CelestialTexture } from '../../../render/celestial-textures';
import { CelestialSurface } from '../../../render/celestial-surface';
import type { CelestialEntity } from '../celestial-entity';
import { PointEntity } from '../point-entity';
import { SphereEntity } from '../sphere-entity';

// 平均輝度 0.6160(A_B は公表ボンド)。render-lab の土星ケースも同じ測光を読む。
export const SATURN_TEXTURE: CelestialTexture = {
  url: saturnTextureUrl, albedoScale: 0.5552, bondAlbedo: 0.342, averageHue: [1.2028, 0.9763, 0.6378],
};

// 土星系の天体の表示名。
export const SATURN_SYSTEM_NAMES: { readonly [K in keyof SaturnSystemMotions]: string } = {
  saturn: '土星',
  pan: 'パン',
  daphnis: 'ダフニス',
  prometheus: 'プロメテウス',
  pandora: 'パンドラ',
  epimetheus: 'エピメテウス',
  janus: 'ヤヌス',
  mimas: 'ミマス',
  enceladus: 'エンケラドゥス',
  tethys: 'テティス',
  dione: 'ディオネ',
  rhea: 'レア',
  titan: 'タイタン',
  hyperion: 'ヒペリオン',
  iapetus: 'イアペトゥス',
  phoebe: 'フェーベ',
};

// 土星系の運動に見た目を対応づける。
export function saturnSystemEntities(
  m: SaturnSystemMotions,
): { readonly [K in keyof SaturnSystemMotions]: CelestialEntity } {
  const names = SATURN_SYSTEM_NAMES;
  return {
    // 惑星は戦闘ビューでは輝点スプライトとして描くので PointEntity。
    saturn: new PointEntity(m.saturn, names.saturn, 'planet', CelestialSurface.textured(SATURN_TEXTURE)),
    // パン A_B=0.28(幾何 0.5 x q=0.564)
    pan: new SphereEntity(m.pan, names.pan, 'satellite', CelestialSurface.solid([0.3326, 0.2699, 0.2252])),
    // ダフニス A_B=0.28(分類既定 幾何 0.5 x q=0.564)
    daphnis: new SphereEntity(m.daphnis, names.daphnis, 'satellite', CelestialSurface.solid([0.3326, 0.2699, 0.2252])),
    // プロメテウス A_B=0.34(幾何 0.6 x q=0.564)
    prometheus: new SphereEntity(m.prometheus, names.prometheus, 'satellite', CelestialSurface.solid([0.3956, 0.3294, 0.2814])),
    // パンドラ A_B=0.34(幾何 0.6 x q=0.564)
    pandora: new SphereEntity(m.pandora, names.pandora, 'satellite', CelestialSurface.solid([0.3956, 0.3294, 0.2814])),
    // エピメテウス A_B=0.41(幾何 0.73 x q=0.564)
    epimetheus: new SphereEntity(m.epimetheus, names.epimetheus, 'satellite', CelestialSurface.solid([0.4694, 0.3987, 0.3469])),
    // ヤヌス A_B=0.4(幾何 0.71 x q=0.564)
    janus: new SphereEntity(m.janus, names.janus, 'satellite', CelestialSurface.solid([0.4580, 0.3890, 0.3385])),
    // ミマス A_B=0.54(幾何 0.962 x q=0.564)
    mimas: new SphereEntity(m.mimas, names.mimas, 'satellite', CelestialSurface.solid([0.5631, 0.5382, 0.4903])),
    // エンケラドゥス A_B=0.81(公表ボンド 0.81(幾何は 1.375))
    enceladus: new SphereEntity(m.enceladus, names.enceladus, 'satellite', CelestialSurface.solid([0.8249, 0.8089, 0.7774])),
    // テティス A_B=0.69(幾何 1.229 x q=0.564)
    tethys: new SphereEntity(m.tethys, names.tethys, 'satellite', CelestialSurface.solid([0.7185, 0.6877, 0.6284])),
    // ディオネ A_B=0.56(幾何 0.998 x q=0.564)
    dione: new SphereEntity(m.dione, names.dione, 'satellite', CelestialSurface.solid([0.5844, 0.5580, 0.5074])),
    // レア A_B=0.54(幾何 0.949 x q=0.564)
    rhea: new SphereEntity(m.rhea, names.rhea, 'satellite', CelestialSurface.solid([0.5622, 0.5382, 0.4920])),
    titan: new SphereEntity(
      m.titan, names.titan, 'satellite',
      // 平均輝度 0.2425(A_B は幾何 0.22 x q=0.564)
      CelestialSurface.textured({ url: titanTextureUrl, albedoScale: 0.5113, bondAlbedo: 0.124, averageHue: [1, 1, 1] }),
    ),
    // ヒペリオン A_B=0.14(幾何 0.30 x q=0.461)
    hyperion: new SphereEntity(m.hyperion, names.hyperion, 'satellite', CelestialSurface.solid([0.1617, 0.1375, 0.1009])),
    // イアペトゥス A_B=0.12(幾何は明暗半球で 0.05-0.5。全球平均 0.27 x q=0.461)
    iapetus: new SphereEntity(m.iapetus, names.iapetus, 'satellite', CelestialSurface.solid([0.1296, 0.1189, 0.1023])),
    // フェーベ A_B=0.024(幾何 0.06 x q=0.393)
    phoebe: new SphereEntity(m.phoebe, names.phoebe, 'satellite', CelestialSurface.solid([0.0276, 0.0234, 0.0196])),
  };
}
