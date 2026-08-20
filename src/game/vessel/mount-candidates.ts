// 船体ローカル座標上の1点から、部品や構造材を取り付けられる最寄りの MountPoint を逆算する。
// ノードの空き軸方向(ポート)と hull/truss エッジの外表面(along/around の連続パラメータ)の
// 両方を候補にし、閾値内で最も近い1件を返す。

import type { VesselAssembly } from './assembly';
import { occupiedPorts } from './assembly-editor';
import type { MountFrame, MountPoint, PortRef, TreeEdge, TreeNode, VesselTree } from './tree';
import { edgeFrame, mountFrame, portFrame, portKey } from './tree';
import type { Vec3 } from '../../physics/vec3';
import { dot, len, sub } from '../../physics/vec3';

export interface MountCandidate {
  readonly mount: MountPoint;
  readonly frame: MountFrame;
  readonly distance: number; // localPoint から frame.origin までの距離 [m]
}

// localPoint に最も近い取り付け位置を、ノードの空きポートとエッジ表面の両方から探して返す。
// maxDistance を超える候補と、filter が false を返す候補は除く。該当する候補がなければ null。
export function nearestMountCandidate(
  assembly: VesselAssembly,
  localPoint: Vec3,
  maxDistance: number,
  filter?: (mount: MountPoint) => boolean,
): MountCandidate | null {
  let best: MountCandidate | null = null;
  const consider = (candidate: MountCandidate | null): void => {
    if (!candidate || candidate.distance > maxDistance) return;
    if (filter && !filter(candidate.mount)) return;
    if (!best || candidate.distance < best.distance) best = candidate;
  };
  const occupied = occupiedPorts(assembly);
  for (const node of assembly.tree.nodes) {
    consider(portCandidate(node, { kind: 'axial', sign: 1 }, occupied, localPoint));
    consider(portCandidate(node, { kind: 'axial', sign: -1 }, occupied, localPoint));
  }
  for (const edge of assembly.tree.edges) {
    consider(surfaceCandidate(assembly.tree, edge, localPoint));
  }
  return best;
}

function portCandidate(
  node: TreeNode,
  port: PortRef,
  occupied: ReadonlySet<string>,
  localPoint: Vec3,
): MountCandidate | null {
  if (occupied.has(portKey(node.id, port))) return null;
  const frame = portFrame(node, port);
  return { mount: { kind: 'port', nodeId: node.id, port }, frame, distance: len(sub(localPoint, frame.origin)) };
}

function surfaceCandidate(tree: VesselTree, edge: TreeEdge, localPoint: Vec3): MountCandidate | null {
  if (edge.kind.kind === 'decoupler') return null;
  const frame = edgeFrame(tree, edge);
  const rel = sub(localPoint, frame.origin);
  const along = Math.min(edge.length, Math.max(0, dot(rel, frame.z)));
  // x/y 成分は along のクランプに関わらず一定なので、クランプ前の rel から出した角度が
  // そのまま around になる。
  const around = Math.atan2(dot(rel, frame.y), dot(rel, frame.x));
  const mount: MountPoint = { kind: edge.kind.kind === 'hull' ? 'surface' : 'truss', edgeId: edge.id, along, around };
  const mountedFrame = mountFrame(tree, mount);
  return { mount, frame: mountedFrame, distance: len(sub(localPoint, mountedFrame.origin)) };
}
