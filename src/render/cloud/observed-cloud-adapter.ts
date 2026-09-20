// 観測画像から runtime basis へ変換する Phase 2 adapter。画像だけから高度・相・不確実性を断定しない。

export interface ObservedCloudBasis {
  readonly low: number;
  readonly middle: number;
  readonly convective: number;
  readonly inSitu: number;
}

function bounded(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

export function observedCloudBasisFromRgba(
  red: number, cloudTop: number, translucent: number, alpha = 1,
): ObservedCloudBasis {
  const convectiveWeight = smoothstep(0.45, 0.88, bounded(cloudTop));
  const middleWeight = smoothstep(0.12, 0.58, bounded(cloudTop)) * (1 - convectiveWeight);
  const lowWeight = Math.max(0, 1 - middleWeight - convectiveWeight);
  const coverage = bounded(red);
  return {
    low: coverage * lowWeight,
    middle: coverage * middleWeight,
    convective: coverage * convectiveWeight,
    inSitu: bounded(translucent * alpha),
  };
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}
