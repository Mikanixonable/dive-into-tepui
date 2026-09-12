// 配信物が未設定の開発環境で使う地球表面の表示・入力初期値。
import earthTextureUrl from '../assets/earth.jpg';
import type { CelestialTexture } from './celestial-textures';
import type { EarthSurfaceSource } from './earth-surface-source';

export const EARTH_TEXTURE: CelestialTexture = {
  url: earthTextureUrl,
  albedoScale: 0.9102,
  bondAlbedo: 0.306,
  averageHue: [0.9703, 0.9940, 1.1471],
};

export const EARTH_SURFACE_FIXTURE_SOURCE = {
  datasetId: 'earth-development-fixture',
  sourceManifestSha256: '0'.repeat(64),
  climateEncoding: {
    temperatureK: { min: 180, max: 330 },
    cloudFraction: { min: 0, max: 1 },
    orthometricElevation: { min: -1000, max: 9000 },
    landFraction: { min: 0, max: 1 },
    waterOrthometricElevationM: 0,
  },
  baseUrl: 'https://example.test/earth-surface/',
  manifestUrl: 'https://example.test/earth-surface/earth-surface.json',
  colorTileTemplate: 'https://example.test/earth-surface/tiles/{z}/{x}/{y}.jpg',
  terrainTileTemplate: 'https://example.test/earth-surface/tiles/{z}/{x}/{y}.bin.gz',
  baseColorUrl: 'https://example.test/earth-surface/base-color.jpg',
  baseTerrainUrl: 'https://example.test/earth-surface/base-terrain.bin.gz',
  climateMapUrls: Array.from(
    { length: 12 }, (_, month) => `https://example.test/earth-surface/climate-${month + 1}.png`,
  ),
} satisfies EarthSurfaceSource;
