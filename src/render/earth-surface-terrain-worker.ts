// 地表地形のgzip展開、hash検証、形式検証を描画スレッド外で行う。
import { decodeEarthTerrainBytesForFormat } from './earth-surface-terrain-codec';
import { EARTH_TERRAIN_LAYOUT, type EarthSurfaceTerrainFormat } from './earth-surface-format';
import { earthTileKey } from './earth-surface-tile-key';

interface TerrainWorkerRequest {
  readonly id: number;
  readonly compressed: ArrayBuffer;
  readonly z: number;
  readonly x: number;
  readonly y: number;
  readonly limit: number;
  readonly expectedSha256?: string;
  readonly format?: EarthSurfaceTerrainFormat;
}

interface TerrainWorkerScope {
  onmessage: ((event: MessageEvent<TerrainWorkerRequest>) => void) | null;
  postMessage(message: unknown, transfer: Transferable[]): void;
}

const scope = globalThis as unknown as TerrainWorkerScope;

// 要求ごとに独立して復号し、結果 buffer を転送可能オブジェクトとしてメインスレッドへ返送する。
scope.onmessage = (event) => {
  const request = event.data;
  void decodeEarthTerrainBytesForFormat(
    new Uint8Array(request.compressed), earthTileKey(request.z, request.x, request.y),
    request.limit, request.expectedSha256, undefined, request.format ?? EARTH_TERRAIN_LAYOUT,
  ).then((terrain) => {
    scope.postMessage({ id: request.id, terrain: terrain.buffer }, [terrain.buffer]);
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    scope.postMessage({ id: request.id, error: message }, []);
  });
};
