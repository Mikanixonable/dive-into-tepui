// 実写テクスチャを持つ天体のテクスチャと、そのアルベド倍率。
//
// **実写テクスチャの明るさはそのままではアルベドではない。** 撮影・処理の過程で任意に
// スケールされているので、テクスチャの平均をその天体のボンドアルベドへ合わせる倍率を1つ持つ。
// 倍率は「テクスチャの緯度重み付き線形平均の Rec.709 輝度」と「公表アルベド」の比で、
// 2026-08-24 に各 JPEG をキャンバスへ読んで一度だけ測った(正距円筒図法なので行ごとの重みは
// cos(緯度))。テクスチャを差し替えたら測り直す。
//
// アルベドの取り方(ボンドアルベド、幾何アルベドからの位相積分)は celestial-albedo.ts と
// 同じ規約に従う。惑星は NASA Planetary Fact Sheet のボンドアルベドをそのまま使える。
import climateTextureUrl from '../assets/earth-climate.png';
import mercuryTextureUrl from '../assets/2k_mercury.jpg';
import venusTextureUrl from '../assets/2k_venus_atmosphere.jpg';
import marsTextureUrl from '../assets/2k_mars.jpg';
import jupiterTextureUrl from '../assets/2k_jupiter.jpg';
import saturnTextureUrl from '../assets/2k_saturn.jpg';
import uranusTextureUrl from '../assets/2k_uranus.jpg';
import neptuneTextureUrl from '../assets/2k_neptune.jpg';
import phobosTextureUrl from '../assets/2k_phobos.jpg';
import ioTextureUrl from '../assets/2k_io.jpg';
import europaTextureUrl from '../assets/2k_europa.jpg';
import ganymedeTextureUrl from '../assets/2k_ganymede.jpg';
import callistoTextureUrl from '../assets/2k_callisto.jpg';
import titanTextureUrl from '../assets/2k_titan.jpg';
import earthTextureUrl from '../assets/earth.jpg';
import cloudsTextureUrl from '../assets/8k_clouds.jpg';
import moonTextureUrl from '../assets/8k_moon.jpg';

// 1天体ぶんのテクスチャと、その明るさをアルベドへ合わせる倍率、そして合わせ先のボンド
// アルベド(倍率の導出元であり、輝点の明るさを引くのにも要る)。averageHue は緯度重み付き
// 平均色の色み(Rec.709 輝度 1 へ正規化した線形 RGB)で、天体を光源にするときの色。
// 倍率と同じ測り方で 2026-08-27 に一度だけ測った。
export type CelestialTexture = {
  readonly url: string;
  readonly albedoScale: number;
  readonly bondAlbedo: number;
  readonly averageHue: readonly [number, number, number];
};

const CELESTIAL_TEXTURES: Readonly<Record<string, CelestialTexture>> = {
  // 惑星(倍率 = 公表ボンドアルベド / 実測平均輝度)
  mercury: { url: mercuryTextureUrl, albedoScale: 0.3815, bondAlbedo: 0.088, averageHue: [1.0088, 0.9974, 0.9997] }, // 平均輝度 0.2306(A_B は公表ボンド)
  venus: { url: venusTextureUrl, albedoScale: 1.3666, bondAlbedo: 0.76, averageHue: [1.4227, 0.9352, 0.3977] }, // 平均輝度 0.5561(A_B は公表ボンド)
  mars: { url: marsTextureUrl, albedoScale: 1.3663, bondAlbedo: 0.25, averageHue: [2.6054, 0.5946, 0.2888] }, // 平均輝度 0.1830(A_B は公表ボンド)
  jupiter: { url: jupiterTextureUrl, albedoScale: 1.2222, bondAlbedo: 0.503, averageHue: [1.0987, 0.9845, 0.8629] }, // 平均輝度 0.4116(A_B は公表ボンド)
  saturn: { url: saturnTextureUrl, albedoScale: 0.5552, bondAlbedo: 0.342, averageHue: [1.2028, 0.9763, 0.6378] }, // 平均輝度 0.6160(A_B は公表ボンド)
  uranus: { url: uranusTextureUrl, albedoScale: 0.5320, bondAlbedo: 0.3, averageHue: [0.6079, 1.0981, 1.1831] }, // 平均輝度 0.5640(A_B は公表ボンド)
  neptune: { url: neptuneTextureUrl, albedoScale: 2.3609, bondAlbedo: 0.29, averageHue: [0.3358, 0.9100, 3.8476] }, // 平均輝度 0.1228(A_B は公表ボンド)
  // 衛星
  phobos: { url: phobosTextureUrl, albedoScale: 0.1009, bondAlbedo: 0.028, averageHue: [1, 1, 1] }, // 平均輝度 0.2774(A_B は幾何 0.071 x q=0.393)
  io: { url: ioTextureUrl, albedoScale: 1.3543, bondAlbedo: 0.355, averageHue: [1.3697, 0.9471, 0.4357] }, // 平均輝度 0.2621(A_B は幾何 0.63 x q=0.564)
  europa: { url: europaTextureUrl, albedoScale: 1.2089, bondAlbedo: 0.378, averageHue: [1, 1, 1] }, // 平均輝度 0.3127(A_B は幾何 0.67 x q=0.564)
  ganymede: { url: ganymedeTextureUrl, albedoScale: 1.3675, bondAlbedo: 0.243, averageHue: [1.0763, 0.9959, 0.8162] }, // 平均輝度 0.1777(A_B は幾何 0.43 x q=0.564)
  callisto: { url: callistoTextureUrl, albedoScale: 2.2403, bondAlbedo: 0.11, averageHue: [1, 1, 1] }, // 平均輝度 0.0491(A_B は公表ボンド)
  titan: { url: titanTextureUrl, albedoScale: 0.5113, bondAlbedo: 0.124, averageHue: [1, 1, 1] }, // 平均輝度 0.2425(A_B は幾何 0.22 x q=0.564)
  moon: { url: moonTextureUrl, albedoScale: 0.3459, bondAlbedo: 0.11, averageHue: [1.0458, 0.9880, 0.9844] }, // 平均輝度 0.3180(A_B は公表ボンド)
};

// 地球は地表・雲・雲影を1つのアルベドへ合成する(render/earth.ts)ので、テクスチャ2枚と
// 合成後の倍率を別に持つ。平均輝度 0.3104 は合成後の式で測った値で、A_B=0.306 との比が倍率。
// averageHue も合成後の式で測った色み(Rec.709 輝度 1 の線形 RGB)。
export const EARTH_TEXTURES = {
  surfaceUrl: earthTextureUrl,
  cloudsUrl: cloudsTextureUrl,
  // 気候の事前分布(平均気温・平年の雲量・標高)。tools/export-climate.mjs が焼く。
  climateUrl: climateTextureUrl,
  albedoScale: 0.9858,
  bondAlbedo: 0.306,
  averageHue: [0.9695, 0.9937, 1.1519],
} as const;

// id のテクスチャ。表に無ければ null(単色球として celestial-albedo.ts を引く)。
export function textureOf(id: string): CelestialTexture | null {
  return CELESTIAL_TEXTURES[id] ?? null;
}

// id の実写テクスチャから測った測光値(ボンドアルベドと平均色の色み)。地球も含む。
// 実写テクスチャを持たない天体では null。
export function texturePhotometryOf(id: string): Pick<CelestialTexture, 'bondAlbedo' | 'averageHue'> | null {
  if (id === 'earth') return EARTH_TEXTURES;
  return CELESTIAL_TEXTURES[id] ?? null;
}
