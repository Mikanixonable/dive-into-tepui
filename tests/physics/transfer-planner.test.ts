// 遷移候補求解の回帰テスト。格子求解が「出発→(二体伝播)→到着」の整合を保つこと、
// 制約(期限・Δv 上限)が候補を削ることを固定する。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { motionOf, solarSystemParts } from './test-helpers';
import { planTransfers } from '../../src/physics/transfer-planner';
import { orbitalElementsOf, stateOnOrbitAt, keplerPeriod } from '../../src/physics/elements';
import { kinematicState } from '../../src/physics/kinematic-state';
import { add, len, sub, v3 } from '../../src/math/vec3';
import { MU_EARTH } from '../../src/game/celestial/solar-system/earth-system';

const R1 = 7_000e3;
const R2 = 20_000e3;

export function register(): void {
  test('transfer-planner: LEO→高軌道の位相点へ、到着が目標状態と一致する候補を返す', () => {
    const earth = motionOf(solarSystemParts(), 'earth');
    const t0 = 1_000;
    const c0 = earth.stateAt(t0);
    const vCirc1 = Math.sqrt(MU_EARTH / R1);
    // 出発側: 円軌道 (R1, 赤道面)。
    const ship = kinematicState<'eci'>(t0, add(c0.r, v3(R1, 0, 0)), add(c0.v, v3(0, 0, vCirc1)));

    // 目標: 同じ面の高い円軌道を回る位相点(仮想衛星)。
    const vCirc2 = Math.sqrt(MU_EARTH / R2);
    const n2 = Math.sqrt(MU_EARTH / R2 ** 3);
    const phase0 = 0.7;
    const targetStateAt = (t: number) => {
      const ct = earth.stateAt(t);
      const th = phase0 + n2 * (t - t0);
      return kinematicState<'eci'>(
        t,
        add(ct.r, v3(R2 * Math.cos(th), 0, R2 * Math.sin(th))),
        add(ct.v, v3(-vCirc2 * Math.sin(th), 0, vCirc2 * Math.cos(th))),
      );
    };

    const cands = planTransfers(
      ship, earth, { stateAt: targetStateAt, period: keplerPeriod(R2, MU_EARTH) });
    assert.ok(cands.length > 0, '候補が1件も無い');
    for (const c of cands) {
      assert.ok(c.departAt > t0 && c.arriveAt > c.departAt);
      assert.ok(c.deltaV > 0 && c.nodes.length === 2);
      // 出発ノードの噴射後状態を二体伝播すると到着ノードの位置(=目標位置)へ着く。
      const el = orbitalElementsOf(c.nodes[0], earth, c.departAt);
      assert.ok(el !== null);
      const coasted = stateOnOrbitAt(el, c.arriveAt);
      assert.ok(coasted !== null);
      const ctr = earth.stateAt(c.arriveAt);
      const err = len(sub(add(coasted.r, ctr.r), c.nodes[1].r));
      assert.ok(err < 1e3, `到着位置のずれ ${err} m`);
      // 到着位置は目標位置そのもの。
      const tgt = targetStateAt(c.arriveAt);
      assert.ok(tgt !== null && len(sub(c.nodes[1].r, tgt.r)) < 1);
    }
  });

  test('transfer-planner: Δv 上限と到着期限が候補を削る', () => {
    const earth = motionOf(solarSystemParts(), 'earth');
    const t0 = 500;
    const c0 = earth.stateAt(t0);
    const ship = kinematicState<'eci'>(
      t0, add(c0.r, v3(R1, 0, 0)), add(c0.v, v3(0, 0, Math.sqrt(MU_EARTH / R1))));
    const vCirc2 = Math.sqrt(MU_EARTH / R2);
    const n2 = Math.sqrt(MU_EARTH / R2 ** 3);
    const target = {
      stateAt: (t: number) => {
        const ct = earth.stateAt(t);
        const th = n2 * t;
        return kinematicState<'eci'>(
          t, add(ct.r, v3(R2 * Math.cos(th), 0, R2 * Math.sin(th))),
          add(ct.v, v3(-vCirc2 * Math.sin(th), 0, vCirc2 * Math.cos(th))));
      },
      period: keplerPeriod(R2, MU_EARTH),
    };
    const all = planTransfers(ship, earth, target);
    const capped = planTransfers(ship, earth, target, { maxDeltaV: 3_500 });
    assert.ok(capped.length <= all.length);
    for (const c of capped) assert.ok(c.deltaV <= 3_500);
    const limit = t0 + 3 * keplerPeriod(R1, MU_EARTH);
    const bounded = planTransfers(ship, earth, target, { deadline: limit });
    for (const c of bounded) assert.ok(c.arriveAt <= limit);
  });
}
