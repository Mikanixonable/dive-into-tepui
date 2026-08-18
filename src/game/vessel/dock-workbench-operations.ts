import type { AnyPart } from '../game-entity/parts';
import type { PartPlacement, VesselAssembly } from './assembly';
import { createBlueprint } from './blueprint';

export interface PartPropertySnapshot {
  readonly id: string;
  readonly type: AnyPart['type'];
  readonly name: string;
  readonly hp: number;
  readonly maxHp: number;
  readonly weight: number;
}

export function partPropertySnapshot(part: AnyPart): PartPropertySnapshot {
  return { id: part.id, type: part.type, name: part.name, hp: part.hp, maxHp: part.maxHp, weight: part.weight };
}

/** Pure commit boundary for a dock edit: the runtime can persist the returned blueprint atomically. */
export function commitDockAssembly(assembly: VesselAssembly, id: string, name: string, now: number): ReturnType<typeof createBlueprint> {
  return createBlueprint({ id, name, tree: assembly.tree, placements: assembly.placements, now });
}

/** Parts removed from a vessel become inventory entries only after this explicit commit. */
export function removedParts(before: VesselAssembly, after: VesselAssembly): AnyPart[] {
  const remaining = new Set(after.placements.map((placement) => placement.part.id));
  return before.placements
    .filter((placement) => !remaining.has(placement.part.id))
    .map((placement: PartPlacement) => placement.part);
}
