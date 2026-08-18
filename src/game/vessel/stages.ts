import type { AnyPart } from '../game-entity/parts';
import type { PartPlacement } from './assembly';
import type { TreeEdge, VesselTree } from './tree';

export interface VesselStage {
  readonly id: string;
  readonly edgeIds: readonly string[];
  readonly nodeIds: readonly string[];
  readonly partIds: readonly string[];
  readonly hasCockpit: boolean;
  readonly hasAutopilot: boolean;
  readonly hasCommunication: boolean;
}

function connectedComponents(tree: VesselTree): readonly { nodes: Set<string>; edges: Set<string> }[] {
  const adjacency = new Map<string, { node: string; edge: TreeEdge }[]>();
  for (const node of tree.nodes) adjacency.set(node.id, []);
  for (const edge of tree.edges) {
    if (edge.kind.kind === 'decoupler') continue;
    adjacency.get(edge.a)?.push({ node: edge.b, edge });
    adjacency.get(edge.b)?.push({ node: edge.a, edge });
  }
  const seen = new Set<string>();
  const result: { nodes: Set<string>; edges: Set<string> }[] = [];
  for (const node of tree.nodes) {
    if (seen.has(node.id)) continue;
    const nodes = new Set<string>();
    const edges = new Set<string>();
    const queue = [node.id];
    seen.add(node.id);
    while (queue.length > 0) {
      const id = queue.pop()!;
      nodes.add(id);
      for (const link of adjacency.get(id) ?? []) {
        edges.add(link.edge.id);
        if (!seen.has(link.node)) { seen.add(link.node); queue.push(link.node); }
      }
    }
    result.push({ nodes, edges });
  }
  return result;
}

function partBelongs(part: PartPlacement, component: { nodes: Set<string>; edges: Set<string> }): boolean {
  if (part.kind === 'internal') return part.edgeIds.some((id) => component.edges.has(id));
  if (part.mount.kind === 'port') return component.nodes.has(part.mount.nodeId);
  return component.edges.has(part.mount.edgeId);
}

export function splitStages(tree: VesselTree, placements: readonly PartPlacement[]): readonly VesselStage[] {
  return connectedComponents(tree).map((component, index) => {
    const parts = placements.filter((placement) => partBelongs(placement, component)).map((placement) => placement.part);
    return {
      id: `stage-${index + 1}`,
      edgeIds: [...component.edges],
      nodeIds: [...component.nodes],
      partIds: parts.map((part) => part.id),
      hasCockpit: parts.some((part) => part.type === 'cockpit'),
      hasAutopilot: parts.some((part) => part.type === 'autopilot'),
      hasCommunication: parts.some((part) => part.type === 'communication'),
    };
  });
}

export interface SeparationVelocity {
  readonly a: { readonly x: number; readonly y: number; readonly z: number };
  readonly b: { readonly x: number; readonly y: number; readonly z: number };
}

/** Equal and opposite separation impulse, preserving linear momentum. */
export function separationVelocity(
  massA: number, massB: number, relativeVelocity: { x: number; y: number; z: number },
): SeparationVelocity {
  if (!(massA > 0) || !(massB > 0)) throw new RangeError('stage masses must be positive');
  const total = massA + massB;
  return {
    a: { x: relativeVelocity.x * massB / total, y: relativeVelocity.y * massB / total, z: relativeVelocity.z * massB / total },
    b: { x: -relativeVelocity.x * massA / total, y: -relativeVelocity.y * massA / total, z: -relativeVelocity.z * massA / total },
  };
}

export function stageForPart(stages: readonly VesselStage[], part: AnyPart): VesselStage | undefined {
  return stages.find((stage) => stage.partIds.includes(part.id));
}

export function sameStage(stages: readonly VesselStage[], a: AnyPart, b: AnyPart): boolean {
  const sa = stageForPart(stages, a);
  return sa !== undefined && sa.partIds.includes(b.id);
}

export function cutEdges(tree: VesselTree): readonly TreeEdge[] {
  return tree.edges.filter((edge) => edge.kind.kind === 'decoupler');
}
