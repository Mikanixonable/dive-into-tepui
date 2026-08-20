// VesselAssembly を DOM/THREE から独立して編集する純粋なコマンド群。
// 各コマンドは新しい値を返し、検証に失敗した場合は入力 assembly をそのまま返す。
// TreeEdge.length は保存値を編集せず、常に両端の portFrame の距離から導く。

import { createBlueprint } from './blueprint';
import type { PartPlacement, VesselAssembly } from './assembly';
import type { BlueprintIssue, BlueprintLimits } from './blueprint-validation';
import { validateBlueprint } from './blueprint-validation';
import {
  edgeById, mountFrame, nodeById, portFrame, portKey,
  validateTree,
} from './tree';
import { occupiedPorts, portOwners } from './port-occupancy';
import type { CrossSection, SectionPrimitive } from '../../physics/section-moments';
import { placeSectionPrimitives } from '../../physics/section-moments';
import { len, sub } from '../../physics/vec3';
import type { Vec3 } from '../../physics/vec3';
import type { EdgeKind, MountPoint, TreeEdge, TreeNode, VesselTree } from './tree';

const QUANTIZATION_TOLERANCE = 1e-9;

export type AssemblyEditErrorCode =
  | 'invalid-input'
  | 'duplicate-id'
  | 'unknown-node'
  | 'unknown-edge'
  | 'unknown-placement'
  | 'unknown-primitive'
  | 'reference-in-use'
  | 'occupied-port'
  | 'invalid-port'
  | 'invalid-mount'
  | 'invalid-edge'
  | 'validation-failed';

export interface AssemblyEditError {
  readonly code: AssemblyEditErrorCode;
  readonly targetId: string;
  readonly message: string;
}

export interface AssemblyEditImpact {
  readonly nodeIds: readonly string[];
  readonly edgeIds: readonly string[];
  readonly placementIds: readonly string[];
}

export interface AssemblyEditResult {
  readonly accepted: boolean;
  readonly assembly: VesselAssembly;
  readonly errors: readonly AssemblyEditError[];
  readonly validationIssues: readonly BlueprintIssue[];
  readonly impact: AssemblyEditImpact;
}

export interface AssemblyEditorOptions {
  /** Full blueprint checks are enabled by default; disable them for base/partial drafts. */
  readonly validateBlueprint?: boolean;
  readonly blueprintId?: string;
  readonly blueprintName?: string;
  readonly limits?: BlueprintLimits;
}

export type EdgeDraft = Omit<TreeEdge, 'length'> & { readonly length?: number };

export interface AddNodeInput {
  readonly node: TreeNode;
  /** When present, this edge must connect the new node to an existing node. */
  readonly edge?: EdgeDraft;
}

export type SectionPrimitivePatch = Partial<Pick<SectionPrimitive, 'shape' | 'phaseAngle' | 'attachment'>>;

export type SectionEdit =
  | { readonly kind: 'add-primitive'; readonly nodeId: string; readonly primitive: SectionPrimitive }
  | {
    readonly kind: 'update-primitive';
    readonly nodeId: string;
    readonly primitiveId: string;
    readonly patch: SectionPrimitivePatch;
  }
  | { readonly kind: 'remove-primitive'; readonly nodeId: string; readonly primitiveId: string };

export interface MovePlacementInput {
  readonly placementId: string;
  readonly mount: MountPoint;
}

const EMPTY_IMPACT: AssemblyEditImpact = { nodeIds: [], edgeIds: [], placementIds: [] };

/** Validate the editor-level references, then optionally run the complete blueprint validator. */
export function validateAssembly(
  assembly: VesselAssembly,
  options: AssemblyEditorOptions = {},
): readonly BlueprintIssue[] {
  const issues: BlueprintIssue[] = [];
  for (const message of validateTree(assembly.tree)) issues.push(errorIssue('', message));
  validateConnected(assembly.tree, issues);
  validateSections(assembly.tree, issues);
  validatePlacementReferences(assembly, issues);
  if (issues.some((issue) => issue.severity === 'error')) return issues;
  if (options.validateBlueprint === false) return issues;

  try {
    const blueprint = createBlueprint({
      id: options.blueprintId ?? 'assembly-editor',
      name: options.blueprintName ?? 'Assembly editor draft',
      now: 0,
      tree: assembly.tree,
      placements: assembly.placements,
    });
    issues.push(...validateBlueprint(blueprint, options.limits));
  } catch (error) {
    issues.push(errorIssue('', `設計の検証に失敗しました: ${errorMessage(error)}`));
  }
  return issues;
}

