// HTTP本文の上限・中断・ハッシュ検証を共通化する。
import { EarthSurfaceDecodeError } from './earth-surface-decode-errors';
import { EarthSurfaceHttpError } from './earth-surface-request-errors';

// 中断済みの信号を検出して、共通のAbortErrorへ変換する。
export function ensureEarthSurfaceNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Earth surface request was aborted', 'AbortError');
}

// HTTP本文を上限付きで読み、途中のキャンセルも検査する。
export async function readEarthSurfaceResponse(
  response: Response, limit: number, signal?: AbortSignal,
): Promise<Uint8Array> {
  // HTTP応答を上限まで読み、本文の取得中も中断を検査する。
  if (!response.ok) throw new EarthSurfaceHttpError(response.status);
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new RangeError('Invalid Earth surface byte limit');
  ensureEarthSurfaceNotAborted(signal);
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
      ensureEarthSurfaceNotAborted(signal);
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > limit) throw new EarthSurfaceDecodeError('Earth surface response is too large');
      chunks.push(next.value);
    }
  } catch (error) {
    // 上限超過・AbortSignal・通信失敗で途中のHTTP bodyを放置しない。
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

// 地表配信物のハッシュ検証に使うSHA-256を16進文字列で返す。
export async function earthSurfaceSha256(bytes: Uint8Array): Promise<string> {
  if (globalThis.crypto?.subtle === undefined) throw new EarthSurfaceDecodeError('Web Crypto is required for tile verification');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes.slice());
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}
