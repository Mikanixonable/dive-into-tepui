// 地表タイルの通信本文を検証し、色と地形を別々にデコードする。
// ここでは取得順を表示順とみなさず、呼び出し側が世代番号を確認できる結果を返す。
import type { EarthTileKey } from './earth-surface-tiles';

export const EARTH_TERRAIN_HEADER_BYTES = 32;
export const EARTH_TERRAIN_WIDTH = 260;
export const EARTH_TERRAIN_HEIGHT = 260;
export const EARTH_TERRAIN_CHANNELS = 4;
const FLOAT16_SCALAR = 1;
export const EARTH_TERRAIN_BYTES = EARTH_TERRAIN_WIDTH * EARTH_TERRAIN_HEIGHT * EARTH_TERRAIN_CHANNELS * 2;

export class EarthSurfaceDecodeError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'EarthSurfaceDecodeError';
  }
}

export interface EarthSurfaceTileRequest {
  readonly key: EarthTileKey;
  readonly colorUrl: string;
  readonly terrainUrl: string;
  readonly generation: number;
  readonly signal?: AbortSignal;
  readonly expectedTerrainSha256?: string;
  readonly maxColorBytes?: number;
  readonly maxTerrainBytes?: number;
  readonly fetchImpl?: typeof fetch;
  readonly decodeImage?: (bytes: Uint8Array, signal?: AbortSignal) => Promise<unknown>;
}

export interface EarthSurfaceTilePayload {
  readonly key: EarthTileKey;
  readonly generation: number;
  readonly color: unknown;
  // ESTNの本文を、GPUアップロード側が解釈できるlittle-endian binary16のまま渡す。
  readonly terrain: Uint16Array;
}

const DEFAULT_COLOR_LIMIT = 16 * 1024 * 1024;
const DEFAULT_TERRAIN_LIMIT = EARTH_SURFACE_DECODE_BYTES();

function EARTH_SURFACE_DECODE_BYTES(): number {
  return EARTH_TERRAIN_HEADER_BYTES + EARTH_TERRAIN_BYTES;
}

function ensureNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Earth surface request was aborted', 'AbortError');
}

async function readResponse(response: Response, limit: number, signal?: AbortSignal): Promise<Uint8Array> {
  if (!response.ok) throw new EarthSurfaceDecodeError(`Earth surface HTTP ${response.status}`);
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new RangeError('Invalid Earth surface byte limit');
  ensureNotAborted(signal);
  const declared = response.headers.get('content-length');
  if (declared !== null && Number(declared) > limit) throw new EarthSurfaceDecodeError('Earth surface response is too large');
  if (response.body === null) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > limit) throw new EarthSurfaceDecodeError('Earth surface response is too large');
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      ensureNotAborted(signal);
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > limit) throw new EarthSurfaceDecodeError('Earth surface response is too large');
      chunks.push(next.value);
    }
  } catch (error) {
    // 上限超過・AbortSignal・通信失敗で途中のHTTP bodyを放置すると、次のタイル要求と
    // 帯域や接続を競合し続ける。cancel完了を待ってから元のエラーを返す。
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  if (globalThis.crypto?.subtle === undefined) throw new EarthSurfaceDecodeError('Web Crypto is required for tile verification');
  // copyでSharedArrayBuffer由来の型差を避け、digestに渡す範囲を厳密にする。
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes.slice());
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function assertKey(key: EarthTileKey, z: number, x: number, y: number): void {
  if (key.z !== z || key.x !== x || key.y !== y) throw new EarthSurfaceDecodeError('Terrain tile key does not match its header');
}

function readAscii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.slice(start, end));
}

// 32bytesのESTNヘッダーを検査し、本文のbinary16配列を切り出す。
export function decodeEarthTerrainPayload(payload: Uint8Array, key: EarthTileKey): Uint16Array {
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
  if (version !== 1 || headerBytes !== EARTH_TERRAIN_HEADER_BYTES || width !== EARTH_TERRAIN_WIDTH
    || height !== EARTH_TERRAIN_HEIGHT || channels !== EARTH_TERRAIN_CHANNELS || scalar !== FLOAT16_SCALAR
    || reserved !== 0 || reserved2 !== 0 || dataBytes !== EARTH_TERRAIN_BYTES) {
    throw new EarthSurfaceDecodeError('Invalid ESTN header');
  }
  assertKey(key, z, x, y);
  return new Uint16Array(payload.buffer.slice(payload.byteOffset + EARTH_TERRAIN_HEADER_BYTES,
    payload.byteOffset + payload.byteLength));
}

async function defaultDecodeImage(bytes: Uint8Array, signal?: AbortSignal): Promise<unknown> {
  ensureNotAborted(signal);
  if (typeof createImageBitmap !== 'function') throw new EarthSurfaceDecodeError('ImageBitmap decoding is unavailable');
  const imageBytes = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(imageBytes).set(bytes);
  const image = await createImageBitmap(new Blob([imageBytes], { type: 'image/jpeg' }));
  ensureNotAborted(signal);
  return image;
}

async function inflateTerrain(bytes: Uint8Array, limit: number, signal?: AbortSignal): Promise<Uint8Array> {
  if (typeof DecompressionStream !== 'function') throw new EarthSurfaceDecodeError('gzip decompression is unavailable');
  const compressed = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(compressed).set(bytes);
  const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'));
  return readResponse(new Response(stream), limit, signal);
}

// 色JPEGとgzip地形を同じ世代・AbortSignalで取得する。片方だけの成功は結果へ公開しない。
export async function decodeEarthSurfaceTile(request: EarthSurfaceTileRequest): Promise<EarthSurfaceTilePayload> {
  if (!Number.isInteger(request.generation) || request.generation < 0) throw new RangeError('Invalid Earth tile generation');
  const fetchImpl = request.fetchImpl ?? fetch;
  const colorLimit = request.maxColorBytes ?? DEFAULT_COLOR_LIMIT;
  const terrainLimit = request.maxTerrainBytes ?? DEFAULT_TERRAIN_LIMIT;
  ensureNotAborted(request.signal);
  const [colorResponse, terrainResponse] = await Promise.all([
    fetchImpl(request.colorUrl, { signal: request.signal }),
    fetchImpl(request.terrainUrl, { signal: request.signal }),
  ]);
  const colorBytes = await readResponse(colorResponse, colorLimit, request.signal);
  const compressedTerrain = await readResponse(terrainResponse, terrainLimit, request.signal);
  const terrainBytes = await inflateTerrain(compressedTerrain, terrainLimit, request.signal);
  const terrainHash = await sha256(terrainBytes);
  if (request.expectedTerrainSha256 !== undefined && terrainHash !== request.expectedTerrainSha256) {
    throw new EarthSurfaceDecodeError('ESTN payload hash mismatch');
  }
  const terrain = decodeEarthTerrainPayload(terrainBytes, request.key);
  const color = await (request.decodeImage ?? defaultDecodeImage)(colorBytes, request.signal);
  ensureNotAborted(request.signal);
  return { key: request.key, generation: request.generation, color, terrain };
}
