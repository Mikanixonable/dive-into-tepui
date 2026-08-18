// 機体の形状ツリー(§8)。ノードは断面を置いた面、エッジはその面同士をつなぐ区間であり、外皮を作る
// もの・作らない構造部材(トラス)・切り離せる境界の3種がある。ツリーはグラフであって閉路を含んで
// よく、三角形や梯子状に組めば扁平な機体になる。
//
// ノードは船体ローカル座標での位置と断面の法線を自分で持つ。エッジの長さは両端のノードの位置から
// 決まる値をそのまま持ち、validateTree がその一致を確かめる — 閉路のある構造では、エッジの長さから
// ノードの位置を一意に解くことはできないためである。

import { Vec3, cross, dot, len, norm, scale, sub, v3, add, rotateAxis } from '../../physics/vec3';
import type { CrossSection, Vec2 } from '../../physics/section-moments';
import { placeSectionPrimitives } from '../../physics/section-moments';
import { sectionOutline } from '../../physics/hull-loft';

// 寸法の刻み [m]。エッジの長さと、外装要素の軸方向の取り付け位置がこの倍数を取る。
export const DIMENSION_UNIT = 0.5;

// エッジの最短の長さ [m]。
export const MIN_EDGE_LENGTH = 0.5;

// 寸法が刻みに乗っているとみなす許容差 [m]。
const QUANTIZATION_TOLERANCE = 1e-9;

// エッジの長さと両端のノードの距離が一致しているとみなす相対許容差。
const LENGTH_TOLERANCE_RATIO = 1e-6;

export interface TreeNode {
  readonly id: string;
  readonly pos: Vec3; // 船体ローカル座標 [m]
  readonly section: CrossSection;
  readonly axis: Vec3; // 断面の法線(ツリーの進行方向)
  readonly phaseAngle: number; // 断面全体の回転位相 [rad]
}

export type EdgeKind =
  | { readonly kind: 'hull' } // 外皮を作る。内側が内容積になる
  | { readonly kind: 'truss'; readonly sectionSize: number } // 外皮を作らない構造部材
  | { readonly kind: 'decoupler'; readonly separationImpulse: number }; // 外皮を作らず、切り離せる

export type PortRef =
  | { readonly kind: 'axial'; readonly sign: 1 | -1 }
  | { readonly kind: 'lateral'; readonly primitiveId: string; readonly faceIndex: number };

export interface TreeEdge {
  readonly id: string;
  readonly a: string;
  readonly b: string;
  readonly portA: PortRef;
  readonly portB: PortRef;
  readonly length: number; // 0.5 m 単位、最小 0.5 m
  readonly kind: EdgeKind;
}

export interface VesselTree {
  readonly nodes: readonly TreeNode[];
  readonly edges: readonly TreeEdge[];
}

// 外装要素の取り付け位置(§8-3)。along はエッジの始点(ノード a 側)からの距離 [m]、around は
// エッジの軸まわりの角度 [rad]。
export type MountPoint =
  | { readonly kind: 'port'; readonly nodeId: string; readonly port: PortRef }
  | { readonly kind: 'surface'; readonly edgeId: string; readonly along: number; readonly around: number }
  | { readonly kind: 'truss'; readonly edgeId: string; readonly along: number; readonly around: number };

// 接続口や取り付け位置のローカル座標系(§8-2)。z が外向き法線、y が基準ロール方向、x は右手系で決まる。
export interface MountFrame {
  readonly origin: Vec3; // 船体ローカル座標
  readonly x: Vec3;
  readonly y: Vec3;
  readonly z: Vec3;
}

// ---------------------------------------------------------------------------
// 参照の解決
// ---------------------------------------------------------------------------

export function nodeById(tree: VesselTree, id: string): TreeNode {
  const node = tree.nodes.find((n) => n.id === id);
  if (!node) throw new Error(`unknown node "${id}"`);
  return node;
}

export function edgeById(tree: VesselTree, id: string): TreeEdge {
  const edge = tree.edges.find((e) => e.id === id);
  if (!edge) throw new Error(`unknown edge "${id}"`);
  return edge;
}

