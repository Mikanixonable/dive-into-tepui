// 接続口を誰が使っているかだけを答える。編集も検証もこの1つの答えの上に立つので、どちらにも
// 属さない位置に置く。
import type { PartPlacement, VesselAssembly } from './assembly';
import type { VesselTree } from './tree';
import { portKey } from './tree';

// 接続口の占有を問える最小限の形。VesselAssembly/VesselBlueprint のどちらも構造的に満たす。
export interface PortOwnerSource {
  readonly tree: VesselTree;
  readonly placements: readonly PartPlacement[];
}

// 接続口の占有者。エッジが使っているか外装部品が使っているかで文言を出し分ける必要があるため、
// 占有の有無だけでなくどちらが使っているかまで答える。
export interface PortOwner {
  readonly kind: 'edge' | 'part';
  readonly id: string;
}

// 接続口ごとの占有者。1つの接続口はエッジ1本か外装部品1つのどちらか一方だけが使える —
// その判定の唯一の実装。ignoredEdgeId/ignoredPlacementId は「自分自身を除いて他の誰かが
// 使っているか」を問うためのもの。
export function portOwners(
  source: PortOwnerSource,
  ignoredEdgeId?: string,
  ignoredPlacementId?: string,
): ReadonlyMap<string, PortOwner> {
  const owners = new Map<string, PortOwner>();
  for (const edge of source.tree.edges) {
    if (edge.id === ignoredEdgeId) continue;
    owners.set(portKey(edge.a, edge.portA), { kind: 'edge', id: edge.id });
    owners.set(portKey(edge.b, edge.portB), { kind: 'edge', id: edge.id });
  }
  for (const placement of source.placements) {
    if (placement.kind !== 'external' || placement.mount.kind !== 'port') continue;
    if (placement.part.id === ignoredPlacementId) continue;
    owners.set(portKey(placement.mount.nodeId, placement.mount.port), { kind: 'part', id: placement.part.id });
  }
  return owners;
}

// エッジまたは外装部品が既に使っている接続口の鍵の集合。
export function occupiedPorts(assembly: VesselAssembly, ignoredEdgeId?: string): ReadonlySet<string> {
  return new Set(portOwners(assembly, ignoredEdgeId).keys());
}
