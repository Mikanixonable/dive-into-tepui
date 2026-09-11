// 地表地形Workerの要求識別、キャンセル、異常終了を管理する。
import { decodeEarthTerrainBytes, EarthSurfaceDecodeError } from './earth-surface-decode';
import type { EarthTileKey } from './earth-surface-tiles';

interface PendingTerrain {
  readonly resolve: (terrain: Uint8Array) => void;
  readonly reject: (error: unknown) => void;
  readonly signal?: AbortSignal;
  readonly abort: () => void;
}

interface TerrainWorkerReply {
  readonly id: number;
  readonly terrain?: ArrayBuffer;
  readonly error?: string;
}

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, PendingTerrain>();

// Worker停止時に未完了の要求をすべて失敗させ、次回の要求で再生成できる状態へ戻す。
function rejectAll(error: Error): void {
  for (const request of pending.values()) {
    request.signal?.removeEventListener('abort', request.abort);
    request.reject(error);
  }
  pending.clear();
  worker?.terminate();
  worker = null;
}

// 地形デコード専用Workerを初回要求時に生成し、その後の要求で共有する。
function terrainWorker(): Worker {
  if (worker !== null) return worker;
  worker = new Worker(new URL('earth-surface-terrain-worker.js', document.baseURI), { type: 'module' });
  // Abort済みの識別子から遅着しても、残っている別要求には触れない。
  worker.onmessage = (event: MessageEvent<TerrainWorkerReply>) => {
    const reply = event.data;
    const request = pending.get(reply.id);
    if (request === undefined) return;
    pending.delete(reply.id);
    request.signal?.removeEventListener('abort', request.abort);
    if (reply.terrain !== undefined) request.resolve(new Uint8Array(reply.terrain));
    else request.reject(new EarthSurfaceDecodeError(reply.error ?? 'Earth terrain worker failed'));
  };
  worker.onerror = () => rejectAll(new EarthSurfaceDecodeError('Earth terrain worker crashed'));
  return worker;
}

// Workerが利用可能ならbufferを移譲し、それ以外の環境では同じ契約を現在のスレッドで実行する。
export function decodeEarthTerrainOffThread(
  compressed: Uint8Array, key: EarthTileKey, limit: number, expectedSha256?: string,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (typeof Worker === 'undefined') {
    return decodeEarthTerrainBytes(compressed, key, limit, expectedSha256, signal);
  }
  if (signal?.aborted) return Promise.reject(new DOMException('Earth surface request was aborted', 'AbortError'));
  const id = nextId++;
  return new Promise<Uint8Array>((resolve, reject) => {
    // Abort済み要求をpendingから外し、遅着する応答を破棄する。
    const abort = (): void => {
      const request = pending.get(id);
      if (request === undefined) return;
      pending.delete(id);
      reject(new DOMException('Earth surface request was aborted', 'AbortError'));
    };
    pending.set(id, { resolve, reject, signal, abort });
    signal?.addEventListener('abort', abort, { once: true });
    // postMessage後に所有権を失うため、部分viewだけは独立bufferへ移す。
    const bytes = compressed.byteOffset === 0 && compressed.byteLength === compressed.buffer.byteLength
      ? compressed : compressed.slice();
    try {
      terrainWorker().postMessage({
        id, compressed: bytes.buffer, z: key.z, x: key.x, y: key.y, limit, expectedSha256,
      }, [bytes.buffer]);
    } catch (error) {
      pending.delete(id);
      signal?.removeEventListener('abort', abort);
      reject(error);
    }
  });
}
