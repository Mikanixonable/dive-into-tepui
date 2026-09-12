// ESTN/ESTBのバイナリ本文を検証し、GPU向けRGBA8へ変換する。
import { earthTileKey, EARTH_TILE_GUTTER, type EarthTileKey } from './earth-surface-tile-key';
import {
  EARTH_TERRAIN_BYTES, EARTH_TERRAIN_CHANNELS, EARTH_SURFACE_TERRAIN_FORMAT_VERSION,
  EARTH_TERRAIN_HEADER_BYTES, EARTH_TERRAIN_HEIGHT, EARTH_TERRAIN_SCALAR_UINT8, EARTH_TERRAIN_WIDTH,
} from './earth-surface-format';
import { EarthSurfaceDecodeError } from './earth-surface-decode-errors';
import { earthSurfaceSha256, readEarthSurfaceResponse } from './earth-surface-decode-response';

export const EARTH_BASE_TERRAIN_WIDTH = EARTH_TERRAIN_WIDTH * 2 - 4 * EARTH_TILE_GUTTER;
export const EARTH_BASE_TERRAIN_HEIGHT = EARTH_TERRAIN_HEIGHT - 2 * EARTH_TILE_GUTTER;
const EARTH_BASE_TERRAIN_TILE_COUNT = 2;
const EARTH_BASE_TERRAIN_DATA_BYTES = EARTH_BASE_TERRAIN_TILE_COUNT * (EARTH_TERRAIN_HEADER_BYTES + EARTH_TERRAIN_BYTES);
const EARTH_BASE_TERRAIN_PAYLOAD_BYTES = EARTH_TERRAIN_HEADER_BYTES + EARTH_BASE_TERRAIN_DATA_BYTES;

// バイナリヘッダーが要求されたタイルの本文かを検査する。
function assertKey(key: EarthTileKey, z: number, x: number, y: number): void {
  if (key.z !== z || key.x !== x || key.y !== y) throw new EarthSurfaceDecodeError('Terrain tile key does not match its header');
}

// 固定長ヘッダーのmagicをASCIIとして読む。
function readAscii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.slice(start, end));
}

// 32bytesのESTNヘッダーを検査し、本文のRGBA8配列を切り出す。
export function decodeEarthTerrainPayload(payload: Uint8Array, key: EarthTileKey): Uint8Array {
  // 長さ・固定値・タイルキーを順に確認してから本文を返す。
  if (payload.byteLength !== EARTH_TERRAIN_HEADER_BYTES + EARTH_TERRAIN_BYTES) {
    throw new EarthSurfaceDecodeError('Invalid ESTN payload length');
  }
  if (readAscii(payload, 0, 4) !== 'ESTN') throw new EarthSurfaceDecodeError('Invalid ESTN magic');
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const version = view.getUint16(4, true);
  const headerBytes = view.getUint16(6, true);
  const width = view.getUint16(8, true);
  const height = view.getUint16(10, true);
  const z = view.getUint8(12);
  const reserved = view.getUint8(13);
  const x = view.getUint32(14, true);
  const y = view.getUint32(18, true);
  const channels = view.getUint8(22);
  const scalar = view.getUint8(23);
  const dataBytes = view.getUint32(24, true);
  const reserved2 = view.getUint32(28, true);
  if (version !== EARTH_SURFACE_TERRAIN_FORMAT_VERSION || headerBytes !== EARTH_TERRAIN_HEADER_BYTES
    || width !== EARTH_TERRAIN_WIDTH || height !== EARTH_TERRAIN_HEIGHT || channels !== EARTH_TERRAIN_CHANNELS
    || scalar !== EARTH_TERRAIN_SCALAR_UINT8 || reserved !== 0 || reserved2 !== 0 || dataBytes !== EARTH_TERRAIN_BYTES) {
    throw new EarthSurfaceDecodeError('Invalid ESTN header');
  }
  assertKey(key, z, x, y);
  return payload.slice(EARTH_TERRAIN_HEADER_BYTES);
}

