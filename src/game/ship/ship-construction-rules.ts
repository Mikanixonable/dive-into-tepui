// 建造の取り付け先と、手持ちをその取り付け先へ置けるかを判定する純粋な規則。
// 取り付け先は船体全体から列挙する: 空いている軸方向の面・空いている側面スロット・軸方向の継ぎ目。
import type { ShipAssembly, ModuleTransform } from './ship-assembly';
import { pieceOfModule } from './ship-assembly-graft';
import {
  axialMountTransform, axialPlacementFromTransform, inverseTransform, isSideChild, isSideParent,
  sideMountTransform, type AxialFace, type ModuleOrientation,
} from './ship-assembly-transform';
import { SIDE_SLOTS, type ConnectionKind, type SideSlot } from './ship-assembly-types';
import type { ShipModuleDefinition } from './ship-module-definition';
import type {
  ConstructionHeld, ConstructionSymmetry, ConstructionTarget,
} from './ship-construction-types';
// ---- 船体全体を対象にした取り付け先・手持ち・対称の規則 ----

// 側面スロットの位置表示。親モジュールの表記から見た向き。
const SLOT_POSITION_LABELS: Readonly<Record<SideSlot, string>> = {
  'side:+x': '右', 'side:-x': '左', 'side:+y': '上', 'side:-y': '下',
};

const FACE_POSITION_LABELS: Readonly<Record<AxialFace, string>> = { front: '前端', back: '後端' };

const OPPOSITE_SLOT: Readonly<Record<SideSlot, SideSlot>> = {
  'side:+x': 'side:-x', 'side:-x': 'side:+x', 'side:+y': 'side:-y', 'side:-y': 'side:+y',
};

function oppositeFace(face: AxialFace): AxialFace {
  return face === 'front' ? 'back' : 'front';
}

// 列挙した取り付け先と、内部識別子を含まない表示用ラベル。
export interface ConstructionTargetInfo {
  readonly target: ConstructionTarget;
  readonly label: string;
}

// 1つの接ぎ木の内容。対称配置では同じ形が対称の位置の数だけ並ぶ。
export interface ConstructionAttachPlan {
  readonly parentId: string;
  readonly transform: ModuleTransform;
  readonly connectionKind: ConnectionKind;
  readonly sideSlot: SideSlot | null;
}

// 継ぎ目への割り込みで、継ぎ目の先の部分を置いたモジュールへ付き直す内容。
// transform は置いたモジュールのローカルでの先端部の根の取り付け変換。
export interface ConstructionReattachPlan {
  readonly connectionId: string;
  readonly farModuleId: string;
  readonly transform: ModuleTransform;
}

// 手持ちを取り付け先へ置けるかの判定結果。valid なら attachments と reattachment をそのまま適用できる。
export interface ConstructionPlacementResult {
  readonly valid: boolean;
  readonly reason: string | null;
  readonly attachments: readonly ConstructionAttachPlan[];
  readonly reattachment: ConstructionReattachPlan | null;
}

// モジュールを「名前 + 船体内の通し番号」で表す。通し番号は assembly.modules の並びで同じ定義の何番目か。
export function constructionModuleLabel(assembly: ShipAssembly, moduleId: string): string {
  const instance = assembly.module(moduleId);
  const definition = instance === null ? null : assembly.catalog.get(instance.definitionId);
  let ordinal = 0;
  for (const module of assembly.modules) {
    if (instance !== null && module.definitionId === instance.definitionId) ordinal++;
    if (module.id === moduleId) break;
  }
  return `${definition?.name ?? moduleId} ${ordinal}`;
}

// 取り付け先を安定した識別子で表す。候補の追跡用で、表示には使わない。
export function constructionTargetId(target: ConstructionTarget): string {
  switch (target.kind) {
    case 'axial-face': return `axial-face:${target.parentId}:${target.face}`;
    case 'side-slot': return `side-slot:${target.parentId}:${target.slot}`;
    case 'joint': return `joint:${target.connectionId}`;
  }
}

