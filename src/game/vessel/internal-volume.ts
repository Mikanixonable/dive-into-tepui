// hull エッジの内容積の割り当て(§12)。エッジのロフト体積が上限で、1つのエッジに複数の内装要素を
// 収めてよく、その体積の和が上限を超えてはならない。内装要素が複数のエッジをまたげるのは、軸方向に
// 連なるエッジ同士が断面を共有して内容積が連続するためである(§8-4)。側面から分岐したエッジの
// 内容積は母体と連続しないので、またぐ配置は不正になる。

import { Vec3, add, scale, v3 } from '../../physics/vec3';
import { loftCenterOfMass, loftVolume } from '../../physics/hull-loft';
import type { AnyPart, InteriorPartType, StructuralPartType } from '../game-entity/parts';
import { isMainPropellantTank } from '../game-entity/parts';
import type { VesselTree, TreeEdge } from './tree';
import { edgeById, edgeFrame, nodeById, portOf } from './tree';

// 極低温で貯蔵する推進剤。断熱材のぶん実効容積が減る。
const CRYOGENIC_PROPELLANTS: ReadonlySet<string> = new Set([
  'liquid-hydrogen', 'liquid-oxygen', 'liquid-methane', 'silane',
]);

// 内装要素の種別ごとの実効容積の係数(§12)。推進剤タンクは貯蔵温度で変わるため、ここでは常温側の値を
// 置き、effectiveVolumeFactor が極低温の推進剤を見て差し替える。主要構造と装甲は外皮に付くもので
// 容積を占めないため、係数は 1 に置いて容積の取り合いから外れる。
const EFFECTIVE_VOLUME_FACTOR: Readonly<Record<InteriorPartType | StructuralPartType, number>> = {
  hull: 1,
  armor: 1,
  oxidizer_tank: 0.95,
  reductant_tank: 0.95,
  pressurant_tank: 0.55,
  rcs_tank: 0.95,
  water_tank: 0.95,
  payload_bay: 0.9,
  magazine: 0.9,
  cockpit: 0.8,
  farm: 0.85,
  life_support: 0.85,
  base_module: 0.85,
  dock: 0.85,
  battery: 1,
  fuel_cell: 1,
  rtg: 1,
  autopilot: 1,
  flywheel: 1,
  magnetorquer: 1,
  ammunition: 1,
  plumbing: 1,
};

// 極低温タンクの実効容積の係数。
const CRYOGENIC_VOLUME_FACTOR = 0.85;

// 内装要素の実効容積の係数。占める容積をこの値で割ったものが、要する内容積になる。
// 極低温側の差し替えは主機タンク(酸化剤・還元剤)だけが対象 — RCS タンクは
// EFFECTIVE_VOLUME_FACTOR の表からそのまま引く別扱いなので、isMainPropellantTank を使う。
export function effectiveVolumeFactor(part: AnyPart): number {
  if (isMainPropellantTank(part) && CRYOGENIC_PROPELLANTS.has(part.propellant)) {
    return CRYOGENIC_VOLUME_FACTOR;
  }
  const factor = EFFECTIVE_VOLUME_FACTOR[part.type as InteriorPartType | StructuralPartType];
  if (factor === undefined) throw new Error(`part type "${part.type}" does not occupy internal volume`);
  return factor;
}

// 内装要素そのものが占める容積 [m³]。容積を性能値として持たない要素は 0 を返す — 質量としては
// 数えるが、内容積の取り合いには加わらない。配管だけはエッジの長さに比例するので、ここでは
// 単位長さあたりの断面積を返し、grossVolumeOf がエッジの長さを掛ける。
export function occupiedVolumeOf(part: AnyPart): number {
  switch (part.type) {
    case 'oxidizer_tank':
    case 'reductant_tank':
    case 'pressurant_tank':
    case 'rcs_tank':
    case 'water_tank':
    case 'payload_bay':
      return part.volume;
    case 'cockpit':
      return part.pressurizedVolume;
    default:
      return 0;
  }
}

// hull エッジの内容積 [m³]。トラスと分離機構は外皮を持たないので 0。
export function edgeInternalVolume(tree: VesselTree, edge: TreeEdge): number {
  if (edge.kind.kind !== 'hull') return 0;
  return loftVolume(nodeById(tree, edge.a).section, nodeById(tree, edge.b).section, edge.length);
}

// hull エッジの内容積の重心。船体ローカル座標。
export function edgeVolumeCentroid(tree: VesselTree, edge: TreeEdge): Vec3 {
  const frame = edgeFrame(tree, edge);
  const local = loftCenterOfMass(nodeById(tree, edge.a).section, nodeById(tree, edge.b).section, edge.length);
  return add(
    frame.origin,
    add(add(scale(frame.x, local.x), scale(frame.y, local.y)), scale(frame.z, local.z)),
  );
}

// 内装要素1つの配置。
export interface InternalPlacement {
  readonly part: AnyPart;
  readonly edgeIds: readonly string[];
}

