// 設計の検証(§4-2)。ドック空間の表示と生産の両方がこの関数を呼ぶので、DOM にも THREE にも
// 依存しない純関数として書く。返す診断は、設計そのものが成り立つかどうかだけを述べる —
// 生産に要る資源と設備が揃っているかは producibility が別に答える。

import { cross, dot, len, norm, scale, sub, v3, add } from '../../physics/vec3';
import * as C from '../const';
import type { Vec3 } from '../../physics/vec3';
import type { Vec2 } from '../../physics/section-moments';
import { PORT_WIDTH_RATIO, placeSectionPrimitives, portHalfAngle } from '../../physics/section-moments';
import { sectionOutline } from '../../physics/hull-loft';
import { TANK_MATERIALS } from '../economy/propellant-compatibility';
import type { PartType } from '../game-entity/parts';
import { isMainPropellantTank, isPropellantTankPart } from '../game-entity/parts';
import type { PartPlacement } from './assembly';
import type { MountPoint, PortRef, TreeEdge, TreeNode, VesselTree } from './tree';
import { portOwners } from './port-occupancy';
import {
  DIMENSION_UNIT, circumradius, edgeById, mountFrame, nodeBasis, nodeById, portFrame, portKey,
  validateTree,
} from './tree';
import {
  axiallyContiguous, edgeInternalVolume, effectiveVolumeFactor, grossOccupiedVolume,
} from './internal-volume';
import { deriveMassProperties } from './mass-properties';
import type { VesselBlueprint } from './blueprint';
import { assemblyOf } from './blueprint';
import { PartInventory } from './part-inventory';
import type { ActuatorSet } from '../../physics/attitude-control';
import { allocateControl } from '../../physics/attitude-control';
import { actuatorSetOf } from './actuator-set';
import type { AnyPart } from '../game-entity/parts';

export interface BlueprintIssue {
  readonly severity: 'error' | 'warning';
  readonly targetId: string; // ノード/エッジ/搭載要素の id。機体全体にかかる指摘では空文字
  readonly message: string;
}

// 機体全体にかかる指摘の targetId。特定の部位を指せない診断がここに集まる。
export const WHOLE_VESSEL = '';

// 設計の上限(§4-2)。ドックの寸法など、外から決まる上限を差し替えられるように引数で受け取る。
export interface BlueprintLimits {
  readonly maxNodes: number;
  readonly maxMass: number; // kg
  readonly maxDimension: number; // m
  readonly maxSectionPrimitives: number; // 複合断面1つあたりの構成要素数
}

export const DEFAULT_BLUEPRINT_LIMITS: BlueprintLimits = {
  maxNodes: 256,
  maxMass: 2e6,
  maxDimension: 120,
  maxSectionPrimitives: 8,
};

// 推力軸が重心から外れてよい距離を、機体の最大寸法に対する比で与える。これを超えるとジンバルで
// 補いきれず制御不能になる(§21-9)。半分を超えた時点で警告に出す。
const THRUST_OFFSET_ERROR_RATIO = 0.05;

// 自己加圧できる推進剤。極低温の推進剤は自身の蒸発でタンク圧を保てるので、加圧ガスを要さない。
const SELF_PRESSURIZING_PROPELLANTS: ReadonlySet<string> = new Set([
  'liquid-hydrogen', 'liquid-oxygen', 'liquid-methane', 'silane',
]);

// 熱シールドが同時に覆えるとみなす向きの開き [rad]。これを超えて散らばる向きを覆う姿勢は取れない。
const HEAT_SHIELD_SPREAD = Math.PI / 2;

// 取り付け座が占める長さ [m]。搭載要素は外形寸法を性能値として持たないので、寸法の刻みを座の
// 大きさとみなす。板が張り出す先の広がりは座の取り合いに関わらない — 板は軸から外へ伸びる。
const MOUNT_FOOTPRINT = DIMENSION_UNIT;

function issue(severity: BlueprintIssue['severity'], targetId: string, message: string): BlueprintIssue {
  return { severity, targetId, message };
}