// 起点ドックから各モジュールへの無向グラフ上の距離を求める。
function anchorDistances(assembly: ShipAssembly, anchorId: string): ReadonlyMap<string, number> {
  const distances = new Map<string, number>([[anchorId, 0]]);
  const pending = [anchorId];
  while (pending.length > 0) {
    const current = pending.shift()!;
    const depth = distances.get(current)! + 1;
    for (const edge of assembly.graph) {
      const neighbor = edge.parentId === current ? edge.childId
        : edge.childId === current ? edge.parentId : null;
      if (neighbor !== null && !distances.has(neighbor)) {
        distances.set(neighbor, depth);
        pending.push(neighbor);
      }
    }
  }
  return distances;
}

// 軸方向の継ぎ目の、起点ドックに近い側と遠い側。nearFace は近い側の継ぎ目の面、
// farOrientation は遠い側が近い側へ向けていた端と回し。接続でなければ null。
export interface JointEnds {
  readonly nearId: string;
  readonly farId: string;
  readonly nearFace: AxialFace;
  readonly farOrientation: ModuleOrientation;
}

export function jointEndsOf(
  assembly: ShipAssembly, anchorId: string, connectionId: string,
): JointEnds | null {
  const edge = assembly.graph.find(connection => connection.id === connectionId);
  if (edge === undefined || (edge.kind !== 'axial' && edge.kind !== 'construction')) return null;
  const distances = anchorDistances(assembly, anchorId);
  const parentDepth = distances.get(edge.parentId) ?? Number.MAX_SAFE_INTEGER;
  const childDepth = distances.get(edge.childId) ?? Number.MAX_SAFE_INTEGER;
  const nearId = parentDepth <= childDepth ? edge.parentId : edge.childId;
  const farId = nearId === edge.parentId ? edge.childId : edge.parentId;
  // 近い側を親と見た変換へ正規化して、面と向きを読む。
  const transform = edge.parentId === nearId ? edge.childTransform : inverseTransform(edge.childTransform);
  const placement = axialPlacementFromTransform(transform);
  if (placement === null) return null;
  return { nearId, farId, nearFace: placement.parentFace, farOrientation: placement.orientation };
}

// moduleId の使われている軸方向の面を返す。接続は親子どちら向きでも数え、
// ignoreConnectionId の接続(付け替え中の根元の接続)は占有とみなさない。
function occupiedAxialFaces(
  assembly: ShipAssembly, moduleId: string, ignoreConnectionId: string | null,
): ReadonlySet<AxialFace> {
  const faces = new Set<AxialFace>();
  for (const edge of assembly.graph) {
    if (edge.kind === 'side' || edge.id === ignoreConnectionId) continue;
    const transform = edge.parentId === moduleId ? edge.childTransform
      : edge.childId === moduleId ? inverseTransform(edge.childTransform) : null;
    if (transform === null) continue;
    const placement = axialPlacementFromTransform(transform);
    if (placement !== null) faces.add(placement.parentFace);
  }
  return faces;
}

// moduleId の使われている側面スロットを返す。スロットの持ち主は sideReversed を含めて検証と同じ考え方。
function occupiedSideSlots(
  assembly: ShipAssembly, moduleId: string, ignoreConnectionId: string | null,
): ReadonlySet<SideSlot> {
  const slots = new Set<SideSlot>();
  for (const edge of assembly.graph) {
    if (edge.kind !== 'side' || edge.id === ignoreConnectionId || edge.sideSlot === undefined) continue;
    const ownerId = edge.sideReversed ? edge.childId : edge.parentId;
    if (ownerId === moduleId) slots.add(edge.sideSlot);
  }
  return slots;
}

// 船体全体の空いている取り付け先を列挙する。ラベルは内部識別子を含まない。
export function enumerateConstructionTargets(
  assembly: ShipAssembly, anchorId: string,
): readonly ConstructionTargetInfo[] {
  const targets: ConstructionTargetInfo[] = [];
  for (const instance of assembly.modules) {
    const definition = assembly.catalog.get(instance.definitionId);
    if (definition === null) continue;
    const moduleLabel = constructionModuleLabel(assembly, instance.id);
    const occupied = occupiedAxialFaces(assembly, instance.id, null);
    for (const face of ['front', 'back'] as const) {
      const use = definition.axialFaces[face];
      if ((use === 'structural' || use === 'receive') && !occupied.has(face)) {
        targets.push({
          target: { kind: 'axial-face', parentId: instance.id, face },
          label: `${moduleLabel} の${FACE_POSITION_LABELS[face]}`,
        });
      }
    }
    if (isSideParent(instance.kind)) {
      const slots = occupiedSideSlots(assembly, instance.id, null);
      for (const slot of SIDE_SLOTS) {
        if (slots.has(slot)) continue;
        targets.push({
          target: { kind: 'side-slot', parentId: instance.id, slot },
          label: `${moduleLabel} の${SLOT_POSITION_LABELS[slot]}`,
        });
      }
    }
  }
  for (const edge of assembly.graph) {
    const ends = jointEndsOf(assembly, anchorId, edge.id);
    if (ends === null) continue;
    targets.push({
      target: { kind: 'joint', connectionId: edge.id },
      label: `${constructionModuleLabel(assembly, ends.nearId)} と ${constructionModuleLabel(assembly, ends.farId)} の継ぎ目`,
    });
  }
  return targets;
}

