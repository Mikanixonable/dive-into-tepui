// ランの規模の計測値。
import type { EntityCountKind } from './dynamic/dynamic-entity/entity-kind';
import type { ProteinMotionFrameSample } from './protein/protein-motion-metrics';

// 計測表示に載せるエンティティ数・シミュレーション規模の一式。
export type PerfCounts = {
  // 枠ごとの個体数。1体も出ていない枠は欠ける。
  entities: Partial<Record<EntityCountKind, number>>;
  predicted: number; predictComplete: number; predictorSteps: number;
  arcCelestialBodies: number; arcRevisits: number; arcLead: number | null;
  mapMode: boolean; mapItems: number; mapLabels: number; displayDurationSec: number;
  simSubsteps: number; simIntegrated: number; simFollowed: number; gravitySources: number;
  surfaceCandidates: number; contactPairs: number; contactParticipants: number;
  planArcs: number; planSteps: number;
  timeCacheHits: number; timeCacheMisses: number;
  warp: number;
};

// 1フレームぶんの計測値を差し出す口。
export interface PerfCountSource {
  perfCounts(): PerfCounts;
  proteinMotionFrameSample(): ProteinMotionFrameSample;
}
