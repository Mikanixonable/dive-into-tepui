// 天体の親子階層・系所属・最強重力源から導く問い合わせ。描画資源を持たず、同じ入力へ同じ答えを返す。
import { attractorAccel, strongestAttractor } from '../../physics/attractor';
import type { CelestialMotion } from '../../physics/celestial-motion';
import { lenSq, type Vec3 } from '../../math/vec3';
import { isLagrangeId, lagrangeParentId } from './lagrange-id';
import { STICKY_MARGIN_SQ } from './nearby-system-tracker';

export interface CelestialQueryEntity {
  readonly id: string;
  readonly motion: CelestialMotion;
}

export function orderedEntitiesOf<T extends CelestialQueryEntity>(
  entities: readonly T[],
): readonly { readonly entity: T; readonly depth: number }[] {
  const ordered: { entity: T; depth: number }[] = [];
  const added = new Set<string>();
  const append = (entity: T, depth: number): void => {
    if (added.has(entity.id)) return;
    added.add(entity.id);
    ordered.push({ entity, depth });
    for (const child of entities) {
      if (child.motion.primary?.id === entity.id) append(child, depth + 1);
    }
  };
  for (const entity of entities) if (entity.motion.primary === null) append(entity, 0);
  for (const entity of entities) append(entity, 0);
  return ordered;
}

function entityMap<T extends CelestialQueryEntity>(entities: readonly T[]): ReadonlyMap<string, T> {
  return new Map(entities.map(entity => [entity.id, entity]));
}

export function sameSystemIds(
  focusId: string | null, motions: readonly CelestialMotion[], entities: readonly CelestialQueryEntity[],
): ReadonlySet<string> {
  if (focusId === null) return new Set();
  const byId = entityMap(entities);
  const parent = byId.get(focusId)?.motion.primary?.id ?? null;
  const ids = new Set<string>([focusId]);
  if (parent !== null) ids.add(parent);
  for (const motion of motions) {
    const primary = motion.primary?.id ?? null;
    if (primary === focusId || (parent !== null && primary === parent)) ids.add(motion.id);
  }
  return ids;
}

export function ancestorsOf(
  focusId: string, entities: readonly CelestialQueryEntity[],
): readonly string[] {
  const byId = entityMap(entities);
  const chain: string[] = [];
  let current: string | null = focusId;
  for (let i = 0; current !== null && i <= entities.length; i++) {
    if (chain.includes(current)) break;
    chain.push(current);
    current = byId.get(current)?.motion.primary?.id ?? null;
  }
  return chain;
}

export function isPositionInFocusedSystem(
  focusId: string | null, position: Vec3, pivot: number,
  motions: readonly CelestialMotion[], entities: readonly CelestialQueryEntity[],
): boolean {
  const byId = entityMap(entities);
  const focus = focusId === null ? null : byId.get(focusId)?.motion ?? null;
  if (focus === null) return true;
  const systemFocusId = focus.kind === 'satellite' ? focus.primary?.id ?? null : focus.id;
  if (systemFocusId === null) return false;
  const initial = strongestAttractor(position, motions, pivot).id;
  if (byId.get(initial)?.motion.kind === 'star') return true;
  let focusedAccelSq = 0;
  let outsideAccelSq = 0;
  for (const motion of motions) {
    const accelSq = lenSq(attractorAccel(position, motion, pivot));
    const inFocusedSystem = motion.id === systemFocusId
      || ancestorsOf(motion.id, entities).includes(systemFocusId);
    if (inFocusedSystem) focusedAccelSq = Math.max(focusedAccelSq, accelSq);
    else outsideAccelSq = Math.max(outsideAccelSq, accelSq);
  }
  return outsideAccelSq === 0 || focusedAccelSq >= outsideAccelSq / STICKY_MARGIN_SQ;
}

export function bodyParentId(id: string, entities: readonly CelestialQueryEntity[]): string | null {
  const byId = entityMap(entities);
  const lagrangeParent = isLagrangeId(id) ? lagrangeParentId(id) : null;
  if (lagrangeParent !== null) return byId.has(lagrangeParent) ? lagrangeParent : null;
  return byId.get(id)?.motion.primary?.id ?? null;
}

export function chainFrom(id: string, entities: readonly CelestialQueryEntity[]): readonly string[] {
  return entityMap(entities).has(id) ? ancestorsOf(id, entities) : [id];
}

export function systemChainAt(
  cameraPos: Vec3, pivot: number, motions: readonly CelestialMotion[], entities: readonly CelestialQueryEntity[],
): readonly string[] {
  if (entities.length === 0) return [];
  return chainFrom(strongestAttractor(cameraPos, motions, pivot).id, entities);
}

export function membersFrom(
  chain: readonly string[], motions: readonly CelestialMotion[], entities: readonly CelestialQueryEntity[],
): readonly string[] {
  const byId = entityMap(entities);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of chain) {
    if (!seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
    if ((byId.get(id)?.motion.primary ?? null) === null) continue;
    for (const child of motions) {
      if (seen.has(child.id) || (child.primary?.id ?? null) !== id) continue;
      seen.add(child.id);
      result.push(child.id);
    }
  }
  return result;
}

export function systemMembersAt(
  cameraPos: Vec3, pivot: number, motions: readonly CelestialMotion[], entities: readonly CelestialQueryEntity[],
): readonly string[] {
  return membersFrom(systemChainAt(cameraPos, pivot, motions, entities), motions, entities);
}