// 写しの先端部の、取り付けるモジュール(親を持たない根)の id。
export function pieceRootId(piece: ShipAssembly): string | null {
  const children = new Set(piece.graph.map(edge => edge.childId));
  return piece.moduleIds.find(id => !children.has(id)) ?? null;
}

// 手持ちの根となるモジュールの定義。付け替えは掴んだモジュール、写しは根のモジュール。
export function heldRootDefinition(
  assembly: ShipAssembly, held: ConstructionHeld,
): ShipModuleDefinition | null {
  switch (held.kind) {
    case 'catalog': return assembly.catalog.get(held.definitionId);
    case 'piece': return assembly.definition(held.moduleId);
    case 'copy': {
      const rootId = pieceRootId(held.piece);
      return rootId === null ? null : held.piece.definition(rootId);
    }
  }
}

function invalidResult(reason: string): ConstructionPlacementResult {
  return { valid: false, reason, attachments: [], reattachment: null };
}

// 手持ちを取り付け先へ orientation で置けるかを判定する。返す変換は親ローカルでの
// 手持ちの根の取り付け変換。対称は側面へ新しく置くときだけ有効で、1か所でも
// 置けなければ全体を無効とする。
export function placementFor(
  assembly: ShipAssembly, anchorId: string, held: ConstructionHeld,
  target: ConstructionTarget, orientation: ModuleOrientation, symmetry: ConstructionSymmetry,
): ConstructionPlacementResult {
  const rootDefinition = heldRootDefinition(assembly, held);
  if (rootDefinition === null) return invalidResult('手に持った部品が見つかりません');
  // 付け替えでは、動かす先端部の内側へは付けられず、起点ドックは持てない。
  let pieceIds: ReadonlySet<string> | null = null;
  let ignoreConnectionId: string | null = null;
  if (held.kind === 'piece') {
    if (held.moduleId === anchorId) return invalidResult('起点のドックは動かせません');
    const piece = pieceOfModule(assembly.graph, anchorId, held.moduleId);
    if (piece === null) return invalidResult('その部品は掴めません');
    pieceIds = piece.moduleIds;
    ignoreConnectionId = piece.rootConnection.id;
  }
  if (symmetry !== 1 && (target.kind !== 'side-slot' || held.kind === 'piece')) {
    return invalidResult('対称配置は側面への新しい配置にだけ使えます');
  }
  switch (target.kind) {
    case 'axial-face':
      return axialTargetPlacement(
        assembly, target, orientation, rootDefinition, pieceIds, ignoreConnectionId,
      );
    case 'side-slot':
      return sideTargetPlacement(
        assembly, target, orientation, symmetry, rootDefinition, pieceIds, ignoreConnectionId,
      );
    case 'joint':
      return jointTargetPlacement(assembly, anchorId, held, target, orientation, rootDefinition);
  }
}

