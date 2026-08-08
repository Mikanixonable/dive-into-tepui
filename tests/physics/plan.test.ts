// 計画の区間長・アプシス高度が、その場で最も強く引く天体を中心として求まることの回帰。
import * as assert from 'node:assert/strict';
import { Ephemeris, MU_MOON, R_MOON } from '../../src/physics/ephemeris';
import { elementsAround, strongestAttractor } from '../../src/physics/attractor';
import { orbitState, MU_EARTH, R_EARTH } from '../../src/physics/orbital-state';
import { apsisAltitudes, keplerPeriod } from '../../src/physics/elements';
import { add, v3 } from '../../src/physics/vec3';
import { orbitPeriodOf, Plan } from '../../src/game/plan/plan';
import { test } from './harness';

export function register(): void {
  test('plan: 月周回の区間長・アプシスが月中心の状態と重力定数で求まる', () => {
    const ephemeris = new Ephemeris(0, 0);
    const t = 12345;
    const radius = R_MOON + 100_000;
    const relativeR = v3(radius, 0, 0);
    const relativeV = v3(0, 0, Math.sqrt(MU_MOON / radius));
    const state = orbitState(
      t,
      add(ephemeris.moonPosAt(t), relativeR),
      add(ephemeris.moonVelAt(t), relativeV),
    );
    const bodies = ephemeris.attractorsAt(t);

    // 中心天体は設定ではなく状態から決まる。地球の μ で計算すると周期は約 1/9 になる。
    const center = strongestAttractor(state.r, bodies);
    assert.equal(center.id, 'moon');

    const expected = keplerPeriod(radius, MU_MOON);
    assert.ok(Math.abs(orbitPeriodOf(state, bodies) - expected) / expected < 1e-10);

    const plan = new Plan();
    plan.trackAnchor(state);
    assert.ok(Math.abs(plan.nodeTimeRange(0, ephemeris).max - (t + expected)) < 1e-6);

    const el = elementsAround(state, center)!;
    assert.equal(el.center.mu, MU_MOON);
    const apsis = apsisAltitudes(el);
    assert.ok(Math.abs(apsis.pe - 100_000) < 1, `近点高度: ${apsis.pe}`);
    assert.ok(Math.abs(apsis.ap - 100_000) < 1, `遠点高度: ${apsis.ap}`);
  });

  test('plan: 近地点付近の遷移軌道の区間長が近地点半径の円軌道周期に短縮されない', () => {
    const ephemeris = new Ephemeris(0, 0);
    const t = 6789;
    const rp = R_EARTH + 400e3;
    const ra = R_EARTH + 35_000e3;
    const a = (rp + ra) / 2;
    const vp = Math.sqrt(MU_EARTH * (2 / rp - 1 / a));
    const state = orbitState(t, v3(rp, 0, 0), v3(0, 0, vp));
    const bodies = ephemeris.attractorsAt(t);

    const expected = keplerPeriod(a, MU_EARTH);
    const actual = orbitPeriodOf(state, bodies);
    assert.ok(Math.abs(actual - expected) / expected < 1e-6, `周期: ${actual}, 期待値: ${expected}`);

    const circularAtPerigee = keplerPeriod(rp, MU_EARTH);
    assert.ok(actual > circularAtPerigee * 2, `近地点半径基準の円軌道周期に短縮されている: ${actual}`);
  });
}
