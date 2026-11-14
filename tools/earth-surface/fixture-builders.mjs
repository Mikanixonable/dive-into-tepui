// 契約検査を通る最小の地表fixture実体を組み立てる共有builder。
import {
  EARTH_BASE_COLOR_COMPONENTS,
  EARTH_BASE_COLOR_HEIGHT,
  EARTH_BASE_COLOR_WIDTH,
  EARTH_TILE_MAX_Z,
  EARTH_TILE_MIN_Z,
  EARTH_TERRAIN_BYTES,
  EARTH_TERRAIN_CHANNELS,
  EARTH_TERRAIN_FORMAT_VERSION,
  EARTH_TERRAIN_LAYOUT,
  EARTH_TERRAIN_PAYLOAD_BYTES,
  EARTH_TERRAIN_SCALAR_UINT8,
} from './contract.mjs';

// 寸法検査を通る最小JPEGをfixtureへ組み立てる。
export function jpegFixture({ width = EARTH_BASE_COLOR_WIDTH, height = EARTH_BASE_COLOR_HEIGHT,
  components = EARTH_BASE_COLOR_COMPONENTS } = {}) {
  const segment = (marker, payload) => Buffer.concat([
    Buffer.from([0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]), payload,
  ]);
  const sof = Buffer.alloc(6 + components * 3);
  sof[0] = 8; sof.writeUInt16BE(height, 1); sof.writeUInt16BE(width, 3); sof[5] = components;
  for (let index = 0; index < components; index += 1) {
    const offset = 6 + index * 3;
    sof[offset] = index + 1; sof[offset + 1] = 0x11; sof[offset + 2] = 0;
  }
  const sos = Buffer.alloc(4 + components * 2);
  sos[0] = components;
  for (let index = 0; index < components; index += 1) {
    const offset = 1 + index * 2;
    sos[offset] = index + 1; sos[offset + 1] = 0;
  }
  sos[1 + components * 2] = 0; sos[2 + components * 2] = 63; sos[3 + components * 2] = 0;
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    segment(0xe0, Buffer.alloc(14)),
    segment(0xc0, sof),
    segment(0xda, sos),
    Buffer.from([0x00, 0xff, 0xd9]),
  ]);
}

// 検査を通る最小のESTN地形payloadを組み立てる。
export function terrainPayload({ z = 0, x = 0, y = 0 } = {}) {
  const payload = Buffer.alloc(EARTH_TERRAIN_PAYLOAD_BYTES);
  payload.write('ESTN', 0, 'ascii');
  payload.writeUInt16LE(EARTH_TERRAIN_FORMAT_VERSION, 4); payload.writeUInt16LE(32, 6);
  payload.writeUInt16LE(260, 8); payload.writeUInt16LE(260, 10);
  payload.writeUInt8(z, 12); payload.writeUInt8(0, 13);
  payload.writeUInt32LE(x, 14); payload.writeUInt32LE(y, 18);
  payload.writeUInt8(EARTH_TERRAIN_CHANNELS, 22); payload.writeUInt8(EARTH_TERRAIN_SCALAR_UINT8, 23);
  payload.writeUInt32LE(EARTH_TERRAIN_BYTES, 24); payload.writeUInt32LE(0, 28);
  return payload;
}

// z=0の2枚のESTNを束ねたESTB payloadを組み立てる。
export function baseTerrainPayload() {
  const body = Buffer.concat([terrainPayload({ x: 0 }), terrainPayload({ x: 1 })]);
  const payload = Buffer.alloc(32 + body.length);
  payload.write('ESTB', 0, 'ascii');
  payload.writeUInt16LE(EARTH_TERRAIN_FORMAT_VERSION, 4); payload.writeUInt16LE(32, 6);
  payload.writeUInt16LE(260, 8); payload.writeUInt16LE(260, 10);
  payload.writeUInt8(0, 12); payload.writeUInt8(0, 13);
  payload.writeUInt32LE(2, 14); payload.writeUInt32LE(1, 18);
  payload.writeUInt8(EARTH_TERRAIN_CHANNELS, 22); payload.writeUInt8(EARTH_TERRAIN_SCALAR_UINT8, 23);
  payload.writeUInt32LE(body.length, 24); payload.writeUInt32LE(0, 28);
  body.copy(payload, 32);
  return payload;
}

// fixture bundleが参照するsources索引manifest（ソース契約schema 1）を返す。
export function fixtureSourceManifest(datasetId = 'earth-pages-fixture') {
  return { schemaVersion: 1, datasetId, sources: [{ id: 'fixture', inputSha256: [] }] };
}

// 実行時schema 3のfixture earth-surface manifestを返す。
export function fixtureManifest({ sourceManifestSha256, datasetId = 'earth-pages-fixture',
  generator = 'pages-fixture/1', attribution = ['deterministic fixture'] } = {}) {
  return {
    schemaVersion: 3, datasetId, sourceManifestSha256, sourceManifest: 'sources.json',
    colorCalibration: {
      inputEncoding: 'sRGB8', aggregation: 'linear_rgb_area_mean', outputEncoding: 'sRGB8',
      diffuseAlbedoScale: 1, meanLinearRgb: [0.1, 0.1, 0.1], meanRec709Albedo: 0.1,
      bondAlbedo: 0.294, averageHue: [1, 1, 1],
    },
    provenance: { generator },
    terrainEncoding: { formatVersion: EARTH_TERRAIN_FORMAT_VERSION, layout: EARTH_TERRAIN_LAYOUT,
      width: 260, height: 260, channels: EARTH_TERRAIN_CHANNELS, scalar: 'UInt8', normalFrame: 'body_fixed' },
    climateMap: { width: 1024, height: 512, channels: 4, scalar: 'UInt8' },
    controlRegions: Array.from({ length: 16 }, (_, index) => ({ id: `region-${index}`, west: -180, south: -80, east: 180, north: 80 })),
    coverage: { kind: 'sparse', minZoom: EARTH_TILE_MIN_Z, maxZoom: EARTH_TILE_MAX_Z, expectedTiles: null },
    baseColor: 'base/earth.jpg', baseTerrain: 'base/earth.bin.gz',
    tileTemplates: { color: 'tiles/{z}/{x}/{y}.jpg', terrain: 'tiles/{z}/{x}/{y}.bin.gz' },
    climateMaps: Array.from({ length: 12 }, (_, index) => `climate/${String(index + 1).padStart(2, '0')}.png`),
    climateEncoding: {
      temperatureK: { min: 180, max: 330 }, cloudFraction: { min: 0, max: 1 },
      orthometricElevation: { min: -1000, max: 9000 }, landFraction: { min: 0, max: 1 },
      waterOrthometricElevationM: 0,
    },
    attribution,
  };
}
