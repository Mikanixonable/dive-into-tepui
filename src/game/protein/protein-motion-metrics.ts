// タンパク質の motion 更新の性能計測。1フレームぶんの CPU 時間・GPU 転送量・LOD ごとの体数を
// 拾い、計測窓ぶんの分布へまとめる。

import { LODS_FINE_TO_COARSE, type ProteinMotionLod } from '../../render/protein/protein-display';
import { ProteinEnemy } from '../dynamic/dynamic-entity/protein-enemy';
import type { DynamicEntity } from '../dynamic/dynamic-entity/dynamic-entity';

type ProteinMotionLodCounts = Readonly<Record<ProteinMotionLod, number>>;

export interface ProteinMotionFrameSample {
  /** Motion controller が費やした CPU 時間 [ms]。render 全体の時間は含めない。 */
  readonly cpuMs: number;
  /** この frame に motion buffer を GPU へ転送した量 [bytes]。 */
  readonly uploadBytes: number;
  /** LOD ごとの、motion 更新対象の敵体数。 */
  readonly lodCounts: Partial<ProteinMotionLodCounts>;
}

// 顔ぶれの中の全タンパク質敵から、直近の sync 時点の計測値を足し合わせ、LOD ごとの体数を数える。
export function proteinMotionFrameSample(
  entities: readonly DynamicEntity[],
): ProteinMotionFrameSample {
  let cpuMs = 0;
  let uploadBytes = 0;
  const lodCounts: Partial<Record<ProteinMotionLod, number>> = {};
  // CPU 時間と転送量は総和、体数は LOD ごとに数える。
  for (const entity of entities) {
    if (!(entity instanceof ProteinEnemy)) continue;
    const metrics = entity.view.motionMetrics;
    cpuMs += entity.motionCpuMs + metrics.cpuMs;
    uploadBytes += metrics.uploadBytes;
    lodCounts[entity.motionLod] = (lodCounts[entity.motionLod] ?? 0) + 1;
  }
  return { cpuMs, uploadBytes, lodCounts };
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

// 1つの計測窓ぶんの CPU 時間・転送量・LOD 体数を積み、分布として答える。欠けた LOD は 0 と
// 見なし、負値と非有限値は捨てる。
export class ProteinMotionMetricsRecorder {
  private readonly cpuSamples: number[] = [];
  private readonly uploadSamples: number[] = [];
  private readonly lodTotals = emptyLodCounts();

  record(sample: ProteinMotionFrameSample): void {
    this.cpuSamples.push(finiteNonNegative(sample.cpuMs));
    this.uploadSamples.push(finiteNonNegative(sample.uploadBytes));
    for (const lod of LODS_FINE_TO_COARSE) {
      this.lodTotals[lod] += finiteNonNegative(sample.lodCounts[lod]);
    }
  }

  reset(): void {
    this.cpuSamples.length = 0;
    this.uploadSamples.length = 0;
    for (const lod of LODS_FINE_TO_COARSE) this.lodTotals[lod] = 0;
  }

  summary(): ProteinMotionMetricSummary {
    const frames = this.cpuSamples.length;
    const lodCounts = emptyLodCounts();
    for (const lod of LODS_FINE_TO_COARSE) {
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