// 設計の不正を洗い出す。空配列なら、設計としては成り立っている。
export function validateBlueprint(
  bp: VesselBlueprint,
  limits: BlueprintLimits = DEFAULT_BLUEPRINT_LIMITS,
): readonly BlueprintIssue[] {
  const issues: BlueprintIssue[] = [];
  const { tree } = bp;

  for (const message of validateTree(tree)) issues.push(issue('error', WHOLE_VESSEL, message));
  checkSections(tree, limits, issues);
  // ツリーか断面が解けない設計では、以降の幾何がすべて例外になる。ここまでを報告して終える。
  if (issues.length > 0) return issues;

  checkConnected(tree, issues);
  checkPortExclusivity(bp, issues);
  checkRadiatorCount(bp, issues);
  checkLateralPortFit(tree, issues);
  checkAdjacentPortInterference(bp, issues);
  checkTrussCrowding(bp, issues);
  checkSurfaceRcsInterference(bp, issues);
  const volumeIssues = issues.length;
  checkInternalVolume(bp, issues);
  // 内容積が解けない設計では質量特性も解けない。推力軸と質量の上限はそこで打ち切る。
  const volumeResolved = issues.length === volumeIssues;
  checkTankMaterials(bp, issues);
  checkControl(bp, issues);
  checkFeedContinuity(bp, issues);
  checkPressurant(bp, issues);
  checkStages(bp, issues);
  checkHeatShields(bp, issues);
  if (volumeResolved) checkThrustAxis(bp, issues);
  checkPowerBudget(bp, issues);
  checkThermalBudget(bp, issues);
  if (volumeResolved) checkAttitudeControlAuthority(bp, issues);
  checkLimits(bp, limits, volumeResolved, issues);
  return issues;
}

// ---------------------------------------------------------------------------
// 配置の読み解き
// ---------------------------------------------------------------------------

function externals(bp: VesselBlueprint): readonly Extract<PartPlacement, { kind: 'external' }>[] {
  return bp.placements.filter((p): p is Extract<PartPlacement, { kind: 'external' }> => p.kind === 'external');
}

function internals(bp: VesselBlueprint): readonly Extract<PartPlacement, { kind: 'internal' }>[] {
  return bp.placements.filter((p): p is Extract<PartPlacement, { kind: 'internal' }> => p.kind === 'internal');
}

function hasPart(bp: VesselBlueprint, type: PartType): boolean {
  return bp.placements.some((p) => p.part.type === type);
}

// 取り付け位置が触れているノードの id。段や流路の連結を辿る足がかりになる。
function mountNodes(tree: VesselTree, mount: MountPoint): readonly string[] {
  if (mount.kind === 'port') return [mount.nodeId];
  const edge = edgeById(tree, mount.edgeId);
  return [edge.a, edge.b];
}

// ---------------------------------------------------------------------------
// ツリーと断面
// ---------------------------------------------------------------------------

// 複合断面が図形として解けること。貼り合わせ面の長さの不一致と基本断面の重なりは、
// placeSectionPrimitives が例外として述べる。
function checkSections(tree: VesselTree, limits: BlueprintLimits, issues: BlueprintIssue[]): void {
  for (const node of tree.nodes) {
    if (node.section.primitives.length > limits.maxSectionPrimitives) {
      issues.push(issue('error', node.id,
        `複合断面の構成要素が ${node.section.primitives.length} 個で、上限 ${limits.maxSectionPrimitives} 個を超えています`));
    }
    try {
      placeSectionPrimitives(node.section);
    } catch (error) {
      issues.push(issue('error', node.id, `断面が組めません: ${(error as Error).message}`));
    }
  }
}

function checkConnected(tree: VesselTree, issues: BlueprintIssue[]): void {
  if (tree.nodes.length === 0) {
    issues.push(issue('error', WHOLE_VESSEL, 'ノードが1つもありません'));
    return;
  }
  const reached = new Set<string>([tree.nodes[0]!.id]);
  for (let grew = true; grew;) {
    grew = false;
    for (const edge of tree.edges) {
      if (reached.has(edge.a) === reached.has(edge.b)) continue;
      reached.add(edge.a);
      reached.add(edge.b);
      grew = true;
    }
  }
  for (const node of tree.nodes) {
    if (!reached.has(node.id)) {
      issues.push(issue('error', node.id, 'このノードは機体の他の部分と繋がっていません'));
    }
  }
}

// 1つの接続口に、エッジと外装要素が同時に割り当てられていないこと。エッジ同士の重複は
// validateTree が見るので、ここではエッジと外装要素、および外装要素同士を見る。
function checkPortExclusivity(bp: VesselBlueprint, issues: BlueprintIssue[]): void {
  for (const placement of externals(bp)) {
    if (placement.mount.kind !== 'port') continue;
    const key = portKey(placement.mount.nodeId, placement.mount.port);
    const owner = portOwners(bp, undefined, placement.part.id).get(key);
    if (owner === undefined) continue;
    if (owner.kind === 'edge') {
      issues.push(issue('error', placement.part.id,
        `接続口 ${key} はエッジ "${owner.id}" が使っているので、外装要素を取り付けられません`));
    } else {
      issues.push(issue('error', placement.part.id, `接続口 ${key} は "${owner.id}" が既に使っています`));
    }
  }
}

