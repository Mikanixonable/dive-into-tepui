import type { ViewMode } from './view/view-mode';
// ランの規模の計測値。
import type { EntityCountKind } from './dynamic/entity/entity-kind';
import type { CelestialSurfaceDiagnostics } from '../render/celestial/celestial-surface';
import type { CloudQualityReading } from '../render/earth-weather/cloud/cloud-quality-governor';

interface SurfacePerfCount {
  readonly id: string;
  readonly name: string;
  readonly diagnostics: CelestialSurfaceDiagnostics;
}

// 計測表示に載せるエンティティ数・シミュレーション規模の一式。
export interface PerfCounts {
  // 枠ごとの個体数。1体も出ていない枠は欠ける。
  entities: Partial<Record<EntityCountKind, number>>;
  predicted: number; predictComplete: number; predictorSteps: number;
  arcCelestialBodies: number; arcRevisits: number; arcLead: number | null;
  view: ViewMode; mapItems: number; mapLabels: number; displayDurationSec: number;
  simSubsteps: number; simIntegrated: number; simFollowed: number; gravitySources: number;
  surfaceCandidates: number; contactPairs: number; contactParticipants: number;
  surfaces: readonly SurfacePerfCount[];
  planArcs: number; planSteps: number;
  timeCacheHits: number; timeCacheMisses: number;
  warp: number;
  // 雲の品質適応の読み出し。雲を持つ天体が無ければ null。
  cloudQuality: { readonly cumulus: CloudQualityReading; readonly cirrus: CloudQualityReading } | null;
}

// 1フレームぶんの計測値を差し出す口。
export interface PerfCountSource {
  perfCounts(): PerfCounts;
}
