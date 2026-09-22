// 標本の分布の要約。所要時間などの標本列を、平均・中央値・95 パーセンタイル・最大へまとめる。

export interface SampleDistribution {
  readonly avg: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
}

// 昇順に並んだ sorted の、割合 ratio(0..1)の位置にある値(最近傍順位法)。空なら 0。
function percentile(sorted: readonly number[], ratio: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index] ?? 0;
}

// 標本 values の分布。空なら全部 0。
export function distributionOf(values: readonly number[]): SampleDistribution {
  if (values.length === 0) return { avg: 0, p50: 0, p95: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  return {
    avg: values.reduce((sum, value) => sum + value, 0) / values.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted[sorted.length - 1] ?? 0,
  };
}
