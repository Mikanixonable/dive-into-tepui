// 指している取り付け先へ手持ちを置いた場合の結果を、assembly の写しへ試しに適用して求める純関数。
// 置いたモジュールの位置・適用後の総量・健全なコックピットの有無・重なる相手を返す。
import { cappedCylinderCylinderContact } from '../../physics/capped-cylinder-contact';
import { v3, type Vec3 } from '../../math/vec3';
import type { ShipAssembly } from './ship-assembly';
import { pieceOfModule } from './ship-assembly-graft';
import type { ModuleOrientation } from './ship-assembly-transform';
import type { ModuleTransform, ShipAssemblyTotals } from './ship-assembly-types';
import { createShipModuleInstance } from './ship-module-instance';
import { shipPhysicsShape } from './ship-physics-shape';
import { pieceRootId, placementFor } from './ship-construction-rules';
import type { ConstructionHeld, ConstructionSymmetry, ConstructionTarget } from './ship-construction-types';

// 試し置きで置いた(動かした)モジュールと、その船体座標でのワールド変換。
export interface ConstructionTrialModule {
  readonly moduleId: string;
  readonly transform: ModuleTransform;
}

export interface ConstructionTrial {
  readonly valid: boolean;
  readonly reason: string | null;
  readonly placed: readonly ConstructionTrialModule[];
  readonly totals: ShipAssemblyTotals | null;
  readonly healthyCockpitRemains: boolean;
  readonly overlapModuleIds: readonly string[];
}

// 接合面どうしの接触を重なりとみなさないための許容深度 [m]。
const OVERLAP_DEPTH = 0.01;

function pairKey(a: string, b: string): string {
  return a < b ? `${a}\n${b}` : `${b}\n${a}`;
}

// 船体座標での primitive の軸は取り付け規則上つねに座標軸と一致するが、回転の合成で
// 1e-16 台のずれが乗ると接触の数値経路が変わり、実際のめり込みを見逃すことがある。
// 軸に近い座標軸へだけ吸着させて拾う(軸に揃わない軸はそのまま返す)。
function canonicalAxis(axis: Vec3): Vec3 {
  const dominant = Math.abs(axis.x) >= Math.abs(axis.y) && Math.abs(axis.x) >= Math.abs(axis.z) ? 'x'
    : Math.abs(axis.y) >= Math.abs(axis.z) ? 'y' : 'z';
  const snapped = v3(
    dominant === 'x' ? Math.sign(axis.x) : 0,
    dominant === 'y' ? Math.sign(axis.y) : 0,
    dominant === 'z' ? Math.sign(axis.z) : 0,
  );
  if (Math.abs(axis.x - snapped.x) > 1e-9 || Math.abs(axis.y - snapped.y) > 1e-9
    || Math.abs(axis.z - snapped.z) > 1e-9) return axis;
  return snapped;
}

// 試し置き専用の、assembly に無い id を作る。
function freshModuleId(assembly: ShipAssembly, base: string): string {
  let id = base;
  let suffix = 2;
  while (assembly.module(id) !== null) id = `${base}-${suffix++}`;
  return id;
}

function hasHealthyCockpit(assembly: ShipAssembly): boolean {
  return assembly.modules.some(module => module.kind === 'cockpit' && module.hp > 0);
}

// 手持ち(付け替えなら先端部)と残りの間だけで 1 cm を超えるめり込みを調べ、
// 重なる相手のモジュール id を返す。直接接続する組(connected)は接合面の接触なので除く。
function overlapModuleIdsOf(
  assembly: ShipAssembly, heldIds: ReadonlySet<string>, connected: ReadonlySet<string>,
): readonly string[] {
  const shape = shipPhysicsShape(assembly);
  if (shape === null) return [];
  const primitives = shape.shape.primitives.map(
    primitive => ({ ...primitive, axis: canonicalAxis(primitive.axis) }),
  );
  const heldPrimitives = primitives.filter(primitive => heldIds.has(primitive.moduleId));
  const result = new Set<string>();
  for (const primitive of primitives) {
    if (heldIds.has(primitive.moduleId)) continue;
    for (const heldPrimitive of heldPrimitives) {
      if (connected.has(pairKey(primitive.moduleId, heldPrimitive.moduleId))) continue;
      const hit = cappedCylinderCylinderContact(heldPrimitive, primitive);
      if (hit !== null && hit.depth > OVERLAP_DEPTH) result.add(primitive.moduleId);
    }
  }
  return [...result].sort();
}

