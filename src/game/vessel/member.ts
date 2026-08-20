// 構造材(hull エッジ・トラス・分離機構)の棚に並ぶ既製品。TreeEdge.length は addNode が両端の
// portFrame の距離から引き直す(tree.ts)ので、辺の長さをカーソルの指す任意の位置から決めることは
// できない ―― 代わりに部材は長さを吸着より先に固定して持ち、遠端ノードを
// 「吸着したポートの origin + z 軸 × 長さ」に置く。長さが常に DIMENSION_UNIT の倍数なら、
// 導かれる辺の長さも常に量子化を満たす。THREE には触れないので DOM 無しで検証できる。
import { addNode, type AssemblyEditResult } from './assembly-editor';
import type { VesselAssembly } from './assembly';
import { DIMENSION_UNIT, MIN_EDGE_LENGTH } from './tree';
import type { EdgeKind, MountFrame, PortRef, TreeEdge, TreeNode, VesselTree } from './tree';
import type { CrossSection } from '../../physics/section-moments';
import { add, scale, v3 } from '../../physics/vec3';

export type MemberKind = 'hull' | 'truss' | 'decoupler';

export const MEMBER_KIND_LABELS: Readonly<Record<MemberKind, string>> = {
  hull: '外皮', truss: 'トラス', decoupler: '分離機構',
};

export const MEMBER_DEFAULT_LENGTH = 2;
export const MEMBER_DEFAULT_RADIUS = 1.5; // [m] 遠端ノードの断面外接半径
export const MEMBER_DEFAULT_SEPARATION_IMPULSE = 500; // [N·s] decoupler のみ読む

// 棚に置く部材1つの構成。radius は遠端ノードの断面(円)の外接半径であり、truss ではその2倍を
// 骨太さ(sectionSize)として使う。separationImpulse は decoupler 以外では読まれない。
export interface MemberSpec {
  readonly kind: MemberKind;
  readonly length: number; // [m], DIMENSION_UNIT の倍数、MIN_EDGE_LENGTH 以上
  readonly radius: number; // [m]
  readonly separationImpulse: number; // [N·s]
}

// 入力値を DIMENSION_UNIT の倍数へ丸め、MIN_EDGE_LENGTH を割らないよう切り上げる。
// 棚の長さ欄はこれを確定のたびに通すので、部材の長さが量子化を外れることはない。
export function quantizeMemberLength(length: number): number {
  if (!Number.isFinite(length)) return MIN_EDGE_LENGTH;
  const snapped = Math.round(length / DIMENSION_UNIT) * DIMENSION_UNIT;
  return Math.max(MIN_EDGE_LENGTH, snapped);
}

// member.kind から生えるエッジの種別ぶんの付帯値を組む。
function edgeKindOf(member: MemberSpec): EdgeKind {
  if (member.kind === 'hull') return { kind: 'hull' };
  if (member.kind === 'truss') return { kind: 'truss', sectionSize: member.radius * 2 };
  return { kind: 'decoupler', separationImpulse: member.separationImpulse };
}

// 遠端ノードの断面。部材自身の半径を持つ円1枚だけの複合体。
function farSection(member: MemberSpec): CrossSection {
  return { primitives: [{ id: 'far', shape: { kind: 'circle', radius: member.radius, branchCount: 4 }, phaseAngle: 0, attachment: null }] };
}

// tree のノード・エッジ id と衝突しない id を prefix から作る。
function uniqueId(prefix: string, tree: VesselTree): string {
  const taken = new Set<string>([...tree.nodes.map((node) => node.id), ...tree.edges.map((edge) => edge.id)]);
  let n = 0;
  let id = `${prefix}-0`;
  while (taken.has(id)) { n += 1; id = `${prefix}-${n}`; }
  return id;
}

// mountFrame が指すポート(nearNodeId の nearPort)から member ぶんだけ伸ばした先に新しいノードを
// 立て、そこへ向かうエッジで結ぶ編集を組む。辺の長さは渡さない ―― addNode 自身が両端の portFrame
// の距離から引き直すので、origin + z×length に置いたノードの位置がそのまま長さとして戻り、
// 量子化は member.length 自身がすでに満たしている。
export function memberAdditionAt(
  assembly: VesselAssembly,
  nearNodeId: string,
  nearPort: PortRef,
  mountFrame: MountFrame,
  member: MemberSpec,
): AssemblyEditResult {
  const farNodeId = uniqueId(`node-${member.kind}`, assembly.tree);
  const farNode: TreeNode = {
    id: farNodeId,
    pos: add(mountFrame.origin, scale(mountFrame.z, member.length)),
    axis: mountFrame.z,
    phaseAngle: 0,
    section: farSection(member),
  };
  const edge: Omit<TreeEdge, 'length'> = {
    id: uniqueId(`edge-${member.kind}`, assembly.tree),
    a: nearNodeId,
    b: farNodeId,
    portA: nearPort,
    portB: { kind: 'axial', sign: -1 },
    kind: edgeKindOf(member),
  };
  return addNode(assembly, { node: farNode, edge }, { validateBlueprint: false });
}

// ドラッグ中のゴースト表示専用の使い捨てツリー。掴んだ時点ではまだ吸着先の断面が分からないので、
// 両端を部材自身の半径の円で近似する ―― hullShapeOf → buildLoftGeometry を通せば、実際に生える
// 外皮/トラス/分離機構と同じ経路で見た目が作れる。
export function memberGhostTree(member: MemberSpec): VesselTree {
  const section = farSection(member);
  const a: TreeNode = { id: 'ghost-a', pos: v3(0, 0, 0), axis: v3(0, 0, 1), phaseAngle: 0, section };
  const b: TreeNode = { id: 'ghost-b', pos: v3(0, 0, member.length), axis: v3(0, 0, 1), phaseAngle: 0, section };
  const edge: TreeEdge = {
    id: 'ghost-edge', a: 'ghost-a', b: 'ghost-b',
    portA: { kind: 'axial', sign: 1 }, portB: { kind: 'axial', sign: -1 },
    length: member.length, kind: edgeKindOf(member),
  };
  return { nodes: [a, b], edges: [edge] };
}