// 2枚のz=0 ESTNをまとめたESTBを、経度方向へ連結したbase用RGBA8へ展開する。
export function decodeEarthBaseTerrainPayload(payload: Uint8Array): Uint8Array {
  // ESTB内の2枚を検証し、gutterを除いた経度方向の連結配列へ変換する。
  if (payload.byteLength !== EARTH_BASE_TERRAIN_PAYLOAD_BYTES) throw new EarthSurfaceDecodeError('Invalid ESTB payload length');
  if (readAscii(payload, 0, 4) !== 'ESTB') throw new EarthSurfaceDecodeError('Invalid ESTB magic');
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const version = view.getUint16(4, true);
  const headerBytes = view.getUint16(6, true);
  const width = view.getUint16(8, true);
  const height = view.getUint16(10, true);
  const z = view.getUint8(12);
  const reserved = view.getUint8(13);
  const columns = view.getUint32(14, true);
  const rows = view.getUint32(18, true);
  const channels = view.getUint8(22);
  const scalar = view.getUint8(23);
  const dataBytes = view.getUint32(24, true);
  const reserved2 = view.getUint32(28, true);
  if (version !== EARTH_SURFACE_TERRAIN_FORMAT_VERSION || headerBytes !== EARTH_TERRAIN_HEADER_BYTES
    || width !== EARTH_TERRAIN_WIDTH || height !== EARTH_TERRAIN_HEIGHT || z !== 0 || reserved !== 0
    || columns !== EARTH_BASE_TERRAIN_TILE_COUNT || rows !== 1 || channels !== EARTH_TERRAIN_CHANNELS
    || scalar !== EARTH_TERRAIN_SCALAR_UINT8 || dataBytes !== EARTH_BASE_TERRAIN_DATA_BYTES || reserved2 !== 0) {
    throw new EarthSurfaceDecodeError('Invalid ESTB header');
  }
  const output = new Uint8Array(EARTH_BASE_TERRAIN_WIDTH * EARTH_BASE_TERRAIN_HEIGHT * EARTH_TERRAIN_CHANNELS);
  const tilePayloadBytes = EARTH_TERRAIN_HEADER_BYTES + EARTH_TERRAIN_BYTES;
  const tileWidth = EARTH_TERRAIN_WIDTH - 2 * EARTH_TILE_GUTTER;
  const tileHeight = EARTH_TERRAIN_HEIGHT - 2 * EARTH_TILE_GUTTER;
  for (let tileX = 0; tileX < EARTH_BASE_TERRAIN_TILE_COUNT; tileX++) {
    const tile = decodeEarthTerrainPayload(
      payload.subarray(EARTH_TERRAIN_HEADER_BYTES + tileX * tilePayloadBytes, tilePayloadBytes
        + EARTH_TERRAIN_HEADER_BYTES + tileX * tilePayloadBytes), earthTileKey(0, tileX, 0),
    );
    for (let y = 0; y < tileHeight; y++) {
      const sourceStart = ((y + EARTH_TILE_GUTTER) * EARTH_TERRAIN_WIDTH + EARTH_TILE_GUTTER) * EARTH_TERRAIN_CHANNELS;
      const targetStart = (y * EARTH_BASE_TERRAIN_WIDTH + tileX * tileWidth) * EARTH_TERRAIN_CHANNELS;
      output.set(tile.subarray(sourceStart, sourceStart + tileWidth * EARTH_TERRAIN_CHANNELS), targetStart);
    }
  }
  return output;
}

// gzip本文を上限付きで展開し、応答読込と同じ中断規約を適用する。
async function inflateTerrain(bytes: Uint8Array, limit: number, signal?: AbortSignal): Promise<Uint8Array> {
  // DecompressionStreamへ渡す前に独立したArrayBufferへコピーする。
  if (typeof DecompressionStream !== 'function') throw new EarthSurfaceDecodeError('gzip decompression is unavailable');
  const compressed = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(compressed).set(bytes);
  const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'));
  return readEarthSurfaceResponse(new Response(stream), limit, signal);
}

// gzip展開後のハッシュとESTNヘッダーを確認して本文を返す。
export async function decodeEarthTerrainBytes(
  compressed: Uint8Array, key: EarthTileKey, limit: number, expectedSha256?: string, signal?: AbortSignal,
): Promise<Uint8Array> {
  // gzip展開後にハッシュとヘッダーを検証し、GPU向け本文だけを返す。
  const terrainBytes = await inflateTerrain(compressed, limit, signal);
  const terrainHash = await earthSurfaceSha256(terrainBytes);
  if (expectedSha256 !== undefined && terrainHash !== expectedSha256) throw new EarthSurfaceDecodeError('ESTN payload hash mismatch');
  return decodeEarthTerrainPayload(terrainBytes, key);
}

// base terrainを取得し、上限を守りながらESTBとして展開する。
export async function loadEarthBaseTerrain(url: string, fetchImpl: typeof fetch = fetch, signal?: AbortSignal): Promise<Uint8Array> {
  // fetch応答を上限付きで読み、展開後のbase本文を返す。
  const response = await fetchImpl(url, { signal });
  const compressed = await readEarthSurfaceResponse(response, EARTH_BASE_TERRAIN_PAYLOAD_BYTES, signal);
  const payload = await inflateTerrain(compressed, EARTH_BASE_TERRAIN_PAYLOAD_BYTES, signal);
  return decodeEarthBaseTerrainPayload(payload);
}