/** Add a node, optionally with an edge that connects it to the existing tree. */
export function addNode(
  assembly: VesselAssembly,
  input: AddNodeInput,
  options: AssemblyEditorOptions = {},
): AssemblyEditResult {
  if (!isFiniteNode(input.node)) {
    return rejected(assembly, editError('invalid-input', input.node.id, 'ノードの座標、軸、位相が有限値ではありません'));
  }
  if (assembly.tree.nodes.some((node) => node.id === input.node.id)) {
    return rejected(assembly, editError('duplicate-id', input.node.id, `ノード id "${input.node.id}" は既に使われています`));
  }

  const nodes = [...assembly.tree.nodes, input.node];
  if (!input.edge) {
    return commit(assembly, { tree: treeWithEdges(nodes, assembly.tree.edges), placements: assembly.placements }, options, {
      nodeIds: [input.node.id], edgeIds: [], placementIds: [],
    });
  }

  const edgeError = validateNewEdge(assembly, input.edge, input.node.id, nodes);
  if (edgeError) return rejected(assembly, edgeError);
  const edge: TreeEdge = { ...input.edge, length: 0 };
  try {
    const tree = treeWithEdges(nodes, [...assembly.tree.edges, edge]);
    const recomputed = recomputeEdgeLengths(tree);
    return commit(assembly, { tree: recomputed, placements: assembly.placements }, options, {
      nodeIds: [input.node.id, edge.a, edge.b], edgeIds: [edge.id], placementIds: [],
    });
  } catch (error) {
    return rejected(assembly, editError('invalid-edge', edge.id, errorMessage(error)));
  }
}

/** Remove an unreferenced node. Connected edges and mounted parts must be removed first. */
export function removeNode(
  assembly: VesselAssembly,
  nodeId: string,
  options: AssemblyEditorOptions = {},
): AssemblyEditResult {
  if (!assembly.tree.nodes.some((node) => node.id === nodeId)) {
    return rejected(assembly, editError('unknown-node', nodeId, `unknown node "${nodeId}"`));
  }
  const edgeIds = assembly.tree.edges
    .filter((edge) => edge.a === nodeId || edge.b === nodeId)
    .map((edge) => edge.id);
  if (edgeIds.length > 0) {
    return rejected(assembly, editError('reference-in-use', nodeId,
      `ノード "${nodeId}" はエッジ ${edgeIds.join(', ')} から参照されています。先にエッジを削除してください`));
  }
  const placementIds = externalPlacementsAtNode(assembly, nodeId);
  if (placementIds.length > 0) {
    return rejected(assembly, editError('reference-in-use', nodeId,
      `ノード "${nodeId}" は部品 ${placementIds.join(', ')} の取付口から参照されています`));
  }
  const tree: VesselTree = {
    nodes: assembly.tree.nodes.filter((node) => node.id !== nodeId),
    edges: [...assembly.tree.edges],
  };
  return commit(assembly, { tree, placements: assembly.placements }, options, {
    nodeIds: [nodeId], edgeIds: [], placementIds: [],
  });
}

/** Remove an edge only when no placement would become dangling. */
export function removeEdge(
  assembly: VesselAssembly,
  edgeId: string,
  options: AssemblyEditorOptions = {},
): AssemblyEditResult {
  if (!assembly.tree.edges.some((edge) => edge.id === edgeId)) {
    return rejected(assembly, editError('unknown-edge', edgeId, `unknown edge "${edgeId}"`));
  }
  const placementIds = placementsAtEdge(assembly, edgeId);
  if (placementIds.length > 0) {
    return rejected(assembly, editError('reference-in-use', edgeId,
      `エッジ "${edgeId}" は部品 ${placementIds.join(', ')} から参照されています。先に部品を移動または取り外してください`));
  }
  const tree: VesselTree = {
    nodes: [...assembly.tree.nodes],
    edges: assembly.tree.edges.filter((edge) => edge.id !== edgeId),
  };
  return commit(assembly, { tree, placements: assembly.placements }, options, {
    nodeIds: [], edgeIds: [edgeId], placementIds: [],
  });
}