// 手持ちを取り付け先へ置く操作を、assembly の写しへ適用した結果を返す。assembly 自身は変えない。
// 写しへの適用は placementFor が有効と判定した計画だけをなぞるので、失敗した中間状態は残らない。
export function tryConstructionPlacement(
  assembly: ShipAssembly, anchorId: string, held: ConstructionHeld,
  target: ConstructionTarget, orientation: ModuleOrientation, symmetry: ConstructionSymmetry,
): ConstructionTrial {
  const placement = placementFor(assembly, anchorId, held, target, orientation, symmetry);
  if (!placement.valid) {
    return {
      valid: false, reason: placement.reason, placed: [], totals: null,
      healthyCockpitRemains: hasHealthyCockpit(assembly), overlapModuleIds: [],
    };
  }
  const work = assembly.clone();
  const placedIds: string[] = [];
  const connected = new Set<string>();
  let placedRootId: string | null = null;

  // 付け替えは先端部を先に切り離す。付け替えは対称を持たないので接ぎ木は1本。
  let detached: ShipAssembly | null = null;
  let detachedConnectionId: string | null = null;
  if (held.kind === 'piece') {
    const piece = pieceOfModule(work.graph, anchorId, held.moduleId);
    detachedConnectionId = piece?.rootConnection.id ?? null;
    detached = work.detachPiece(held.moduleId, anchorId);
  }

  for (const [index, plan] of placement.attachments.entries()) {
    if (held.kind === 'catalog') {
      const definition = work.catalog.require(held.definitionId);
      const id = freshModuleId(work, `placed-${index + 1}`);
      work.addModule(
        createShipModuleInstance(definition, id), plan.parentId, plan.transform,
        plan.connectionKind, undefined, plan.sideSlot ?? undefined,
      );
      placedRootId ??= id;
      placedIds.push(id);
      connected.add(pairKey(plan.parentId, id));
    } else {
      const piece = held.kind === 'piece' ? detached! : held.piece.copiedAsNew(`copy-${index + 1}`);
      const rootId = pieceRootId(piece);
      if (rootId === null) return { valid: false, reason: '手に持った部品が見つかりません', placed: [], totals: null, healthyCockpitRemains: hasHealthyCockpit(assembly), overlapModuleIds: [] };
      const ids = piece.moduleIds;
      work.attachPiece(
        piece, plan.parentId, plan.transform, plan.connectionKind,
        plan.sideSlot ?? undefined, undefined, detachedConnectionId ?? undefined,
      );
      placedRootId ??= rootId;
      placedIds.push(...ids);
      connected.add(pairKey(plan.parentId, rootId));
    }
  }

  // 継ぎ目の先の部分を、割り込ませたモジュールの反対側の端へ付き直す。
  if (placement.reattachment !== null && placedRootId !== null) {
    const far = work.detachPiece(placement.reattachment.farModuleId, anchorId);
    work.attachPiece(
      far, placedRootId, placement.reattachment.transform, 'axial',
      undefined, undefined, placement.reattachment.connectionId,
    );
    connected.add(pairKey(placedRootId, placement.reattachment.farModuleId));
  }

  const placed = placedIds.map((id): ConstructionTrialModule => {
    const transform = work.worldTransformOf(id);
    if (transform === null) throw new Error(`placed module is missing: ${id}`);
    return { moduleId: id, transform };
  });
  const overlapModuleIds = overlapModuleIdsOf(work, new Set(placedIds), connected);
  const reason = overlapModuleIds.length > 0 ? '他の部品と重なります' : null;
  return {
    valid: reason === null, reason, placed, totals: work.totals(),
    healthyCockpitRemains: hasHealthyCockpit(work), overlapModuleIds,
  };
}
