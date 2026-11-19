// 航行指令の目標解決・候補適用・求解中の時刻バリアの回帰テスト。
import assert from 'node:assert/strict';
import { test } from '../harness';
import { solarSystemParts, stateOf } from '../physics/test-helpers';
import { transferTargetOf } from '../../src/game/navigation/transfer-target';
import {
  applyTransferCandidate, commitTransferCandidate, type TransferCommandHost,
} from '../../src/game/navigation/transfer-command';
import { OrbitSlotRegistry } from '../../src/game/navigation/orbit-slot-registry';
import { planTransfers, type TransferCandidate } from '../../src/physics/transfer-planner';
import { keplerPeriod } from '../../src/physics/elements';
import { Plan, type PlanExecutionMode } from '../../src/game/plan/plan';
import { kinematicState, type KinematicState } from '../../src/physics/kinematic-state';
import { add, sub, len, v3 } from '../../src/math/vec3';
import { R_EARTH, MU_EARTH } from '../../src/game/celestial/solar-system/earth-system';
import type { DynamicEntity } from '../../src/game/dynamic/dynamic-entity/dynamic-entity';

const SYSTEM = solarSystemParts().system;
const EMPTY_SLOTS = OrbitSlotRegistry.create();

const LEO_ORBIT = {
  kind: 'elements' as const,
  bodyId: 'earth', epoch: 0,
  a: R_EARTH + 400e3, e: 0.001, i: 0.9, raan: 0.3, argPeriapsis: 0.7, meanAnomaly0: 1.2,
};

// id だけを持つ生存中の戦闘対象の偽物。stateAt は与えた状態をそのまま返す。
function fakeTarget(id: string, state: KinematicState): DynamicEntity {
  return {
    id,
    combatTarget: true,
    motion: { alive: true, state, stateAt: () => state },
  } as unknown as DynamicEntity;
}

// 出発側の円軌道(earth 周回)と、それへ向かう候補を1件以上組む道具。
function leoShipAndTarget(): { ship: KinematicState; candidates: readonly TransferCandidate[] } {
  const earth = SYSTEM.motionOf('earth');
  const t0 = 1_000;
  const c0 = earth.stateAt(t0);
  const ship = kinematicState<'eci'>(
    t0, add(c0.r, v3(R_EARTH + 400e3, 0, 0)), add(c0.v, v3(0, 0, Math.sqrt(MU_EARTH / (R_EARTH + 400e3)))),
  );
  const r2 = R_EARTH + 20_000e3;
  const vCirc2 = Math.sqrt(MU_EARTH / r2);
  const n2 = Math.sqrt(MU_EARTH / r2 ** 3);
  const target = {
    stateAt: (t: number) => {
      const ct = earth.stateAt(t);
      const th = 0.7 + n2 * (t - t0);
      return kinematicState<'eci'>(
        t, add(ct.r, v3(r2 * Math.cos(th), 0, r2 * Math.sin(th))),
        add(ct.v, v3(-vCirc2 * Math.sin(th), 0, vCirc2 * Math.cos(th))),
      );
    },
    period: keplerPeriod(r2, MU_EARTH),
  };
  return { ship, candidates: planTransfers(ship, earth, target) };
}

// commitTransferCandidate が書き込む艦の偽物。
function fakeHost(state: KinematicState): TransferCommandHost & { mode: PlanExecutionMode } {
  return {
    plan: Plan.create(),
    motion: { state },
    mode: 'none' as PlanExecutionMode,
    setPlanExecution(mode) { this.mode = mode; },
  };
}

export function register(): void {
  test('transfer-target: 天体 id はその運動から状態を引き、公転周期を持つ', () => {
    const target = transferTargetOf('earth', SYSTEM, [], EMPTY_SLOTS, null, 0);
    assert.ok(target !== null);
    const t = 12_345;
    const direct = stateOf(solarSystemParts(), 'earth', t);
    const via = target.stateAt(t);
    assert.ok(via !== null && len(sub(via.r, direct.r)) < 1e-3);
    // 地球の公転周期(約1年)。
    assert.ok(target.period !== null && Math.abs(target.period - 365.25 * 86400) < 5 * 86400);
  });

  test('transfer-target: 軌道標識 id は台帳の位相点を目標にし、未知の id は null', () => {
    const slots = OrbitSlotRegistry.create();
    const slot = slots.add(LEO_ORBIT);
    const target = transferTargetOf(slot.id, SYSTEM, [], slots, null, 0);
    assert.ok(target !== null);
    assert.ok(target.stateAt(10_000) !== null);
    assert.ok(target.period !== null && target.period > 0);
    assert.equal(transferTargetOf('missing', SYSTEM, [], slots, null, 0), null);
  });

  test('transfer-target: 個体 id は motion の予測状態を引き、死んだ個体は null', () => {
    const state = kinematicState<'eci'>(0, v3(1e6, 0, 0), v3(0, 1e3, 0));
    const entities = [fakeTarget('enemy-1', state)];
    const target = transferTargetOf('enemy-1', SYSTEM, entities, EMPTY_SLOTS, null, 0);
    assert.ok(target !== null);
    assert.equal(target.stateAt(42), state);
    const dead = { ...fakeTarget('enemy-2', state), motion: { alive: false, state, stateAt: () => state } };
    assert.equal(transferTargetOf('enemy-2', SYSTEM, [dead as unknown as DynamicEntity], EMPTY_SLOTS, null, 0), null);
  });

  test('transfer-command: 候補の適用で計画に2ノードが書かれ、実行モードが自動操縦になる', () => {
    const { ship, candidates } = leoShipAndTarget();
    assert.ok(candidates.length > 0, '候補が1件も無い');
    const host = fakeHost(ship);
    commitTransferCandidate(host, candidates[0]!);
    assert.equal(host.plan.nodes.length, 2);
    assert.equal(host.mode, 'autopilot');
    // 起点は適用時点の実状態、ノードは実行時刻順に出発→到着。
    assert.equal(host.plan.anchorOr(ship).t, ship.t);
    assert.equal(host.plan.nodes[0]!.t, candidates[0]!.departAt);
    assert.equal(host.plan.nodes[1]!.t, candidates[0]!.arriveAt);
  });

  test('transfer-command: applyTransferCandidate は起点以前のノードを除き時刻順に置き直す', () => {
    const { ship, candidates } = leoShipAndTarget();
    assert.ok(candidates.length > 0);
    const plan = Plan.create();
    const later = kinematicState<'eci'>(ship.t + 10, ship.r, ship.v);
    applyTransferCandidate(plan, later, candidates[0]!);
    // anchor が解決時より後でも、anchor より後のノードだけが残る。
    for (const node of plan.nodes) assert.ok(node.t > later.t);
  });
}
