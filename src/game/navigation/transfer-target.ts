// 航行指令の目標を、被選択物・ターゲットの id から TransferPlannerTarget へ解決する。
// 軌道標識は位相点の参照軌道、天体はその運動、個体は motion の予測状態を、求解の
// 時刻問い合わせ口へ包む。pivot は解決時の時刻(周期などの静的な目安を決める時刻)。
import { orbitalElementsOf } from '../../physics/elements';
import { strongestAttractor } from '../../physics/attractor';
import type { TransferPlannerTarget } from '../../physics/transfer-planner';
import { aliveCombatTarget } from '../dynamic/dynamic-entity/combat-target';
import type { DynamicEntity } from '../dynamic/dynamic-entity/dynamic-entity';
import type { CelestialBodies } from '../celestial/celestial-bodies';
import type { OrbitSlotRegistry } from './orbit-slot-registry';
import type { OrbitSlotCatalogAccess } from './orbit-slot-family';
import { orbitSlotTarget } from './transfer-command';

// id が指す目標を TransferPlannerTarget へ解決する。目標になれない id
// (未登録・ラグランジュ点・消滅した個体)は null。
export function transferTargetOf(
  id: string,
  env: CelestialBodies,
  entities: readonly DynamicEntity[],
  slots: OrbitSlotRegistry,
  catalog: OrbitSlotCatalogAccess | null,
  pivot: number,
): TransferPlannerTarget | null {
  // 登録天体は、その運動から任意時刻の状態を引ける。
  const body = env.findMotion(id);
  if (body !== null) {
    const primary = body.primary;
    return {
      stateAt: (t) => body.stateAt(t),
      // 周期は出発格子の目安でしかない。主天体を持つ天体は公転周期、恒星は null。
      period: primary === null
        ? null
        : orbitalElementsOf(body.stateAt(pivot), primary, pivot)?.period ?? null,
    };
  }
  // 軌道標識は、台帳に残っている限り位相点の状態を参照軌道から引く。
  const slot = slots.find(id);
  if (slot !== null) return orbitSlotTarget(slot, env, catalog);
  // 残りは生存中の艦・敵・基地。状態は積分の履歴と予測が届く範囲に限られる。
  const entity = aliveCombatTarget(entities, id);
  if (entity === null) return null;
  const attractor = strongestAttractor(entity.motion.state.r, env.celestialMotions, pivot);
  return {
    stateAt: (t) => entity.motion.stateAt(t, env),
    period: orbitalElementsOf(entity.motion.state, attractor, pivot)?.period ?? null,
  };
}
