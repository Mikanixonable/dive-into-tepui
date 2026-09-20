// 雲の品質段階と、no-cloud baselineから導く性能budget。品質は描画経路の入力として渡せる
// 小さな値に限定し、実行時に追加の雲テクスチャを要求しない。

export type CloudQualityLevel = 'low' | 'standard' | 'high';

export interface CloudQualityProfile {
  readonly level: CloudQualityLevel;
  readonly atmosphereSamples: number;
  readonly subGridOctaves: number;
  readonly maxFieldUpdatesPerSecond: number;
}

export const CLOUD_QUALITY: Readonly<Record<CloudQualityLevel, CloudQualityProfile>> = Object.freeze({
  low: Object.freeze({ level: 'low', atmosphereSamples: 8, subGridOctaves: 1, maxFieldUpdatesPerSecond: 2 }),
  standard: Object.freeze({ level: 'standard', atmosphereSamples: 12, subGridOctaves: 2, maxFieldUpdatesPerSecond: 4 }),
  high: Object.freeze({ level: 'high', atmosphereSamples: 20, subGridOctaves: 3, maxFieldUpdatesPerSecond: 4 }),
});

export interface CloudPerformanceBudget {
  readonly frameBudgetMs: number;
  readonly noCloudP95Ms: number;
  readonly headroomMs: number;
  readonly cloudBudgetMs: number;
  readonly qualification: 'qualified' | 'unqualified';
}

// F は1フレームの予算、B0は同じ機器/browserで測ったno-cloud p95。headroomが0なら、cloudを
// 足す余地が無いため60fps qualificationは不可能であり、ゼロbudgetを合格扱いにしない。
export function cloudPerformanceBudget(
  noCloudP95Ms: number, frameBudgetMs = 1000 / 60,
): CloudPerformanceBudget {
  const validFrame = Number.isFinite(frameBudgetMs) && frameBudgetMs > 0;
  const validBaseline = Number.isFinite(noCloudP95Ms) && noCloudP95Ms >= 0;
  const frame = Math.max(0, validFrame ? frameBudgetMs : 0);
  const baseline = Math.max(0, validBaseline ? noCloudP95Ms : 0);
  const headroom = Math.max(0, frame - baseline);
  const cloudBudget = headroom === 0 ? 0 : Math.min(0.20 * frame, 0.50 * headroom);
  return {
    frameBudgetMs: frame,
    noCloudP95Ms: baseline,
    headroomMs: headroom,
    cloudBudgetMs: cloudBudget,
    qualification: validFrame && validBaseline && headroom > 0 ? 'qualified' : 'unqualified',
  };
}
