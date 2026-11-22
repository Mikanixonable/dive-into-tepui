// 指している取り付け先へ手持ちを置いた場合の結果を、assembly の写しへ試しに適用して求める純関数。
// 置いたモジュールの位置・適用後の総量・健全なコックピットの有無・重なる相手を返す。
import { cappedCylinderCylinderContact } from '../../physics/capped-cylinder-contact';
import { v3, type Vec3 } from '../../math/vec3';
import type { ShipAssembly } from './ship-assembly';
import type { ModuleOrientation } from './ship-assembly-transform';
import type { ModuleTransform, ShipAssemblyTotals } from './ship-assembly-types';
import { shipPhysicsShape } from './ship-physics-shape';
import { placementFor } from './ship-construction-rules';
import { applyConstructionPlacement, pairKey } from './ship-construction-apply';
import type { ConstructionHeld, ConstructionSymmetry, ConstructionTarget } from './ship-construction-types';

// 試し置きで置いた(動かした)モジュールと、その船体座標でのワールド変換。
interface ConstructionTrialModule {
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
  // ずれが閾値を超えるなら軸に揃っていないので吸着しない。
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

// 健全な(hp > 0 の)コックピットが残っているか。
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
  // 手持ち以外の各 primitive と、手持ちの全 primitive のめり込みを調べる。
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
  const invalid = (reason: string | null): ConstructionTrial => ({
    valid: false, reason, placed: [], totals: null,
    healthyCockpitRemains: hasHealthyCockpit(assembly), overlapModuleIds: [],
  });
  const placement = placementFor(assembly, anchorId, held, target, orientation, symmetry);
  if (!placement.valid) return invalid(placement.reason);

  const work = assembly.clone();
  let placedIds: readonly string[];
  let connected: ReadonlySet<string>;
  try {
    ({ placedIds, connected } = applyConstructionPlacement(
      work, anchorId, held, placement,
      index => held.kind === 'catalog' ? freshModuleId(work, `placed-${index + 1}`) : `copy-${index + 1}`,
    ));
  } catch (error) {
    return invalid(error instanceof Error ? error.message : '配置できません');
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