// エッジの、ノード id 側の接続口。
export function portOf(edge: TreeEdge, nodeId: string): PortRef {
  if (edge.a === nodeId) return edge.portA;
  if (edge.b === nodeId) return edge.portB;
  throw new Error(`edge "${edge.id}" does not touch node "${nodeId}"`);
}

// 2つの接続口が同じ口を指すか。
export function samePort(a: PortRef, b: PortRef): boolean {
  if (a.kind === 'axial') return b.kind === 'axial' && a.sign === b.sign;
  return b.kind === 'lateral' && a.primitiveId === b.primitiveId && a.faceIndex === b.faceIndex;
}

// ---------------------------------------------------------------------------
// 座標系
// ---------------------------------------------------------------------------

// 断面の座標系から船体ローカル座標系への基底。z がノードの軸、x/y が断面の x/y に対応し、
// phaseAngle だけ軸まわりに回っている。軸が船体の y 軸とほぼ平行なときは、位相の基準を z 軸から
// 取り直す — 基準の取り方はどちらでも位相 0 の向きが変わるだけで、機体の設計側がその向きに合わせる。
export function nodeBasis(node: TreeNode): MountFrame {
  const z = norm(node.axis);
  const reference = Math.abs(z.y) > 0.99 ? v3(0, 0, 1) : v3(0, 1, 0);
  const x0 = norm(cross(reference, z));
  const x = rotateAxis(x0, z, node.phaseAngle);
  return { origin: node.pos, x, y: cross(z, x), z };
}

// 断面の座標系で表した点を船体ローカル座標へ移す。
function toHull(basis: MountFrame, point: Vec2, alongAxis = 0): Vec3 {
  return add(
    basis.origin,
    add(add(scale(basis.x, point.x), scale(basis.y, point.y)), scale(basis.z, alongAxis)),
  );
}

// 断面の座標系での、側面の口の中心と外向き法線と辺に沿う方向。
interface SectionPort {
  readonly center: Vec2;
  readonly outward: Vec2;
  readonly along: Vec2;
}

function lateralSectionPort(section: CrossSection, primitiveId: string, faceIndex: number): SectionPort {
  const primitive = placeSectionPrimitives(section).find((p) => p.id === primitiveId);
  if (!primitive) throw new Error(`unknown primitive "${primitiveId}"`);
  if (!primitive.vertices) {
    // 円と楕円は辺を持たないので、口の方向は §7-2 が定める等分方向そのものになる。
    const { shape, phaseAngle } = primitive;
    if (shape.kind !== 'circle' && shape.kind !== 'ellipse') {
      throw new Error(`primitive "${primitiveId}" has no outline`);
    }
    const count = shape.kind === 'circle' ? shape.branchCount : 2;
    if (faceIndex < 0 || faceIndex >= count) {
      throw new Error(`primitive "${primitiveId}" has no face ${faceIndex}`);
    }
    const angle = phaseAngle + (2 * Math.PI * faceIndex) / count;
    const radius = shape.kind === 'circle' ? shape.radius : shape.majorRadius;
    const outward: Vec2 = { x: Math.cos(angle), y: Math.sin(angle) };
    return {
      center: { x: outward.x * radius, y: outward.y * radius },
      outward,
      along: { x: -outward.y, y: outward.x },
    };
  }
  const vertices = primitive.vertices;
  if (faceIndex < 0 || faceIndex >= vertices.length) {
    throw new Error(`primitive "${primitiveId}" has no face ${faceIndex}`);
  }
  const p0 = vertices[faceIndex]!;
  const p1 = vertices[(faceIndex + 1) % vertices.length]!;
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const scaleFactor = 1 / Math.hypot(dx, dy);
  // 頂点列は反時計回りなので、辺の進行方向を時計回りに90度回すと外を向く。
  return {
    center: { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 },
    outward: { x: dy * scaleFactor, y: -dx * scaleFactor },
    along: { x: dx * scaleFactor, y: dy * scaleFactor },
  };
}

