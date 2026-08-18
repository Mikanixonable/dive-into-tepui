import type { VesselAssembly } from './assembly';
import { edgeFrame, edgeById, mountFrame } from './tree';

export interface ScreenPoint { readonly x: number; readonly y: number; readonly visible: boolean; readonly diameterPx: number; }
export type ProjectFn = (point: { x: number; y: number; z: number }) => ScreenPoint;
export type ModulePick = { readonly kind: 'part'; readonly partId: string } | { readonly kind: 'edge'; readonly edgeId: string } | { readonly kind: 'control' };

function distance(a: ScreenPoint, x: number, y: number): number { return Math.hypot(a.x - x, a.y - y); }
function controlPart(assembly: VesselAssembly): string | undefined {
  const priority = ['cockpit', 'base_module', 'autopilot'] as const;
  return priority.map((type) => assembly.placements.find((p) => p.part.type === type)?.part.id).find((id): id is string => id !== undefined);
}

export function pickModule(assembly: VesselAssembly, screenX: number, screenY: number, project: ProjectFn, minPx: number): ModulePick {
  const candidates: { pick: ModulePick; point: ScreenPoint; order: number }[] = [];
  for (const placement of assembly.placements) {
    if (placement.kind !== 'external') continue;
    const point = project(mountFrame(assembly.tree, placement.mount).origin);
    if (point.visible && point.diameterPx >= minPx) candidates.push({ pick: { kind: 'part', partId: placement.part.id }, point, order: 0 });
  }
  for (const placement of assembly.placements) {
    if (placement.kind !== 'internal') continue;
    for (const edgeId of placement.edgeIds) {
      const frame = edgeFrame(assembly.tree, edgeById(assembly.tree, edgeId));
      const edge = edgeById(assembly.tree, edgeId);
      const midpoint = edge.length / 2;
      const point = project({ x: frame.origin.x + frame.z.x * midpoint, y: frame.origin.y + frame.z.y * midpoint, z: frame.origin.z + frame.z.z * midpoint });
      if (point.visible && point.diameterPx >= minPx) candidates.push({ pick: { kind: 'edge', edgeId }, point, order: 1 });
    }
  }
  candidates.sort((a, b) => distance(a.point, screenX, screenY) - distance(b.point, screenX, screenY) || a.order - b.order);
  if (candidates.length > 0 && distance(candidates[0]!.point, screenX, screenY) <= Math.max(minPx, candidates[0]!.point.diameterPx / 2)) return candidates[0]!.pick;
  return controlPart(assembly) === undefined ? { kind: 'control' } : { kind: 'control' };
}
