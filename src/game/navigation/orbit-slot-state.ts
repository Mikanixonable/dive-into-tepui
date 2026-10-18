// 軌道標識の時刻問い合わせ。標識の状態(ECI 位置・速度)と周期は、参照軌道の記述と
// 時刻から physics/reference-orbit.ts が決める — ここは CelestialBodies を
// ReferenceOrbitEnv へ写す接続口。
import {
  type ReferenceOrbitEnv, referenceOrbitPeriod, referenceOrbitStateAt,
} from '../../physics/reference-orbit';
import type { OrbitSlot } from './orbit-slot';
import type { CelestialBodies } from '../celestial/celestial-bodies';
import type { KinematicState } from '../../physics/kinematic-state';

// CelestialBodies を参照軌道の環境として包む。family 型の族メンバー照合はまだ
// 台帳へ載る入力(カタログ線・配置フォーム)が無いので、メンバーと回転座標系は null を返す。
function orbitSlotEnv(env: CelestialBodies): ReferenceOrbitEnv {
  return {
    bodyById: (id) => env.findMotion(id),
    degree2Field: (id, t) => env.findMotion(id)?.degree2At(t) ?? undefined,
    familyMemberAt: () => null,
    rotatingFrameAt: () => null,
  };
}

// 標識の位相点の、時刻 t [simTime s] における ECI 状態。family で未解決なら null。
export function orbitSlotStateAt(slot: OrbitSlot, t: number, env: CelestialBodies): KinematicState | null {
  return referenceOrbitStateAt(slot.orbit, t, orbitSlotEnv(env));
}

// 標識の参照軌道の周期 [s]。求まらないときは null。
export function orbitSlotPeriod(slot: OrbitSlot, env: CelestialBodies): number | null {
  return referenceOrbitPeriod(slot.orbit, orbitSlotEnv(env));
}
