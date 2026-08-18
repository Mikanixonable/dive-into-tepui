// 既定の設計の形状ツリーと搭載要素の配置。機体の前後は +Z が機首、左右が ±X、上下が ±Y である。
//
// ノードの位置は、親ノードの接続口のローカル座標系から辿って決める。閉路のある構造では位置を
// エッジの長さから一意に解けないため、位置はツリーの持ち物であり、validateTree がエッジの長さとの
// 一致を確かめる。

import { Vec3, add, scale, v3 } from '../../physics/vec3';
import type { CrossSection } from '../../physics/section-moments';
import type { AnyPart, ExteriorPartType, PartType } from '../game-entity/parts';
import type { PartPlacement, VesselAssembly } from './assembly';
import type { EdgeKind, PortRef, TreeEdge, TreeNode, VesselTree } from './tree';
import { portFrame } from './tree';
import { baseParts, crewedParts, hostileParts } from './vessel-parts';

// 外装として機体の外側に取り付ける搭載要素の種別。これ以外は内容積に収める。
const EXTERIOR_TYPES: ReadonlySet<PartType> = new Set<ExteriorPartType>([
  'weapon', 'engine', 'rcs_thruster', 'solar_panel', 'radiator',
  'combat_shield', 'heat_shield', 'communication', 'robot_arm',
  'docking_port', 'container_coupling',
]);

// 断面を組み立てる小さな入口。既定の設計はいずれも単一の基本断面で足りる。
function polygon(sides: 3 | 4 | 5 | 6 | 8, radius: number, phaseAngle = 0): CrossSection {
  return { primitives: [{ id: 'p0', shape: { kind: 'polygon', sides, radius }, phaseAngle, attachment: null }] };
}

function notched(sides: 6 | 8, radius: number, phaseAngle = 0): CrossSection {
  return { primitives: [{ id: 'p0', shape: { kind: 'notched', sides, radius }, phaseAngle, attachment: null }] };
}

const AXIAL_FORE: PortRef = { kind: 'axial', sign: 1 };
const AXIAL_AFT: PortRef = { kind: 'axial', sign: -1 };

function lateral(faceIndex: number): PortRef {
  return { kind: 'lateral', primitiveId: 'p0', faceIndex };
}

// ツリーを組み立てながら、子ノードの位置を親の接続口から導く器。
class TreeBuilder {
  private readonly nodes: TreeNode[] = [];
  private readonly edges: TreeEdge[] = [];

  public root(id: string, pos: Vec3, section: CrossSection, axis: Vec3 = v3(0, 0, 1)): TreeNode {
    const node: TreeNode = { id, pos, section, axis, phaseAngle: 0 };
    this.nodes.push(node);
    return node;
  }

  // from の port から length だけ伸ばした先に子ノードを置き、両者をエッジでつなぐ。
  public extend(
    from: TreeNode,
    port: PortRef,
    edgeId: string,
    kind: EdgeKind,
    length: number,
    section: CrossSection,
    childId: string,
  ): TreeNode {
    const frame = portFrame(from, port);
    const child: TreeNode = {
      id: childId,
      pos: add(frame.origin, scale(frame.z, length)),
      section,
      axis: frame.z,
      phaseAngle: 0,
    };
    this.nodes.push(child);
    this.edges.push({ id: edgeId, a: from.id, b: child.id, portA: port, portB: AXIAL_AFT, length, kind });
    return child;
  }

  public tree(): VesselTree {
    return { nodes: this.nodes, edges: this.edges };
  }
}

// 搭載要素を、外装なら取り付け位置に、内装ならエッジに割り振る。type ごとに置き場が決まるので、
// 設計ごとに一覧を書き下ろす必要はない。
function place(
  parts: readonly AnyPart[],
  mountOf: (part: AnyPart, index: number) => PartPlacement,
): readonly PartPlacement[] {
  return parts.map(mountOf);
}

function isExterior(part: AnyPart): boolean {
  return EXTERIOR_TYPES.has(part.type);
}

// ---------------------------------------------------------------------------
// 有人の艦艇
// ---------------------------------------------------------------------------