/** Add, update, or remove one primitive in a node's composite cross-section. */
export function editSection(
  assembly: VesselAssembly,
  edit: SectionEdit,
  options: AssemblyEditorOptions = {},
): AssemblyEditResult {
  const nodeIndex = assembly.tree.nodes.findIndex((node) => node.id === edit.nodeId);
  if (nodeIndex < 0) return rejected(assembly, editError('unknown-node', edit.nodeId, `unknown node "${edit.nodeId}"`));
  const node = assembly.tree.nodes[nodeIndex]!;
  let section: CrossSection;

  if (edit.kind === 'add-primitive') {
    if (!isFinitePrimitive(edit.primitive)) {
      return rejected(assembly, editError('invalid-input', edit.primitive.id, '断面プリミティブに有限値ではない寸法があります'));
    }
    if (node.section.primitives.some((primitive) => primitive.id === edit.primitive.id)) {
      return rejected(assembly, editError('duplicate-id', edit.primitive.id,
        `断面プリミティブ id "${edit.primitive.id}" は既に使われています`));
    }
    section = { primitives: [...node.section.primitives, edit.primitive] };
  } else {
    const primitiveIndex = node.section.primitives.findIndex((primitive) => primitive.id === edit.primitiveId);
    if (primitiveIndex < 0) {
      return rejected(assembly, editError('unknown-primitive', edit.primitiveId, `unknown primitive "${edit.primitiveId}"`));
    }
    const primitive = node.section.primitives[primitiveIndex]!;
    if (edit.kind === 'update-primitive') {
      const updated: SectionPrimitive = { ...primitive, ...edit.patch };
      if (!isFinitePrimitive(updated)) {
        return rejected(assembly, editError('invalid-input', edit.primitiveId, '断面プリミティブに有限値ではない寸法があります'));
      }
      const primitives = [...node.section.primitives];
      primitives[primitiveIndex] = updated;
      section = { primitives };
    } else {
      const children = node.section.primitives.filter((candidate) => candidate.attachment?.parentId === edit.primitiveId);
      if (children.length > 0) {
        return rejected(assembly, editError('reference-in-use', edit.primitiveId,
          `断面プリミティブ "${edit.primitiveId}" は子プリミティブから参照されています`));
      }
      if (primitive.attachment === null) {
        return rejected(assembly, editError('reference-in-use', edit.primitiveId,
          '断面のルートプリミティブは削除できません'));
      }
      const references = primitiveReferences(assembly, edit.nodeId, edit.primitiveId);
      if (references.length > 0) {
        return rejected(assembly, editError('reference-in-use', edit.primitiveId,
          `断面プリミティブ "${edit.primitiveId}" は ${references.join(', ')} から参照されています`));
      }
      section = { primitives: node.section.primitives.filter((candidate) => candidate.id !== edit.primitiveId) };
    }
  }

  const nodes = [...assembly.tree.nodes];
  nodes[nodeIndex] = { ...node, section };
  try {
    // A section edit can move lateral ports on any connected edge, so all lengths are recomputed.
    const tree = recomputeEdgeLengths(treeWithEdges(nodes, assembly.tree.edges));
    return commit(assembly, { tree, placements: assembly.placements }, options, {
      nodeIds: [edit.nodeId],
      edgeIds: assembly.tree.edges.filter((edge) => edge.a === edit.nodeId || edge.b === edit.nodeId).map((edge) => edge.id),
      placementIds: placementsAtNodeOrPrimitive(assembly, edit.nodeId, edit.kind === 'add-primitive' ? null : edit.primitiveId),
    });
  } catch (error) {
    return rejected(assembly, editError('invalid-input', edit.nodeId, errorMessage(error)));
  }
}

/** Add a part that the assembly does not carry yet, at a validated MountPoint for an external one. */
export function addPlacement(
  assembly: VesselAssembly,
  placement: PartPlacement,
  options: AssemblyEditorOptions = {},
): AssemblyEditResult {
  const placementId = placement.part.id;
  if (assembly.placements.some((candidate) => candidate.part.id === placementId)) {
    return rejected(assembly, editError('duplicate-id', placementId, `部品 id "${placementId}" は既に配置されています`));
  }
  if (placement.kind === 'external') {
    const mountError = validateMount(assembly, placement.mount, placementId);
    if (mountError) return rejected(assembly, mountError);
  }
  const impact: AssemblyEditImpact = placement.kind === 'external'
    ? { nodeIds: mountNodeIds(placement.mount), edgeIds: mountEdgeIds(placement.mount), placementIds: [placementId] }
    : { nodeIds: [], edgeIds: [...placement.edgeIds], placementIds: [placementId] };
  return commit(assembly, { tree: assembly.tree, placements: [...assembly.placements, placement] }, options, impact);
}

