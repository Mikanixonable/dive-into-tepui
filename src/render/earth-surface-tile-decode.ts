// 色JPEGとgzip地形を同じ世代・AbortSignalで取得し、GPU投入可能なペイロードへ束ねる。
import type { EarthTileKey } from './earth-surface-tile-key';
import { EarthSurfaceDecodeError } from './earth-surface-decode-errors';
import { ensureEarthSurfaceNotAborted, earthSurfaceSha256, readEarthSurfaceResponse } from './earth-surface-decode-response';
import { decodeEarthTerrainBytes } from './earth-surface-terrain-codec';
import { EARTH_TERRAIN_BYTES, EARTH_TERRAIN_HEADER_BYTES } from './earth-surface-format';

export interface EarthSurfaceTileRequest {
  readonly key: EarthTileKey;
  readonly colorUrl: string;
  readonly terrainUrl: string;
  readonly generation: number;
  readonly signal?: AbortSignal;
  readonly expectedTerrainSha256?: string;
  readonly expectedColorSha256?: string;
  readonly expectedColorBytes?: number;
  readonly expectedTerrainEncodedBytes?: number;
  readonly maxColorBytes?: number;
  readonly maxTerrainBytes?: number;
  readonly fetchImpl?: typeof fetch;
  readonly decodeImage?: (bytes: Uint8Array, signal?: AbortSignal) => Promise<unknown>;
  readonly decodeTerrain?: typeof decodeEarthTerrainBytes;
}

export interface EarthSurfaceTilePayload {
  readonly key: EarthTileKey;
  readonly generation: number;
  readonly color: unknown;
  readonly terrain: Uint8Array;
}

const DEFAULT_COLOR_LIMIT = 16 * 1024 * 1024;
const DEFAULT_TERRAIN_LIMIT = EARTH_TERRAIN_HEADER_BYTES + EARTH_TERRAIN_BYTES;

async function defaultDecodeImage(bytes: Uint8Array, signal?: AbortSignal): Promise<unknown> {
  ensureEarthSurfaceNotAborted(signal);
  if (typeof createImageBitmap !== 'function') throw new EarthSurfaceDecodeError('ImageBitmap decoding is unavailable');
  const imageBytes = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(imageBytes).set(bytes);
  const image = await createImageBitmap(new Blob([imageBytes], { type: 'image/jpeg' }));
  try {
    ensureEarthSurfaceNotAborted(signal);
    return image;
  } catch (error) {
    image.close();
    throw error;
  }
}

// RGBA変換を終えたデコード画像を解放する。Uint8Arrayなどのテスト入力はそのまま返す。
export function closeEarthSurfaceImage(image: unknown): void {
  if (image === null || typeof image !== 'object') return;
  const candidate = image as { close?: unknown };
  if (typeof candidate.close === 'function') candidate.close();
}

export async function decodeEarthSurfaceTile(request: EarthSurfaceTileRequest): Promise<EarthSurfaceTilePayload> {
  if (!Number.isInteger(request.generation) || request.generation < 0) throw new RangeError('Invalid Earth tile generation');
  const fetchImpl = request.fetchImpl ?? fetch;
  const colorLimit = request.maxColorBytes ?? DEFAULT_COLOR_LIMIT;
  const terrainLimit = request.maxTerrainBytes ?? DEFAULT_TERRAIN_LIMIT;
  ensureEarthSurfaceNotAborted(request.signal);
  const [colorResponse, terrainResponse] = await Promise.all([
    fetchImpl(request.colorUrl, { signal: request.signal }), fetchImpl(request.terrainUrl, { signal: request.signal }),
  ]);
  const colorBytes = await readEarthSurfaceResponse(colorResponse, colorLimit, request.signal);
  const compressedTerrain = await readEarthSurfaceResponse(terrainResponse, terrainLimit, request.signal);
  if (request.expectedColorBytes !== undefined && colorBytes.byteLength !== request.expectedColorBytes) {
    throw new EarthSurfaceDecodeError('Earth surface color byte length mismatch');
  }
  if (request.expectedTerrainEncodedBytes !== undefined && compressedTerrain.byteLength !== request.expectedTerrainEncodedBytes) {
    throw new EarthSurfaceDecodeError('Earth surface terrain encoded byte length mismatch');
  }
  if (request.expectedColorSha256 !== undefined && await earthSurfaceSha256(colorBytes) !== request.expectedColorSha256) {
    throw new EarthSurfaceDecodeError('Earth surface color hash mismatch');
  }
  const terrain = await (request.decodeTerrain ?? decodeEarthTerrainBytes)(
    compressedTerrain, request.key, terrainLimit, request.expectedTerrainSha256, request.signal,
  );
  const color = await (request.decodeImage ?? defaultDecodeImage)(colorBytes, request.signal);
  try {
    ensureEarthSurfaceNotAborted(request.signal);
    return { key: request.key, generation: request.generation, color, terrain };
  } catch (error) {
    closeEarthSurfaceImage(color);
    throw error;
  }
}