// 機首の八角形断面から後方へ機器区画・与圧区画・推進剤区画と続き、中央のノードの左右へトラスが
// 伸びて放熱板と太陽電池パドルを持つ。左右のトラスだけが x 軸方向に張り出すので、3軸の慣性
// モーメントが互いに異なる — 中間軸不安定性が現れる形状である。
export function crewedAssembly(maxHp: number): VesselAssembly {
  const builder = new TreeBuilder();
  const nose = builder.root('nose', v3(0, 0, 2.25), polygon(8, 0.8));
  const fore = builder.extend(nose, AXIAL_AFT, 'fore', { kind: 'hull' }, 1.5, notched(8, 1.25), 'fore-node');
  const mid = builder.extend(fore, AXIAL_FORE, 'mid', { kind: 'hull' }, 1.5, notched(8, 1.25), 'mid-node');
  builder.extend(mid, AXIAL_FORE, 'aft', { kind: 'hull' }, 1.5, polygon(8, 1.0), 'tail');
  // 左右のトラス。放熱板と太陽電池パドルはここに並ぶ(§8-1)。
  const trussKind: EdgeKind = { kind: 'truss', sectionSize: 0.5 };
  builder.extend(mid, lateral(0), 'truss-l', trussKind, 2.5, polygon(4, 0.25), 'truss-l-tip');
  builder.extend(mid, lateral(4), 'truss-r', trussKind, 2.5, polygon(4, 0.25), 'truss-r-tip');

  const tree = builder.tree();
  const parts = crewedParts(maxHp);
  let trussSide = 0;
  const placements = place(parts, (part) => {
    if (!isExterior(part)) return { kind: 'internal', part, edgeIds: internalEdgesFor(part.type) };
    if (part.type === 'radiator' || part.type === 'solar_panel') {
      // 放熱板と太陽電池パドルは左右のトラスへ交互に振り、パドルはより外側に置く。
      const edgeId = trussSide++ % 2 === 0 ? 'truss-l' : 'truss-r';
      const along = part.type === 'solar_panel' ? 2 : 1;
      return { kind: 'external', part, mount: { kind: 'truss', edgeId, along, around: 0 } };
    }
    if (part.type === 'engine') {
      return { kind: 'external', part, mount: { kind: 'port', nodeId: 'tail', port: AXIAL_FORE } };
    }
    if (part.type === 'weapon') {
      return { kind: 'external', part, mount: { kind: 'port', nodeId: 'nose', port: AXIAL_FORE } };
    }
    // RCS スラスタと通信機は外皮の表面に付く。重心から離すほど大きなトルクが得られる(§8-3)。
    const along = part.type === 'rcs_thruster' ? 1 : 0.5;
    return { kind: 'external', part, mount: { kind: 'surface', edgeId: 'fore', along, around: Math.PI / 2 } };
  });
  return { tree, placements };
}

// 内装要素を収めるエッジ。与圧区画は機首側、推進剤と機器は後方に置く。
function internalEdgesFor(type: PartType): readonly string[] {
  if (type === 'hull' || type === 'armor') return ['fore', 'mid', 'aft'];
  if (type === 'cockpit' || type === 'life_support') return ['fore', 'mid'];
  if (type === 'rcs_tank') return ['aft'];
  return ['mid'];
}

// ---------------------------------------------------------------------------
// 軌道基地
// ---------------------------------------------------------------------------

// 中央の与圧モジュールから前後へ区画が伸び、左右へ太陽電池パドルを載せる長いトラスが張り出す。
export function orbitalBaseAssembly(maxHp: number): VesselAssembly {
  const builder = new TreeBuilder();
  const core = builder.root('core', v3(0, 0, 0), polygon(8, 12));
  const fore = builder.extend(core, AXIAL_FORE, 'fore', { kind: 'hull' }, 20, polygon(8, 12), 'fore-node');
  builder.extend(fore, AXIAL_FORE, 'nose', { kind: 'hull' }, 20, polygon(8, 6), 'nose-node');
  builder.extend(core, AXIAL_AFT, 'aft', { kind: 'hull' }, 20, polygon(8, 8), 'tail');
  const trussKind: EdgeKind = { kind: 'truss', sectionSize: 3 };
  builder.extend(core, lateral(0), 'truss-l', trussKind, 60, polygon(4, 1.5), 'truss-l-tip');
  builder.extend(core, lateral(4), 'truss-r', trussKind, 60, polygon(4, 1.5), 'truss-r-tip');

  const tree = builder.tree();
  const placements = place(baseParts(maxHp), (part) => {
    if (!isExterior(part)) {
      const spread = part.type === 'hull' || part.type === 'armor';
      const edgeIds = spread ? ['fore', 'nose', 'aft'] : part.type === 'rcs_tank' ? ['aft'] : ['fore'];
      return { kind: 'internal', part, edgeIds };
    }
    if (part.type === 'engine') {
      return { kind: 'external', part, mount: { kind: 'port', nodeId: 'tail', port: AXIAL_FORE } };
    }
    return { kind: 'external', part, mount: { kind: 'truss', edgeId: 'truss-l', along: 30, around: 0 } };
  });
  return { tree, placements };
}

// ---------------------------------------------------------------------------
// 無人の敵対機
// ---------------------------------------------------------------------------

// 六角形断面の胴体1本に主機と砲を付けただけの単純な機体。
export function hostileAssembly(maxHp: number): VesselAssembly {
  const builder = new TreeBuilder();
  const nose = builder.root('nose', v3(0, 0, 5), polygon(6, 1.5));
  const mid = builder.extend(nose, AXIAL_AFT, 'fore', { kind: 'hull' }, 5, polygon(6, 2.5), 'mid-node');
  builder.extend(mid, AXIAL_FORE, 'aft', { kind: 'hull' }, 5, polygon(6, 2), 'tail');

  const tree = builder.tree();
  const placements = place(hostileParts(maxHp), (part) => {
    if (!isExterior(part)) {
      const spread = part.type === 'hull' || part.type === 'armor';
      return { kind: 'internal', part, edgeIds: spread ? ['fore', 'aft'] : ['fore'] };
    }
    if (part.type === 'engine') {
      return { kind: 'external', part, mount: { kind: 'port', nodeId: 'tail', port: AXIAL_FORE } };
    }
    return { kind: 'external', part, mount: { kind: 'port', nodeId: 'nose', port: AXIAL_FORE } };
  });
  return { tree, placements };
}
