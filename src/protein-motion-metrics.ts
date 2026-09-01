// Protein motion の性能計測を、実装本体から切り離すための小さな収集器。
//
// Render Lab と runtime が同じ形式で controller CPU 時間・upload bytes・LOD 体数を記録する。

export const PROTEIN_MOTION_LODS = ['near', 'medium', 'far', 'marker'] as const;
export type ProteinMotionLod = (typeof PROTEIN_MOTION_LODS)[number];

type ProteinMotionLodCounts = Readonly<Record<ProteinMotionLod, number>>;

export interface ProteinMotionFrameSample {
  /** Motion controller が費やした CPU 時間 [ms]。render 全体の時間は含めない。 */
  readonly cpuMs: number;
  /** この frame に motion buffer を GPU へ転送した量 [bytes]。 */
  readonly uploadBytes: number;
  /** LOD ごとの、motion 更新対象の敵体数。 */
  readonly lodCounts: Partial<ProteinMotionLodCounts>;
}

interface ProteinMotionMetricsSink {
  record(sample: ProteinMotionFrameSample): void;
}

export interface ProteinMotionMetricSummary {
  readonly frames: number;
  readonly cpuMs: MetricDistribution;
  readonly uploadBytes: MetricDistribution;
  readonly lodCounts: ProteinMotionLodCounts;
}

interface MetricDistribution {
  readonly avg: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
}

function finiteNonNegative(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, value!) : 0;
}

function percentile(sorted: readonly number[], ratio: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index] ?? 0;
}

function distribution(values: readonly number[]): MetricDistribution {
  if (values.length === 0) return { avg: 0, p50: 0, p95: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const sum = values.reduce((total, value) => total + value, 0);
  return {
    avg: sum / values.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted[sorted.length - 1] ?? 0,
  };
}

function emptyLodCounts(): Record<ProteinMotionLod, number> {
  return { near: 0, medium: 0, far: 0, marker: 0 };
}

/**
 * One measurement window for one protein scene.
 *
 * The recorder intentionally accepts partial LOD counts so callers can provide only the LODs they
 * update. Missing fields are zero; negative and non-finite values are ignored. This keeps the
 * instrumentation safe to call from a hot update path without making telemetry part of simulation
 * state.
 */
export class ProteinMotionMetricsRecorder implements ProteinMotionMetricsSink {
  private readonly cpuSamples: number[] = [];
  private readonly uploadSamples: number[] = [];
  private readonly lodTotals = emptyLodCounts();

  record(sample: ProteinMotionFrameSample): void {
    this.cpuSamples.push(finiteNonNegative(sample.cpuMs));
    this.uploadSamples.push(finiteNonNegative(sample.uploadBytes));
    for (const lod of PROTEIN_MOTION_LODS) {
      this.lodTotals[lod] += finiteNonNegative(sample.lodCounts[lod]);
    }
  }

  reset(): void {
    this.cpuSamples.length = 0;
    this.uploadSamples.length = 0;
    for (const lod of PROTEIN_MOTION_LODS) this.lodTotals[lod] = 0;
  }

  summary(): ProteinMotionMetricSummary {
    const frames = this.cpuSamples.length;
    const lodCounts = emptyLodCounts();
    for (const lod of PROTEIN_MOTION_LODS) {
      lodCounts[lod] = frames === 0 ? 0 : this.lodTotals[lod]! / frames;
    }
    return {
      frames,
      cpuMs: distribution(this.cpuSamples),
      uploadBytes: distribution(this.uploadSamples),
      lodCounts,
    };
  }
}
