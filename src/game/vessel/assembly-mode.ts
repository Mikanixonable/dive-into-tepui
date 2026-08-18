import type { AnyPart } from '../game-entity/parts';
import { partBuildCost } from '../economy/build-cost';
import type { BlueprintResourceAmount } from '../economy/producibility';
import type { ResourceLedger } from '../economy/resource-ledger';
import type { PartPlacement, VesselAssembly } from './assembly';
import { createBlueprint, type VesselBlueprint } from './blueprint';
import type { MountPoint, TreeEdge, TreeNode, VesselTree } from './tree';

export type AssemblyPartKind = 'hull' | 'truss' | 'decoupler' | 'part';
export interface PartOrder { readonly kind: AssemblyPartKind; readonly part?: AnyPart; readonly mass: number; readonly resources: readonly BlueprintResourceAmount[]; }
export interface PartStock { readonly orders: readonly PartOrder[]; }
export interface AssemblyDraft { readonly tree: VesselTree; readonly placements: readonly PartPlacement[]; readonly paint?: VesselBlueprint['paint']; readonly stageOrder?: readonly string[]; }

export function partOrder(part: AnyPart): PartOrder { return { kind: 'part', part, mass: part.weight, resources: partBuildCost(part) }; }
export function partOrderProducibility(part: AnyPart, ledger: ResourceLedger): readonly BlueprintResourceAmount[] {
  return partBuildCost(part).filter((required) => ledger.amountOf(required.resourceId) < required.mass);
}
export function addToPartStock(stock: PartStock, order: PartOrder): PartStock { return { orders: [...stock.orders, order] }; }
export function removeFromPartStock(stock: PartStock, index: number): PartStock {
  if (index < 0 || index >= stock.orders.length) throw new RangeError('part stock index');
  return { orders: stock.orders.filter((_unused, i) => i !== index) };
}

export type MateFailure = 'occupied' | 'section-fit' | 'phase' | 'length' | 'work-area';
export interface MateVerdict { readonly accepted: boolean; readonly failures: readonly MateFailure[]; }
export function mateVerdict(input: { readonly occupied: boolean; readonly widthFits: boolean; readonly phaseFits: boolean; readonly lengthFits: boolean; readonly withinWorkArea: boolean }): MateVerdict {
  const failures: MateFailure[] = [];
  if (input.occupied) failures.push('occupied');
  if (!input.widthFits) failures.push('section-fit');
  if (!input.phaseFits) failures.push('phase');
  if (!input.lengthFits) failures.push('length');
  if (!input.withinWorkArea) failures.push('work-area');
  return { accepted: failures.length === 0, failures };
}

export function blueprintFromDraft(draft: AssemblyDraft, id: string, name: string, now: number): VesselBlueprint {
  return createBlueprint({ id, name, now, tree: draft.tree, placements: draft.placements, paint: draft.paint, stageOrder: draft.stageOrder });
}
export function assemblyFromDraft(draft: AssemblyDraft): VesselAssembly { return { tree: draft.tree, placements: draft.placements }; }
export function rebuildPlan(blueprint: VesselBlueprint): readonly PartOrder[] {
  return blueprint.placements.map((placement) => partOrder(placement.part));
}

/** Build a tree from explicit already-mated edges; the UI owns the 3D snapping. */
export function treeFromDraft(nodes: readonly TreeNode[], edges: readonly TreeEdge[]): VesselTree { return { nodes: [...nodes], edges: [...edges] }; }

export function mountPart(part: AnyPart, mount: MountPoint): PartPlacement { return { kind: 'external', part, mount }; }