/** Move an external part to a validated port, hull surface, or truss MountPoint. */
export function movePlacement(
  assembly: VesselAssembly,
  input: MovePlacementInput,
  options: AssemblyEditorOptions = {},
): AssemblyEditResult {
  const index = assembly.placements.findIndex((placement) => placement.part.id === input.placementId);
  if (index < 0) return rejected(assembly, editError('unknown-placement', input.placementId, `unknown placement "${input.placementId}"`));
  const placement = assembly.placements[index]!;
  if (placement.kind !== 'external') {
    return rejected(assembly, editError('invalid-mount', input.placementId, '内装部品には MountPoint を指定できません'));
  }
  const mountError = validateMount(assembly, input.mount, input.placementId);
  if (mountError) return rejected(assembly, mountError);
  const placements = [...assembly.placements];
  placements[index] = { ...placement, mount: input.mount };
  return commit(assembly, { tree: assembly.tree, placements }, options, {
    nodeIds: mountNodeIds(input.mount), edgeIds: mountEdgeIds(input.mount), placementIds: [input.placementId],
  });
}

/** Remove a placement; callers can explicitly put the returned part into inventory. */
export function removePlacement(
  assembly: VesselAssembly,
  placementId: string,
  options: AssemblyEditorOptions = {},
): AssemblyEditResult {
  if (!assembly.placements.some((placement) => placement.part.id === placementId)) {
    return rejected(assembly, editError('unknown-placement', placementId, `unknown placement "${placementId}"`));
  }
  const placements = assembly.placements.filter((placement) => placement.part.id !== placementId);
  return commit(assembly, { tree: assembly.tree, placements }, options, {
    nodeIds: [], edgeIds: [], placementIds: [placementId],
  });
}

function commit(
  original: VesselAssembly,
  next: VesselAssembly,
  options: AssemblyEditorOptions,
  impact: AssemblyEditImpact,
): AssemblyEditResult {
  const validationIssues = validateAssembly(next, options);
  const errors = validationIssues
    .filter((issue) => issue.severity === 'error')
    .map((issue) => editError('validation-failed', issue.targetId, issue.message));
  if (errors.length > 0) return { accepted: false, assembly: original, errors, validationIssues, impact: EMPTY_IMPACT };
  return { accepted: true, assembly: next, errors: [], validationIssues, impact };
}

function rejected(assembly: VesselAssembly, error: AssemblyEditError): AssemblyEditResult {
  return { accepted: false, assembly, errors: [error], validationIssues: [], impact: EMPTY_IMPACT };
}

function editError(code: AssemblyEditErrorCode, targetId: string, message: string): AssemblyEditError {
  return { code, targetId, message };
}

function errorIssue(targetId: string, message: string): BlueprintIssue {
  return { severity: 'error', targetId, message };
}

function treeWithEdges(nodes: readonly TreeNode[], edges: readonly TreeEdge[]): VesselTree {
  return { nodes: [...nodes], edges: [...edges] };
}

function recomputeEdgeLengths(tree: VesselTree): VesselTree {
  return {
    nodes: [...tree.nodes],
    edges: tree.edges.map((edge) => ({ ...edge, length: portDistance(tree, edge) })),
  };
}

function portDistance(tree: VesselTree, edge: TreeEdge): number {
  const from = portFrame(nodeById(tree, edge.a), edge.portA).origin;
  const to = portFrame(nodeById(tree, edge.b), edge.portB).origin;
  const distance = len(sub(to, from));
  if (!Number.isFinite(distance)) throw new Error(`edge "${edge.id}" has a non-finite port distance`);
  return distance;
}

