// 軌道標識の時刻問い合わせ。標識の状態(ECI 位置・速度)と周期は、参照軌道の記述と
// 時刻から physics/reference-orbit.ts が決める — ここは CelestialBodies と軌道族カタログを
// ReferenceOrbitEnv へ写す接続口。
import {
  type ReferenceOrbitEnv, referenceOrbitPeriod, referenceOrbitStateAt,
} from '../../physics/reference-orbit';
import type { OrbitSlot } from './orbit-slot';
import { orbitSlotFamilyMember, slotRotatingFrameAt, type OrbitSlotCatalogAccess } from './orbit-slot-family';
import type { CelestialBodies } from '../celestial/celestial-bodies';
import type { KinematicState } from '../../physics/kinematic-state';

// CelestialBodies(+カタログ)を参照軌道の環境として包む。カタログ族は catalog が系を
// 読み込み済みのときだけ状態を返す。
function orbitSlotEnv(env: CelestialBodies, catalog: OrbitSlotCatalogAccess | null): ReferenceOrbitEnv {
  return {
    bodyById: (id) => env.findMotion(id),
    degree2Field: (id, t) => env.findMotion(id)?.degree2At(t) ?? undefined,
    familyMemberAt: (orbit, t) => orbitSlotFamilyMember(orbit, t, env, catalog),
    rotatingFrameAt: (primaryId, secondaryId, t) => slotRotatingFrameAt(env, primaryId, secondaryId, t),
  };
}

// 標識の位相点の、時刻 t [simTime s] における ECI 状態。family で未解決なら null。
export function orbitSlotStateAt(
  slot: OrbitSlot, t: number, env: CelestialBodies, catalog: OrbitSlotCatalogAccess | null = null,
): KinematicState | null {
  return referenceOrbitStateAt(slot.orbit, t, orbitSlotEnv(env, catalog));
}

// 標識の参照軌道の周期 [s]。求まらないときは null。
export function orbitSlotPeriod(
  slot: OrbitSlot, env: CelestialBodies, catalog: OrbitSlotCatalogAccess | null = null,
): number | null {
  return referenceOrbitPeriod(slot.orbit, orbitSlotEnv(env, catalog));
}