// 割り当ての結果1件。
export interface VolumeAllocation {
  readonly partId: string;
  readonly edgeIds: readonly string[];
  // 要素が占める容積 [m³]。
  readonly occupiedVolume: number;
  // それを収めるのに要する内容積 [m³]。実効容積の係数で割ったもの。
  readonly grossVolume: number;
  // 収めたエッジの内容積の、体積で重み付けした重心。船体ローカル座標。
  readonly centroid: Vec3;
}

// 割り当てを解いて、要素ごとの容積と重心を返す。連なっていないエッジをまたぐ配置と、エッジの
// 内容積を超える配置には例外を投げる。
export function allocateInternalVolume(
  tree: VesselTree,
  placements: readonly InternalPlacement[],
): readonly VolumeAllocation[] {
  const capacity = new Map<string, number>();
  for (const edge of tree.edges) capacity.set(edge.id, edgeInternalVolume(tree, edge));

  const demandByEdge = new Map<string, number>();
  const allocations: VolumeAllocation[] = [];
  for (const placement of placements) {
    if (placement.edgeIds.length === 0) {
      throw new Error(`part "${placement.part.id}" is placed in no edge`);
    }
    requireAxiallyContiguous(tree, placement.edgeIds);
    const volumes = placement.edgeIds.map((id) => capacity.get(id) ?? unknownEdge(id));
    const total = volumes.reduce((sum, v) => sum + v, 0);
    if (!(total > 0)) {
      throw new Error(`part "${placement.part.id}" is placed in edges that hold no internal volume`);
    }
    const occupiedVolume = grossOccupiedVolume(tree, placement);
    const grossVolume = occupiedVolume / effectiveVolumeFactor(placement.part);
    // エッジごとの取り分は、そのエッジの内容積の比で分ける。
    let centroid = v3();
    for (let i = 0; i < placement.edgeIds.length; i++) {
      const edgeId = placement.edgeIds[i]!;
      const share = volumes[i]! / total;
      demandByEdge.set(edgeId, (demandByEdge.get(edgeId) ?? 0) + grossVolume * share);
      centroid = add(centroid, scale(edgeVolumeCentroid(tree, edgeById(tree, edgeId)), share));
    }
    allocations.push({ partId: placement.part.id, edgeIds: placement.edgeIds, occupiedVolume, grossVolume, centroid });
  }

  for (const [edgeId, demand] of demandByEdge) {
    const available = capacity.get(edgeId)!;
    if (demand > available * (1 + 1e-9)) {
      throw new Error(
        `edge "${edgeId}" holds ${available.toFixed(3)} m³ but ${demand.toFixed(3)} m³ is assigned to it`,
      );
    }
  }
  return allocations;
}

function unknownEdge(id: string): never {
  throw new Error(`unknown edge "${id}"`);
}

// 配管はエッジの長さに比例して容積を占めるので、口径の断面積に配置したエッジの長さの和を掛ける。
export function grossOccupiedVolume(tree: VesselTree, placement: InternalPlacement): number {
  const { part } = placement;
  if (part.type !== 'plumbing') return occupiedVolumeOf(part);
  const bore = Math.PI * (part.bore / 2) ** 2;
  return placement.edgeIds.reduce((sum, id) => sum + bore * edgeById(tree, id).length, 0);
}

// エッジ列が軸方向に連なっていることを確かめ、連なっていなければ例外を投げる。
function requireAxiallyContiguous(tree: VesselTree, edgeIds: readonly string[]): void {
  if (!axiallyContiguous(tree, edgeIds)) {
    throw new Error(`edges ${edgeIds.join(', ')} are not axially contiguous`);
  }
}

// エッジ列が軸方向に連なっているか。連なるとは、2本が同じノードで出会い、両方がその
// ノードの軸方向の口に付いていることをいう。参照できないエッジがあれば例外を投げる。
export function axiallyContiguous(tree: VesselTree, edgeIds: readonly string[]): boolean {
  if (edgeIds.length < 2) {
    edgeById(tree, edgeIds[0]!);
    return true;
  }
  const edges = edgeIds.map((id) => edgeById(tree, id));
  const reached = new Set<string>([edges[0]!.id]);
  for (let grew = true; grew;) {
    grew = false;
    for (const edge of edges) {
      if (reached.has(edge.id)) continue;
      if (edges.some((other) => reached.has(other.id) && axiallyJoined(other, edge))) {
        reached.add(edge.id);
        grew = true;
      }
    }
  }
  return reached.size === edges.length;
}

// 2本のエッジが、共有するノードの軸方向の口同士で出会っているか。
function axiallyJoined(a: TreeEdge, b: TreeEdge): boolean {
  for (const nodeId of [a.a, a.b]) {
    if (b.a !== nodeId && b.b !== nodeId) continue;
    if (portOf(a, nodeId).kind === 'axial' && portOf(b, nodeId).kind === 'axial') return true;
  }
  return false;
}