function validateNewEdge(
  assembly: VesselAssembly,
  input: EdgeDraft,
  newNodeId: string | undefined,
  nodes: readonly TreeNode[],
  ignoredEdgeId?: string,
): AssemblyEditError | null {
  if (assembly.tree.edges.some((edge) => edge.id === input.id && edge.id !== ignoredEdgeId)) {
    return editError('duplicate-id', input.id, `エッジ id "${input.id}" は既に使われています`);
  }
  if (input.a === input.b) return editError('invalid-edge', input.id, 'エッジの両端に同じノードは指定できません');
  const nodeIds = new Set(nodes.map((node) => node.id));
  if (!nodeIds.has(input.a)) return editError('unknown-node', input.a, `unknown node "${input.a}"`);
  if (!nodeIds.has(input.b)) return editError('unknown-node', input.b, `unknown node "${input.b}"`);
  if (newNodeId !== undefined && input.a !== newNodeId && input.b !== newNodeId) {
    return editError('invalid-edge', input.id, '新しいノードは追加するエッジの片端でなければなりません');
  }
  try {
    portFrame(nodeById(treeWithEdges(nodes, []), input.a), input.portA);
    portFrame(nodeById(treeWithEdges(nodes, []), input.b), input.portB);
  } catch (error) {
    return editError('invalid-port', input.id, errorMessage(error));
  }
  const occupied = occupiedPorts(assembly, ignoredEdgeId);
  const keyA = portKey(input.a, input.portA);
  const keyB = portKey(input.b, input.portB);
  if (keyA === keyB) return editError('occupied-port', input.id, `エッジ "${input.id}" が同じ接続口を両端で使っています`);
  if (occupied.has(keyA)) return editError('occupied-port', input.id, `接続口 ${keyA} は既に使われています`);
  if (occupied.has(keyB)) return editError('occupied-port', input.id, `接続口 ${keyB} は既に使われています`);
  if (!isValidEdgeKind(input.kind)) return editError('invalid-edge', input.id, 'エッジ種別の寸法または分離条件が不正です');
  return null;
}

function isValidEdgeKind(kind: EdgeKind): boolean {
  if (kind.kind === 'hull') return true;
  if (kind.kind === 'truss') return Number.isFinite(kind.sectionSize) && kind.sectionSize > 0;
  return Number.isFinite(kind.separationImpulse) && kind.separationImpulse >= 0;
}


function validateMount(
  assembly: VesselAssembly,
  mount: MountPoint,
  placementId: string,
): AssemblyEditError | null {
  try {
    if (mount.kind === 'port') {
      nodeById(assembly.tree, mount.nodeId);
      portFrame(nodeById(assembly.tree, mount.nodeId), mount.port);
      const key = portKey(mount.nodeId, mount.port);
      const owner = portOwners(assembly, undefined, placementId).get(key);
      if (owner?.kind === 'edge') return editError('occupied-port', placementId, `接続口 ${key} はエッジが使っています`);
      if (owner?.kind === 'part') return editError('occupied-port', placementId, `接続口 ${key} は部品が使っています`);
      return null;
    }
    const edge = edgeById(assembly.tree, mount.edgeId);
    if (!Number.isFinite(mount.along) || !Number.isFinite(mount.around)) {
      return editError('invalid-mount', placementId, '取付位置が有限値ではありません');
    }
    if (mount.along < -QUANTIZATION_TOLERANCE || mount.along > edge.length + QUANTIZATION_TOLERANCE) {
      return editError('invalid-mount', placementId, `エッジ "${edge.id}" の範囲外に取り付けています`);
    }
    if (mount.kind === 'surface' && edge.kind.kind !== 'hull') {
      return editError('invalid-mount', placementId, '外表面の取付位置には hull エッジが必要です');
    }
    if (mount.kind === 'truss' && edge.kind.kind !== 'truss') {
      return editError('invalid-mount', placementId, 'トラスの取付位置には truss エッジが必要です');
    }
    mountFrame(assembly.tree, mount);
    return null;
  } catch (error) {
    return editError('invalid-mount', placementId, errorMessage(error));
  }
}

function validateConnected(tree: VesselTree, issues: BlueprintIssue[]): void {
  if (tree.nodes.length === 0) {
    issues.push(errorIssue('', 'ノードが1つもありません'));
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
    if (!reached.has(node.id)) issues.push(errorIssue(node.id, 'このノードは機体の他の部分と繋がっていません'));
  }
}

