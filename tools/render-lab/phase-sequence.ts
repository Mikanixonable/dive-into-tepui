// 近傍拡散補正の位相の列。フレームごとに動かす走査の入力(seed・走査の代表)に、描画テスト環境だけで試すラスタライズの
// ずれ(カメラの射影を描画バッファの画素の 1 未満ずらす)を添えて、動かす源の組とフレーム番号から 1 パスの位相を作る。
import {
  frameJitterAt, type FrameJitter, type JitterSource,
} from '../../src/render/pipeline/screen-space/frame-jitter';

// 1 パスの位相。rasterJitter はカメラの射影のずれ [描画バッファの画素](null はずらさない)。
export interface CorrectionPhase extends FrameJitter {
  readonly rasterJitter: readonly [number, number] | null;
}

// 本番の静止画の位相。
export const PRODUCTION_PHASE: CorrectionPhase = { seed: [0, 0], scanRotation: 0, scanJitter: null, rasterJitter: null };

// 動かせる源。raster はラスタライズのずれ。
export type PhaseSource = JitterSource | 'raster';

// 位相の列 — 動かす源 sources と、フレーム数 count。
export interface PhaseSequence {
  readonly sources: readonly PhaseSource[];
  readonly count: number;
}

// 列 sequence の k 番目(0 から)の位相。cellSize は走査の画素の幅 [描画バッファの画素]。
export function phaseAt(sequence: PhaseSequence, k: number, cellSize: number): CorrectionPhase {
  const scanSources = sequence.sources.filter((source): source is JitterSource => source !== 'raster');
  const jitter = frameJitterAt(k, scanSources, cellSize);
  return { ...jitter, rasterJitter: sequence.sources.includes('raster') ? rasterJitterAt(k) : null };
}

// 列 sequence の全ての位相。
export function phasesOf(sequence: PhaseSequence, cellSize: number): readonly CorrectionPhase[] {
  return Array.from({ length: sequence.count }, (_, k) => phaseAt(sequence, k, cellSize));
}

// ラスタライズのずれの列 — Halton(2, 3) の k + 1 番目の点を画素の中心まわりの ±½ px へ写したもの。
export function rasterJitterAt(k: number): readonly [number, number] {
  return [halton(k + 1, 2) - 0.5, halton(k + 1, 3) - 0.5];
}

// k 番目の対の片方のラスタのずれ。rasterJitterAt(k) と独立で同じ分布(各成分 [−0.5, 0.5) の一様) — Halton の近い番号どうしは相関するので使わない。
export function rasterPairJitterAt(k: number): readonly [number, number] {
  const uniform = (value: number): number => {
    let x = (value + 0x9e3779b9) >>> 0;
    x = Math.imul(x ^ (x >>> 16), 0x21f0aaad);
    x = Math.imul(x ^ (x >>> 15), 0x735a2d97);
    return ((x ^ (x >>> 15)) >>> 0) / 0x100000000 - 0.5;
  };
  return [uniform(k), uniform(k ^ 0x68bc21eb)];
}

// 基数 base の Halton 列の index 番目(1 から)の値 (0, 1)。
function halton(index: number, base: number): number {
  let result = 0;
  let digitWeight = 1 / base;
  for (let rest = index; rest > 0; rest = Math.floor(rest / base)) {
    result += (rest % base) * digitWeight;
    digitWeight /= base;
  }
  return result;
}
