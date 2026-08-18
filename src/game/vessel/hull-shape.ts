// 形状ツリーから外皮の形(ロフト帯と骨組み)を導く。THREE には触れないので、面積の検証を
// 描画器なしで行える — 三角形分割は render/hull/hull-triangles.ts が受け取って行う。

import { LOFT_SAMPLE_COUNT, sectionOutline } from '../../physics/hull-loft';
import type { HullBand, HullBeam, HullFrame, HullShape } from '../../render/hull/hull-triangles';
import type { PortRef, TreeEdge, TreeNode, VesselTree } from './tree';
import { circumradius, nodeBasis, nodeById, portFrame, portOf } from './tree';

// 外皮の細かさ。近距離は輪郭のサンプリング点数そのもの、遠距離は 3・4・6・8 角形の頂点が
// そのまま乗る 24 点まで落とす(5角形だけは遠距離で角が丸む)。
export type HullLod = 'near' | 'far';

export const HULL_LOD_SAMPLES: Record<HullLod, number> = { near: LOFT_SAMPLE_COUNT, far: 24 };

// ノードの断面座標系。原点だけを接続口の中心へ寄せ、基底はノードのものを使う — 断面はノードの
// 持ち物なので、接続口の向きで基底を取り直すと断面が鏡像になる。
function bandFrame(node: TreeNode, port: PortRef): HullFrame {
  const basis = nodeBasis(node);
  return { origin: portFrame(node, port).origin, x: basis.x, y: basis.y, z: basis.z };
}

// その端の断面が露出しているか。同じノードの反対側の軸方向の口に別の hull エッジが付いていれば、
// 外皮はそこで連続するので蓋は要らない。側面の口に付いた端は常に自分の端面を持つ。
function exposed(tree: VesselTree, edge: TreeEdge, nodeId: string): boolean {
  const port = portOf(edge, nodeId);
  if (port.kind !== 'axial') return true;
  return !tree.edges.some((other) => {
    if (other === edge || other.kind.kind !== 'hull') return false;
    if (other.a !== nodeId && other.b !== nodeId) return false;
    const otherPort = portOf(other, nodeId);
    return otherPort.kind === 'axial' && otherPort.sign === -port.sign;
  });
}

function bandOf(tree: VesselTree, edge: TreeEdge, samples: number): HullBand {
  const a = nodeById(tree, edge.a);
  const b = nodeById(tree, edge.b);
  return {
    outlineA: sectionOutline(a.section, samples),
    outlineB: sectionOutline(b.section, samples),
    frameA: bandFrame(a, edge.portA),
    frameB: bandFrame(b, edge.portB),
    capA: exposed(tree, edge, edge.a),
    capB: exposed(tree, edge, edge.b),
  };
}

function beamOf(tree: VesselTree, edge: TreeEdge): HullBeam {
  const a = nodeById(tree, edge.a);
  const b = nodeById(tree, edge.b);
  const ends = {
    a: portFrame(a, edge.portA).origin,
    b: portFrame(b, edge.portB).origin,
  };
  if (edge.kind.kind === 'truss') {
    return { ...ends, size: edge.kind.sectionSize, style: 'lattice' };
  }
  // 分離機構は両端の断面をつなぐ短い継手なので、外接円半径の平均を一辺とする。
  return { ...ends, size: (circumradius(a.section) + circumradius(b.section)) / 2, style: 'collar' };
}

export function hullShapeOf(tree: VesselTree, lod: HullLod = 'near'): HullShape {
  const samples = HULL_LOD_SAMPLES[lod];
  const bands: HullBand[] = [];
  const beams: HullBeam[] = [];
  for (const edge of tree.edges) {
    if (edge.kind.kind === 'hull') bands.push(bandOf(tree, edge, samples));
    else beams.push(beamOf(tree, edge));
  }
  return { bands, beams };
}