function axialTargetPlacement(
  assembly: ShipAssembly, target: { readonly parentId: string; readonly face: AxialFace },
  orientation: ModuleOrientation, rootDefinition: ShipModuleDefinition,
  pieceIds: ReadonlySet<string> | null, ignoreConnectionId: string | null,
): ConstructionPlacementResult {
  const parentDefinition = assembly.definition(target.parentId);
  if (parentDefinition === null) return invalidResult('接続先の部品がありません');
  if (pieceIds?.has(target.parentId)) return invalidResult('付け替える部分の内側には取り付けられません');
  const faceUse = parentDefinition.axialFaces[target.face];
  if (faceUse !== 'structural' && faceUse !== 'receive') {
    return invalidResult('その面には取り付けられません');
  }
  if (occupiedAxialFaces(assembly, target.parentId, ignoreConnectionId).has(target.face)) {
    return invalidResult('その取り付け面はふさがっています');
  }
  if (rootDefinition.kind === 'solar_panel' || rootDefinition.kind === 'radiator') {
    return invalidResult('この部品は側面にだけ取り付けられます');
  }
  if (rootDefinition.axialFaces[orientation.face] !== 'structural') {
    return invalidResult('その面では自分から取り付けられません');
  }
  const connectionKind: ConnectionKind = parentDefinition.kind === 'dock' && target.face === 'front'
    ? 'construction' : 'axial';
  return {
    valid: true, reason: null,
    attachments: [{
      parentId: target.parentId,
      transform: axialMountTransform(parentDefinition, rootDefinition, target.face, orientation),
      connectionKind, sideSlot: null,
    }],
    reattachment: null,
  };
}

function sideTargetPlacement(
  assembly: ShipAssembly, target: { readonly parentId: string; readonly slot: SideSlot },
  orientation: ModuleOrientation, symmetry: ConstructionSymmetry, rootDefinition: ShipModuleDefinition,
  pieceIds: ReadonlySet<string> | null, ignoreConnectionId: string | null,
): ConstructionPlacementResult {
  const parentDefinition = assembly.definition(target.parentId);
  if (parentDefinition === null) return invalidResult('接続先の部品がありません');
  if (pieceIds?.has(target.parentId)) return invalidResult('付け替える部分の内側には取り付けられません');
  if (!isSideParent(parentDefinition.kind)) {
    return invalidResult('側面にはコックピットとタンクへだけ取り付けられます');
  }
  if (!isSideChild(rootDefinition.kind)) {
    return invalidResult('この部品は側面には取り付けられません');
  }
  const slots: readonly SideSlot[] = symmetry === 4 ? SIDE_SLOTS
    : symmetry === 2 ? [target.slot, OPPOSITE_SLOT[target.slot]]
    : [target.slot];
  const occupied = occupiedSideSlots(assembly, target.parentId, ignoreConnectionId);
  for (const slot of slots) {
    if (occupied.has(slot)) {
      return invalidResult(
        symmetry === 1 ? 'その側面の取り付け位置はふさがっています' : '対称の取り付け位置がふさがっています',
      );
    }
  }
  return {
    valid: true, reason: null,
    attachments: slots.map(slot => ({
      parentId: target.parentId,
      transform: sideMountTransform(parentDefinition, rootDefinition, slot, orientation.roll),
      connectionKind: 'side' as const, sideSlot: slot,
    })),
    reattachment: null,
  };
}

function jointTargetPlacement(
  assembly: ShipAssembly, anchorId: string, held: ConstructionHeld,
  target: { readonly connectionId: string }, orientation: ModuleOrientation,
  rootDefinition: ShipModuleDefinition,
): ConstructionPlacementResult {
  if (held.kind !== 'catalog') return invalidResult('継ぎ目へはカタログの部品だけを割り込ませられます');
  if (rootDefinition.axialFaces.front !== 'structural' || rootDefinition.axialFaces.back !== 'structural') {
    return invalidResult('継ぎ目へは両端に取り付け面を持つ部品だけを割り込ませられます');
  }
  const ends = jointEndsOf(assembly, anchorId, target.connectionId);
  if (ends === null) return invalidResult('その継ぎ目はありません');
  const nearDefinition = assembly.definition(ends.nearId);
  const farDefinition = assembly.definition(ends.farId);
  if (nearDefinition === null || farDefinition === null) return invalidResult('接続先の部品がありません');
  const connectionKind: ConnectionKind = nearDefinition.kind === 'dock' && ends.nearFace === 'front'
    ? 'construction' : 'axial';
  return {
    valid: true, reason: null,
    attachments: [{
      parentId: ends.nearId,
      transform: axialMountTransform(nearDefinition, rootDefinition, ends.nearFace, orientation),
      connectionKind, sideSlot: null,
    }],
    // 継ぎ目の先は、置いたモジュールの反対側の端へ、元の向きのまま付き直す。
    reattachment: {
      connectionId: target.connectionId,
      farModuleId: ends.farId,
      transform: axialMountTransform(
        rootDefinition, farDefinition, oppositeFace(orientation.face), ends.farOrientation,
      ),
    },
  };
}