// 接続口のローカル座標系(§8-2)。
export function portFrame(node: TreeNode, port: PortRef): MountFrame {
  const basis = nodeBasis(node);
  if (port.kind === 'axial') {
    const z = scale(basis.z, port.sign);
    // +Y は断面の回転位相が決める向き、すなわち断面の y 軸そのもの。
    const y = basis.y;
    return { origin: basis.origin, x: cross(y, z), y, z };
  }
  const section = lateralSectionPort(node.section, port.primitiveId, port.faceIndex);
  const z = norm(add(scale(basis.x, section.outward.x), scale(basis.y, section.outward.y)));
  const y = norm(add(scale(basis.x, section.along.x), scale(basis.y, section.along.y)));
  return { origin: toHull(basis, section.center), x: cross(y, z), y, z };
}

// エッジの、ノード a 側の接続口から b 側の接続口へ向かう単位ベクトル。
export function edgeDirection(tree: VesselTree, edge: TreeEdge): Vec3 {
  const from = portFrame(nodeById(tree, edge.a), edge.portA).origin;
  const to = portFrame(nodeById(tree, edge.b), edge.portB).origin;
  return norm(sub(to, from));
}

// エッジのローカル座標系。原点はノード a 側の口の中心、z がエッジの進行方向、y はその口の基準ロール
// 方向を z に直交させたもの。エッジ上の取り付け位置と、ロフトの局所座標がこれを共有する。
export function edgeFrame(tree: VesselTree, edge: TreeEdge): MountFrame {
  const start = portFrame(nodeById(tree, edge.a), edge.portA);
  const z = edgeDirection(tree, edge);
  const reference = Math.abs(dot(start.y, z)) > 0.99 ? start.x : start.y;
  const y = norm(sub(reference, scale(z, dot(reference, z))));
  return { origin: start.origin, x: cross(y, z), y, z };
}

// 外装要素の取り付け位置のローカル座標系(§8-3)。外表面とトラス上では z が外向き(軸から放射方向)、
// y がエッジの進行方向になる。
export function mountFrame(tree: VesselTree, mount: MountPoint): MountFrame {
  if (mount.kind === 'port') return portFrame(nodeById(tree, mount.nodeId), mount.port);
  const edge = edgeById(tree, mount.edgeId);
  const frame = edgeFrame(tree, edge);
  const outward = norm(
    add(scale(frame.x, Math.cos(mount.around)), scale(frame.y, Math.sin(mount.around))),
  );
  const radius = mount.kind === 'truss' ? trussRadius(edge) : surfaceRadiusAt(tree, edge, mount.along);
  const origin = add(add(frame.origin, scale(frame.z, mount.along)), scale(outward, radius));
  return { origin, x: cross(frame.z, outward), y: frame.z, z: outward };
}

// トラスの、軸から外装要素の取り付け面までの距離 [m]。断面の大きさを一辺とみなした半分。
function trussRadius(edge: TreeEdge): number {
  return edge.kind.kind === 'truss' ? edge.kind.sectionSize / 2 : 0;
}

// hull エッジの外表面の、軸から測った半径 [m]。両端の断面の外接円半径を軸方向に線形補間する。
function surfaceRadiusAt(tree: VesselTree, edge: TreeEdge, along: number): number {
  const ra = circumradius(nodeById(tree, edge.a).section);
  const rb = circumradius(nodeById(tree, edge.b).section);
  const t = edge.length > 0 ? along / edge.length : 0;
  return ra + (rb - ra) * t;
}

// 断面の外接円半径 [m]。複合断面では、構成する基本断面の頂点と輪郭までの最大距離を取る。
export function circumradius(section: CrossSection): number {
  let maximum = 0;
  for (const primitive of placeSectionPrimitives(section)) {
    if (primitive.vertices) {
      for (const vertex of primitive.vertices) maximum = Math.max(maximum, Math.hypot(vertex.x, vertex.y));
    } else {
      const { shape } = primitive;
      if (shape.kind === 'circle') maximum = Math.max(maximum, shape.radius);
      else if (shape.kind === 'ellipse') maximum = Math.max(maximum, shape.majorRadius);
    }
  }
  return maximum;
}

