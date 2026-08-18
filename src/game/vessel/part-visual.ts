import type { PartPlacement } from './assembly';

/** Stable selection reference shared by the workbench, inspector, and render tree. */
export interface PartVisualRef {
  readonly partId: string;
  readonly placementIndex: number;
}

export function partVisualRefOf(placement: PartPlacement, placementIndex: number): PartVisualRef {
  return { partId: placement.part.id, placementIndex };
}