// 放熱板は機体の左右2枚しか置き場が無い(hull-mesh.ts の PanelSides)。
const MAX_RADIATOR_COUNT = 2;

// 放熱板の搭載数が MAX_RADIATOR_COUNT 以内であること。超える枚数は、メッシュ・接触代理・HUD の
// どれもが片側に重複してしまう。
function checkRadiatorCount(bp: VesselBlueprint, issues: BlueprintIssue[]): void {
  const radiators = externals(bp).filter((p) => p.part.type === 'radiator');
  if (radiators.length <= MAX_RADIATOR_COUNT) return;
  for (const placement of radiators) {
    issues.push(issue('error', placement.part.id,
      `放熱板は最大 ${MAX_RADIATOR_COUNT} 枚までです(${radiators.length} 枚積んでいます)`));
  }
}

// 側面の口の開口。size は周方向にも軸方向にも同じで、母断面の外接円半径に PORT_WIDTH_RATIO を
// 掛けたもの — 円断面が切り落とす弦の長さを与えているのと同じ寸法である。ends は開口が断面の上で
// 占める線分の両端で、辺より広い開口は辺からはみ出して隣の口とぶつかる。
interface PortOpening {
  readonly size: number;
  readonly ends: readonly [Vec2, Vec2];
}

function portOpening(node: TreeNode, port: Extract<PortRef, { kind: 'lateral' }>): PortOpening {
  const size = PORT_WIDTH_RATIO * circumradius(node.section);
  const primitive = placeSectionPrimitives(node.section).find((p) => p.id === port.primitiveId);
  if (!primitive) throw new Error(`unknown primitive "${port.primitiveId}"`);
  if (!primitive.vertices) {
    const { shape, phaseAngle } = primitive;
    const count = shape.kind === 'circle' ? shape.branchCount : 2;
    const radius = shape.kind === 'circle' ? shape.radius
      : shape.kind === 'ellipse' ? shape.majorRadius : 0;
    const center = phaseAngle + (2 * Math.PI * (port.faceIndex % count)) / count;
    const half = portHalfAngle();
    return {
      size,
      ends: [
        { x: radius * Math.cos(center - half), y: radius * Math.sin(center - half) },
        { x: radius * Math.cos(center + half), y: radius * Math.sin(center + half) },
      ],
    };
  }
  const p0 = primitive.vertices[port.faceIndex % primitive.vertices.length]!;
  const p1 = primitive.vertices[(port.faceIndex + 1) % primitive.vertices.length]!;
  const length = Math.hypot(p1.x - p0.x, p1.y - p0.y);
  const mid = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
  const along = { x: (p1.x - p0.x) / length, y: (p1.y - p0.y) / length };
  return {
    size,
    ends: [
      { x: mid.x - (along.x * size) / 2, y: mid.y - (along.y * size) / 2 },
      { x: mid.x + (along.x * size) / 2, y: mid.y + (along.y * size) / 2 },
    ],
  };
}

// 側面の口から出るエッジの断面が、口の周方向・軸方向の両方の寸法に収まること。エッジの断面は
// 反対側のノードの断面であり、その輪郭を口の座標系へ写して差し渡しを測る。
function checkLateralPortFit(tree: VesselTree, issues: BlueprintIssue[]): void {
  for (const edge of tree.edges) {
    for (const [nearId, port, farId] of [
      [edge.a, edge.portA, edge.b],
      [edge.b, edge.portB, edge.a],
    ] as const) {
      if (port.kind !== 'lateral') continue;
      const near = nodeById(tree, nearId);
      const far = nodeById(tree, farId);
      const opening = portOpening(near, port);
      const frame = portFrame(near, port);
      const farBasis = nodeBasis(far);
      let halfAlong = 0;
      let halfAxial = 0;
      for (const point of sectionOutline(far.section)) {
        const world = add(farBasis.origin, add(scale(farBasis.x, point.x), scale(farBasis.y, point.y)));
        const offset = sub(world, frame.origin);
        halfAlong = Math.max(halfAlong, Math.abs(dot(offset, frame.y)));
        halfAxial = Math.max(halfAxial, Math.abs(dot(offset, frame.x)));
      }
      if (2 * halfAlong > opening.size * (1 + 1e-9)) {
        issues.push(issue('error', edge.id,
          `側面の口の周方向の幅 ${opening.size.toFixed(3)} m に対し、断面が ${(2 * halfAlong).toFixed(3)} m あります`));
      }
      if (2 * halfAxial > opening.size * (1 + 1e-9)) {
        issues.push(issue('error', edge.id,
          `側面の口の軸方向の幅 ${opening.size.toFixed(3)} m に対し、断面が ${(2 * halfAxial).toFixed(3)} m あります`));
      }
    }
  }
}