// 断面の内接円半径 [m]。断面の座標原点から輪郭までの最短距離であり、外皮の肉厚を測る向きを決める
// (§10-3 の薄肉圧力容器の式が要求する肉厚は、面に垂直な向きの厚みである)。
export function inradius(section: CrossSection): number {
  const outline = sectionOutline(section);
  let minimum = Infinity;
  for (let i = 0; i < outline.length; i++) {
    minimum = Math.min(minimum, segmentDistance(outline[i]!, outline[(i + 1) % outline.length]!));
  }
  return minimum;
}

// 原点から線分までの距離。
function segmentDistance(p0: Vec2, p1: Vec2): number {
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq > 0 ? Math.min(1, Math.max(0, -(p0.x * dx + p0.y * dy) / lengthSq)) : 0;
  return Math.hypot(p0.x + dx * t, p0.y + dy * t);
}

// ---------------------------------------------------------------------------
// 検証
// ---------------------------------------------------------------------------

// ツリーの不正を洗い出して、人が読める形で返す。空配列なら正しい。
export function validateTree(tree: VesselTree): readonly string[] {
  const issues: string[] = [];
  const seenNodes = new Set<string>();
  for (const node of tree.nodes) {
    if (seenNodes.has(node.id)) issues.push(`node id "${node.id}" is used twice`);
    seenNodes.add(node.id);
    if (!(len(node.axis) > 0)) issues.push(`node "${node.id}" has a zero axis`);
  }

  const seenEdges = new Set<string>();
  const occupied = new Map<string, string>();
  for (const edge of tree.edges) {
    if (seenEdges.has(edge.id)) issues.push(`edge id "${edge.id}" is used twice`);
    seenEdges.add(edge.id);
    if (!seenNodes.has(edge.a) || !seenNodes.has(edge.b)) {
      issues.push(`edge "${edge.id}" refers to an unknown node`);
      continue;
    }
    if (edge.a === edge.b) issues.push(`edge "${edge.id}" starts and ends at the same node`);
    if (edge.length < MIN_EDGE_LENGTH - QUANTIZATION_TOLERANCE) {
      issues.push(`edge "${edge.id}" is shorter than ${MIN_EDGE_LENGTH} m`);
    }
    if (Math.abs(edge.length / DIMENSION_UNIT - Math.round(edge.length / DIMENSION_UNIT)) > QUANTIZATION_TOLERANCE) {
      issues.push(`edge "${edge.id}" length ${edge.length} is not a multiple of ${DIMENSION_UNIT} m`);
    }
    for (const [nodeId, port] of [[edge.a, edge.portA], [edge.b, edge.portB]] as const) {
      const key = portKey(nodeId, port);
      const taken = occupied.get(key);
      if (taken) issues.push(`port ${key} is taken by both edge "${taken}" and edge "${edge.id}"`);
      occupied.set(key, edge.id);
    }
    const spanned = portSpan(tree, edge);
    if (spanned !== null && Math.abs(spanned - edge.length) > edge.length * LENGTH_TOLERANCE_RATIO) {
      issues.push(
        `edge "${edge.id}" declares length ${edge.length} but its ports are ${spanned.toFixed(6)} m apart`,
      );
    }
  }
  return issues;
}

// エッジの両端の口の中心の距離 [m]。口の解決に失敗したら null。
function portSpan(tree: VesselTree, edge: TreeEdge): number | null {
  try {
    const from = portFrame(nodeById(tree, edge.a), edge.portA).origin;
    const to = portFrame(nodeById(tree, edge.b), edge.portB).origin;
    return len(sub(to, from));
  } catch {
    return null;
  }
}

// 口を一意に指す文字列。エッジと外装要素の排他を判定する鍵になる。
export function portKey(nodeId: string, port: PortRef): string {
  return port.kind === 'axial'
    ? `${nodeId}/axial${port.sign > 0 ? '+' : '-'}`
    : `${nodeId}/${port.primitiveId}#${port.faceIndex}`;
}