function validateSections(tree: VesselTree, issues: BlueprintIssue[]): void {
  for (const node of tree.nodes) {
    try {
      placeSectionPrimitives(node.section);
    } catch (error) {
      issues.push(errorIssue(node.id, `断面が組めません: ${errorMessage(error)}`));
    }
  }
}

function validatePlacementReferences(assembly: VesselAssembly, issues: BlueprintIssue[]): void {
  const placementIds = new Set<string>();
  for (const placement of assembly.placements) {
    if (placementIds.has(placement.part.id)) issues.push(errorIssue(placement.part.id, '同じ部品 id が複数回配置されています'));
    placementIds.add(placement.part.id);
    if (placement.kind === 'internal') {
      if (placement.edgeIds.length === 0) issues.push(errorIssue(placement.part.id, '内装部品がどのエッジにも収められていません'));
      for (const edgeId of placement.edgeIds) {
        if (!assembly.tree.edges.some((edge) => edge.id === edgeId)) {
          issues.push(errorIssue(placement.part.id, `内装部品が存在しないエッジ "${edgeId}" を参照しています`));
        }
      }
      continue;
    }
    const mountError = validateMount(assembly, placement.mount, placement.part.id);
    if (mountError) {
      issues.push(errorIssue(mountError.targetId, mountError.message));
    }
  }
}

function isFiniteNode(node: TreeNode): boolean {
  return isFiniteVec3(node.pos) && isFiniteVec3(node.axis) && Number.isFinite(node.phaseAngle);
}

function isFiniteVec3(vector: Vec3): boolean {
  return Number.isFinite(vector.x) && Number.isFinite(vector.y) && Number.isFinite(vector.z);
}

function isFinitePrimitive(primitive: SectionPrimitive): boolean {
  if (!Number.isFinite(primitive.phaseAngle)) return false;
  const shape = primitive.shape;
  if (shape.kind === 'ellipse') {
    return Number.isFinite(shape.majorRadius) && shape.majorRadius > 0 &&
      Number.isFinite(shape.minorRadius) && shape.minorRadius > 0;
  }
  return Number.isFinite(shape.radius) && shape.radius > 0;
}

function externalPlacementsAtNode(assembly: VesselAssembly, nodeId: string): readonly string[] {
  return assembly.placements
    .filter((placement): placement is Extract<PartPlacement, { kind: 'external' }> => placement.kind === 'external')
    .filter((placement) => placement.mount.kind === 'port' && placement.mount.nodeId === nodeId)
    .map((placement) => placement.part.id);
}

function placementsAtEdge(assembly: VesselAssembly, edgeId: string): readonly string[] {
  return assembly.placements.filter((placement) => {
    if (placement.kind === 'internal') return placement.edgeIds.includes(edgeId);
    return placement.mount.kind !== 'port' && placement.mount.edgeId === edgeId;
  }).map((placement) => placement.part.id);
}

function primitiveReferences(assembly: VesselAssembly, nodeId: string, primitiveId: string): readonly string[] {
  const references: string[] = [];
  for (const edge of assembly.tree.edges) {
    if (edge.a === nodeId && edge.portA.kind === 'lateral' && edge.portA.primitiveId === primitiveId) references.push(edge.id);
    if (edge.b === nodeId && edge.portB.kind === 'lateral' && edge.portB.primitiveId === primitiveId) references.push(edge.id);
  }
  for (const placement of assembly.placements) {
    if (placement.kind === 'external' && placement.mount.kind === 'port' && placement.mount.nodeId === nodeId &&
      placement.mount.port.kind === 'lateral' && placement.mount.port.primitiveId === primitiveId) {
      references.push(placement.part.id);
    }
  }
  return references;
}

function placementsAtNodeOrPrimitive(
  assembly: VesselAssembly,
  nodeId: string,
  primitiveId: string | null,
): readonly string[] {
  const ids = new Set(externalPlacementsAtNode(assembly, nodeId));
  if (primitiveId !== null) {
    for (const reference of primitiveReferences(assembly, nodeId, primitiveId)) ids.add(reference);
  }
  return [...ids];
}

function mountNodeIds(mount: MountPoint): readonly string[] {
  return mount.kind === 'port' ? [mount.nodeId] : [];
}

function mountEdgeIds(mount: MountPoint): readonly string[] {
  return mount.kind === 'port' ? [] : [mount.edgeId];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