function crossZ(o: Vec2, a: Vec2, b: Vec2): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

// 2つの線分が端点以外で交わるか。同じ円の上に取った2つの弦は、弧が重なるときにだけ交わる。
function segmentsCross(s: readonly [Vec2, Vec2], t: readonly [Vec2, Vec2]): boolean {
  const d1 = crossZ(s[0], s[1], t[0]);
  const d2 = crossZ(s[0], s[1], t[1]);
  const d3 = crossZ(t[0], t[1], s[0]);
  const d4 = crossZ(t[0], t[1], s[1]);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

// 隣接する側面の口が干渉しないこと。使われている口だけを見る — 使わない口が近くにあっても
// 何も起きない。
function checkAdjacentPortInterference(bp: VesselBlueprint, issues: BlueprintIssue[]): void {
  const usedByNode = new Map<string, { readonly port: Extract<PortRef, { kind: 'lateral' }>; readonly owner: string }[]>();
  const remember = (nodeId: string, port: PortRef, owner: string): void => {
    if (port.kind !== 'lateral') return;
    const list = usedByNode.get(nodeId) ?? [];
    list.push({ port, owner });
    usedByNode.set(nodeId, list);
  };
  for (const edge of bp.tree.edges) {
    remember(edge.a, edge.portA, edge.id);
    remember(edge.b, edge.portB, edge.id);
  }
  for (const placement of externals(bp)) {
    if (placement.mount.kind === 'port') remember(placement.mount.nodeId, placement.mount.port, placement.part.id);
  }

  for (const [nodeId, used] of usedByNode) {
    const node = nodeById(bp.tree, nodeId);
    for (let i = 0; i < used.length; i++) {
      for (let j = i + 1; j < used.length; j++) {
        const a = used[i]!;
        const b = used[j]!;
        if (!segmentsCross(portOpening(node, a.port).ends, portOpening(node, b.port).ends)) continue;
        issues.push(issue('error', nodeId, `側面の口 "${a.owner}" と "${b.owner}" が断面の上で重なっています`));
      }
    }
  }
}

// トラスに取り付けた外装要素どうしが、軸に沿って重なっていないこと。
function checkTrussCrowding(bp: VesselBlueprint, issues: BlueprintIssue[]): void {
  const byEdge = new Map<string, { readonly along: number; readonly half: number; readonly id: string }[]>();
  for (const placement of externals(bp)) {
    if (placement.mount.kind !== 'truss') continue;
    const list = byEdge.get(placement.mount.edgeId) ?? [];
    list.push({ along: placement.mount.along, half: MOUNT_FOOTPRINT / 2, id: placement.part.id });
    byEdge.set(placement.mount.edgeId, list);
  }
  for (const [edgeId, mounted] of byEdge) {
    for (let i = 0; i < mounted.length; i++) {
      for (let j = i + 1; j < mounted.length; j++) {
        const a = mounted[i]!;
        const b = mounted[j]!;
        if (Math.abs(a.along - b.along) >= a.half + b.half - 1e-9) continue;
        issues.push(issue('error', edgeId, `トラス上で "${a.id}" と "${b.id}" が軸方向に重なっています`));
      }
    }
  }
}

// hull エッジの外表面に取り付けた RCS スラスタが、他の外装要素と干渉しないこと。
function checkSurfaceRcsInterference(bp: VesselBlueprint, issues: BlueprintIssue[]): void {
  const placed = externals(bp).map((placement) => ({
    id: placement.part.id,
    surfaceRcs: placement.part.type === 'rcs_thruster' && placement.mount.kind === 'surface',
    origin: mountFrame(bp.tree, placement.mount).origin,
    radius: MOUNT_FOOTPRINT / 2,
  }));
  for (let i = 0; i < placed.length; i++) {
    const a = placed[i]!;
    if (!a.surfaceRcs) continue;
    for (let j = 0; j < placed.length; j++) {
      if (i === j) continue;
      const b = placed[j]!;
      if (len(sub(a.origin, b.origin)) >= a.radius + b.radius - 1e-9) continue;
      issues.push(issue('error', a.id, `外表面の RCS スラスタが "${b.id}" と干渉しています`));
    }
  }
}

// 内容積の割り当てがロフト体積を超えないことと、内装要素がまたぐエッジが軸方向に連なっていること。
function checkInternalVolume(bp: VesselBlueprint, issues: BlueprintIssue[]): void {
  const capacity = new Map<string, number>();
  for (const edge of bp.tree.edges) capacity.set(edge.id, edgeInternalVolume(bp.tree, edge));
  const demand = new Map<string, number>();

  for (const placement of internals(bp)) {
    const { part, edgeIds } = placement;
    if (edgeIds.length === 0) {
      issues.push(issue('error', part.id, 'どのエッジにも収められていません'));
      continue;
    }
    if (edgeIds.some((id) => capacity.get(id) === undefined)) {
      issues.push(issue('error', part.id, '存在しないエッジに収められています'));
      continue;
    }
    if (!axiallyContiguous(bp.tree, edgeIds)) {
      issues.push(issue('error', part.id, `またいでいるエッジ ${edgeIds.join(', ')} が軸方向に連なっていません`));
      continue;
    }
    const volumes = edgeIds.map((id) => capacity.get(id)!);
    const total = volumes.reduce((sum, v) => sum + v, 0);
    if (!(total > 0)) {
      issues.push(issue('error', part.id, '内容積を持たないエッジに収められています'));
      continue;
    }
    const gross = grossOccupiedVolume(bp.tree, placement) / effectiveVolumeFactor(part);
    for (let i = 0; i < edgeIds.length; i++) {
      const id = edgeIds[i]!;
      demand.set(id, (demand.get(id) ?? 0) + (gross * volumes[i]!) / total);
    }
  }

  for (const [edgeId, required] of demand) {
    const available = capacity.get(edgeId)!;
    if (required <= available * (1 + 1e-9)) continue;
    issues.push(issue('error', edgeId,
      `内容積 ${available.toFixed(3)} m³ に対して ${required.toFixed(3)} m³ が割り当てられています`));
  }
}

// 推進剤とタンク材料が適合すること。
function checkTankMaterials(bp: VesselBlueprint, issues: BlueprintIssue[]): void {
  for (const placement of bp.placements) {
    const part = placement.part;
    if (!isPropellantTankPart(part)) continue;
    const compat = TANK_MATERIALS[part.propellant];
    if (compat === undefined) {
      issues.push(issue('error', part.id, `推進剤 "${part.propellant}" は登録されていません`));
      continue;
    }
    if ((compat.allowedMaterials as readonly string[]).includes(part.material)) continue;
    issues.push(issue('error', part.id,
      `${compat.name}のタンクに ${part.material} は使えません (使えるのは ${compat.allowedMaterials.join('/')})`));
  }
}

// コックピットまたは自動操縦装置を1つ以上持つこと。自動操縦だけの機体は通信モジュールを要する。
function checkControl(bp: VesselBlueprint, issues: BlueprintIssue[]): void {
  const cockpit = hasPart(bp, 'cockpit');
  const autopilot = hasPart(bp, 'autopilot');
  if (!cockpit && !autopilot) {
    issues.push(issue('error', WHOLE_VESSEL, 'コックピットも自動操縦装置もありません'));
    return;
  }
  if (!cockpit && !hasPart(bp, 'communication')) {
    issues.push(issue('error', WHOLE_VESSEL, '自動操縦装置だけの機体には通信モジュールが要ります'));
  }
}

// ノードを頂点、条件を満たすエッジを辺とする連結成分。同じ成分の頂点には同じ代表 id が付く。
function components(tree: VesselTree, accepts: (edge: TreeEdge) => boolean): ReadonlyMap<string, string> {
  const root = new Map<string, string>();
  for (const node of tree.nodes) root.set(node.id, node.id);
  const find = (id: string): string => {
    let current = id;
    for (let next = root.get(current)!; next !== current; next = root.get(current)!) current = next;
    return current;
  };
  for (const edge of tree.edges) {
    if (!accepts(edge)) continue;
    const a = find(edge.a);
    const b = find(edge.b);
    if (a !== b) root.set(a, b);
  }
  const result = new Map<string, string>();
  for (const node of tree.nodes) result.set(node.id, find(node.id));
  return result;
}

// タンクからエンジンまで、要求する推進剤ごとに配管が連続していること。配管を1つも積んでいない
// 設計は自動敷設に委ねられている段階なので、ここでは判定しない。
function checkFeedContinuity(bp: VesselBlueprint, issues: BlueprintIssue[]): void {
  const plumbing = internals(bp).filter((p) => p.part.type === 'plumbing');
  if (plumbing.length === 0) return;

  for (const placement of externals(bp)) {
    const part = placement.part;
    if (part.type !== 'engine') continue;
    const carrying = new Set(
      plumbing.filter((p) => p.part.type === 'plumbing' && p.part.propellant === part.propellant)
        .flatMap((p) => p.edgeIds),
    );
    const reachable = components(bp.tree, (edge) => carrying.has(edge.id));
    const engineNodes = new Set(mountNodes(bp.tree, placement.mount).map((id) => reachable.get(id)));
    const fed = internals(bp).some((tank) => {
      const tankPart = tank.part;
      const isSource = isMainPropellantTank(tankPart) && tankPart.propellant === part.propellant;
      if (!isSource) return false;
      return tank.edgeIds.some((edgeId) => {
        const edge = bp.tree.edges.find((e) => e.id === edgeId);
        return edge !== undefined && (engineNodes.has(reachable.get(edge.a)) || engineNodes.has(reachable.get(edge.b)));
      });
    });
    if (!fed) {
      issues.push(issue('error', part.id, `推進剤 "${part.propellant}" のタンクからの配管が繋がっていません`));
    }
  }
}

// 加圧を要するエンジンに対し、加圧ガスの供給経路があるか、自己加圧の条件を満たすこと。
function checkPressurant(bp: VesselBlueprint, issues: BlueprintIssue[]): void {
  const pressurant = hasPart(bp, 'pressurant_tank');
  for (const placement of bp.placements) {
    const part = placement.part;
    if (part.type !== 'engine' || part.cycle !== 'pressure_fed') continue;
    if (pressurant || SELF_PRESSURIZING_PROPELLANTS.has(part.propellant)) continue;
    issues.push(issue('error', part.id, '加圧式のエンジンですが、加圧ガスタンクも自己加圧の条件もありません'));
  }
}

// 分離機構で切り離される段の境界と、段ごとの成立。武器と弾薬庫が同じ段に属すること。
function checkStages(bp: VesselBlueprint, issues: BlueprintIssue[]): void {
  for (const edgeId of bp.stageOrder) {
    const edge = bp.tree.edges.find((e) => e.id === edgeId);
    if (edge === undefined) {
      issues.push(issue('error', edgeId, '分離順が存在しないエッジを指しています'));
    } else if (edge.kind.kind !== 'decoupler') {
      issues.push(issue('error', edgeId, '分離順が分離機構ではないエッジを指しています'));
    }
  }

  const stageOf = components(bp.tree, (edge) => edge.kind.kind !== 'decoupler');
  const magazineStages = new Set(
    internals(bp).filter((p) => p.part.type === 'magazine')
      .flatMap((p) => p.edgeIds.map((id) => stageOf.get(edgeById(bp.tree, id).a))),
  );
  if (magazineStages.size === 0) return;
  for (const placement of externals(bp)) {
    if (placement.part.type !== 'weapon') continue;
    const stages = mountNodes(bp.tree, placement.mount).map((id) => stageOf.get(id));
    if (stages.some((stage) => magazineStages.has(stage))) continue;
    issues.push(issue('error', placement.part.id, '武器と同じ段に弾薬庫がありません'));
  }
}

// 熱シールドの覆う方向と、大気制動時の姿勢が矛盾しないこと。機体が同時に流れへ向けられるのは
// 1方向だけなので、覆う向きが開いて散らばっている設計は、どの姿勢でも守りきれない。
function checkHeatShields(bp: VesselBlueprint, issues: BlueprintIssue[]): void {
  const shields = externals(bp).filter((p) => p.part.type === 'heat_shield');
  for (let i = 0; i < shields.length; i++) {
    for (let j = i + 1; j < shields.length; j++) {
      const a = mountFrame(bp.tree, shields[i]!.mount).z;
      const b = mountFrame(bp.tree, shields[j]!.mount).z;
      if (Math.acos(Math.min(1, Math.max(-1, dot(norm(a), norm(b))))) <= HEAT_SHIELD_SPREAD) continue;
      issues.push(issue('error', shields[i]!.part.id,
        `熱シールド "${shields[j]!.part.id}" と覆う向きが開きすぎていて、同じ姿勢では両方を流れへ向けられません`));
    }
  }
}

// 機体の最大寸法 [m]。ノードの位置の差し渡しに、両端の断面の外接円半径を足したもの。
function overallDimension(tree: VesselTree): number {
  let maximum = 0;
  for (const a of tree.nodes) {
    const ra = circumradius(a.section);
    for (const b of tree.nodes) {
      maximum = Math.max(maximum, len(sub(a.pos, b.pos)) + ra + circumradius(b.section));
    }
  }
  return maximum;
}

// 推力軸と重心のずれが規定内であること。ずれは、合力を重心まわりのモーメントで割った腕の長さで測る。
function checkThrustAxis(bp: VesselBlueprint, issues: BlueprintIssue[]): void {
  let force = v3();
  let moment = v3();
  const arms: { readonly origin: Vec3; readonly force: Vec3 }[] = [];
  for (const placement of externals(bp)) {
    const part = placement.part;
    if (part.type !== 'engine' || !(part.thrust > 0)) continue;
    const frame = mountFrame(bp.tree, placement.mount);
    // 噴射は取り付け面の外向きへ出るので、推力はその逆を向く。
    const thrust = scale(norm(frame.z), -part.thrust);
    arms.push({ origin: frame.origin, force: thrust });
    force = add(force, thrust);
  }
  if (arms.length === 0 || !(len(force) > 0)) return;

  const com = deriveMassProperties(assemblyOf(bp)).centerOfMass;
  for (const arm of arms) moment = add(moment, cross(sub(arm.origin, com), arm.force));
  const offset = len(moment) / len(force);
  const limit = THRUST_OFFSET_ERROR_RATIO * overallDimension(bp.tree);
  if (offset > limit) {
    issues.push(issue('error', WHOLE_VESSEL,
      `推力軸が重心から ${offset.toFixed(3)} m 外れていて、許容 ${limit.toFixed(3)} m を超えています`));
  } else if (offset > limit / 2) {
    issues.push(issue('warning', WHOLE_VESSEL, `推力軸が重心から ${offset.toFixed(3)} m 外れています`));
  }
}

// 発電が消費電力を賄っていること。下回っても即座に飛べなくなるわけではなく蓄電池を
// 食いつぶしながら運用できるので、構造上の不正(error)ではなく警告にとどめる。
function checkPowerBudget(bp: VesselBlueprint, issues: BlueprintIssue[]): void {
  const inventory = new PartInventory(bp.placements.map((p) => p.part));
  const draw = inventory.totalPowerDraw;
  const generation = inventory.totalPowerGeneration;
  if (draw <= generation) return;
  issues.push(issue('warning', WHOLE_VESSEL,
    `消費電力 ${draw.toFixed(0)} W が発電量 ${generation.toFixed(0)} W を上回っています`));
}

// 廃熱を、外殻温度の上限(§11-3 の MAX_HULL_TEMP)で放熱しきれること。thermal.ts の
// ステファン・ボルツマン放射と同じ式・同じ定数を、その温度1点だけで評価する — そこで既に
// 賄えないなら、大気加熱が一切無くても平衡温度が上限を超えてしまう設計である。下回っても
// 即座に破壊されるわけではなく蓄熱で猶予があるので警告にとどめる。
function checkThermalBudget(bp: VesselBlueprint, issues: BlueprintIssue[]): void {
  const inventory = new PartInventory(bp.placements.map((p) => p.part));
  const waste = inventory.totalWasteHeat;
  if (!(waste > 0)) return;
  const area = C.RAD_AREA + inventory.totalCoolingRate;
  const radiated = C.HULL_EMISS * C.STEFAN_BOLTZMANN * area *
    (C.MAX_HULL_TEMP ** 4 - C.ENV_TEMP ** 4);
  if (waste <= radiated) return;
  issues.push(issue('warning', WHOLE_VESSEL,
    `廃熱 ${waste.toFixed(0)} W が、外殻温度の上限での放熱能力 ${radiated.toFixed(0)} W を上回っています`));
}

// 判定用の要求トルクの大きさ。有限で非負の応答が出るかだけを見るので値そのものに意味は無い。
const CONTROL_TEST_TORQUE = 1; // N・m
// 数値誤差で 0 と紛れない程度の閾値。
const CONTROL_AUTHORITY_EPS = 1e-9;
const BODY_AXES: readonly Vec3[] = [v3(1, 0, 0), v3(0, 1, 0), v3(0, 0, 1)];

// actuators が機体3軸それぞれへトルクを出せるか。磁場は設計時には定まらないので磁気トルカの
// 寄与を除外し(field を零ベクトルにすれば allocateControl 自身がそう扱う)、フライホイールと
// RCS スラスタだけで判定する — attitude-control.ts 自身、磁気トルカの出力を桁で小さい
// アンローディング専用として扱っており、姿勢制御の可否をそれに頼らせないのと同じ前提である。
function hasFullControlAuthority(actuators: ActuatorSet): boolean {
  for (const axis of BODY_AXES) {
    const request = { torque: scale(axis, CONTROL_TEST_TORQUE), force: v3() };
    const allocation = allocateControl(request, actuators, v3(), v3(), 0, false);
    if (!(dot(allocation.torque, axis) > CONTROL_AUTHORITY_EPS)) return false;
  }
  return true;
}

// excludedPartId を積んでいないものとしたアクチュエータ一式。actuatorSetOf 自身は「壊れた
// (hp<=0)要素を除く」判定しか持たないので、ここでは配置と搭載要素の一覧から丸ごと外して渡す。
function actuatorSetExcluding(
  tree: VesselTree,
  placements: readonly PartPlacement[],
  parts: readonly AnyPart[],
  centerOfMass: Vec3,
  excludedPartId: string,
): ActuatorSet {
  return actuatorSetOf(
    { tree, placements: placements.filter((p) => p.part.id !== excludedPartId) },
    parts.filter((p) => p.id !== excludedPartId),
    centerOfMass,
  );
}

// 姿勢制御が3軸とも出せること(error)と、フライホイール1基・RCSスラスタ1基のどれを失っても
// なお3軸とも出せること(warning)。後者は attitude-control.ts の配分そのものを使い、
// 要素を1つ欠いたアクチュエータ一式で有限・非負のトルクが出せるかを問う形で答える(§6.2)。
function checkAttitudeControlAuthority(bp: VesselBlueprint, issues: BlueprintIssue[]): void {
  const parts = bp.placements.map((p) => p.part);
  const centerOfMass = deriveMassProperties(assemblyOf(bp)).centerOfMass;
  const actuators = actuatorSetOf(assemblyOf(bp), parts, centerOfMass);
  if (!hasFullControlAuthority(actuators)) {
    issues.push(issue('error', WHOLE_VESSEL, '姿勢制御ができない軸があります'));
    return;
  }

  const redundancyTargets = bp.placements.filter((p) =>
    p.part.type === 'flywheel' || (p.kind === 'external' && p.part.type === 'rcs_thruster'));
  for (const placement of redundancyTargets) {
    const reduced = actuatorSetExcluding(bp.tree, bp.placements, parts, centerOfMass, placement.part.id);
    if (hasFullControlAuthority(reduced)) continue;
    issues.push(issue('warning', placement.part.id,
      `"${placement.part.id}" を失うと、いずれかの軸で姿勢制御ができなくなります`));
  }
}

// ノード数・総質量・最大寸法が上限以内であること。複合断面の構成要素数は checkSections が見る。
function checkLimits(
  bp: VesselBlueprint,
  limits: BlueprintLimits,
  volumeResolved: boolean,
  issues: BlueprintIssue[],
): void {
  if (bp.tree.nodes.length > limits.maxNodes) {
    issues.push(issue('error', WHOLE_VESSEL,
      `ノードが ${bp.tree.nodes.length} 個で、上限 ${limits.maxNodes} 個を超えています`));
  }
  const dimension = overallDimension(bp.tree);
  if (dimension > limits.maxDimension) {
    issues.push(issue('error', WHOLE_VESSEL,
      `最大寸法 ${dimension.toFixed(1)} m が上限 ${limits.maxDimension} m を超えています`));
  }
  if (!volumeResolved) return;
  const mass = deriveMassProperties(assemblyOf(bp)).loadedMass;
  if (mass > limits.maxMass) {
    issues.push(issue('error', WHOLE_VESSEL,
      `総質量 ${mass.toFixed(0)} kg が上限 ${limits.maxMass} kg を超えています`));
  }
}
