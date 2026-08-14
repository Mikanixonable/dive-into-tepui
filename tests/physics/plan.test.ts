// 計画の区間長・アプシス高度が、その場で最も強く引く天体を中心として求まることの回帰。
import * as assert from 'node:assert/strict';
import { Ephemeris, EPOCH_T_OFFSET } from '../../src/physics/ephemeris';
import { MU_MOON, R_MOON, SOLAR_SYSTEM } from '../../src/physics/solar-system';
import { orbitalElementsOf, strongestAttractor } from '../../src/physics/attractor';
import { kinematicState } from '../../src/physics/kinematic-state';
import { MU_EARTH, R_EARTH } from '../../src/physics/solar-system';
import { apsisAltitudes, keplerPeriod } from '../../src/physics/elements';
import { add, v3 } from '../../src/physics/vec3';
import { orbitPeriodOf, Plan } from '../../src/game/plan/plan';
import { test } from './harness';

export function register(): void {
  test('plan: 月周回の区間長・アプシスが月中心の状態と重力定数で求まる', () => {
    const ephemeris = new Ephemeris(SOLAR_SYSTEM, 'earth', EPOCH_T_OFFSET, { moon: 0 });
    const t = 12345;
    const radius = R_MOON + 100_000;
    const relativeR = v3(radius, 0, 0);
    const relativeV = v3(0, 0, Math.sqrt(MU_MOON / radius));
    const moonState = ephemeris.stateOf('moon', t);
    const state = kinematicState(
      t,
      add(moonState.r, relativeR),
      add(moonState.v, relativeV),
    );
    const attractors = ephemeris.attractorsAt(t);

    // 中心天体は設定ではなく状態から決まる。地球の μ で計算すると周期は約 1/9 になる。
    const center = strongestAttractor(state.r, attractors);
    assert.equal(center.id, 'moon');

    const expected = keplerPeriod(radius, MU_MOON);
    assert.ok(Math.abs(orbitPeriodOf(state, attractors) - expected) / expected < 1e-10);

    const plan = new Plan();
    const orbitDisplayDuration = { durationSec: (referencePeriod: number) => referencePeriod };
    assert.ok(Math.abs(plan.nodeTimeRange(0, state, ephemeris, orbitDisplayDuration).max - (t + expected)) < 1e-6);

    const el = orbitalElementsOf(state, center)!;
    assert.equal(el.center.mu, MU_MOON);
    const apsis = apsisAltitudes(el);
    assert.ok(Math.abs(apsis.pe - 100_000) < 1, `近点高度: ${apsis.pe}`);
    assert.ok(Math.abs(apsis.ap - 100_000) < 1, `遠点高度: ${apsis.ap}`);
  });

  test('plan: 近地点付近の遷移軌道の区間長が近地点半径の円軌道周期に短縮されない', () => {
    const ephemeris = new Ephemeris(SOLAR_SYSTEM, 'earth', EPOCH_T_OFFSET, { sun: 0, moon: 0 });
    const t = 6789;
    const rp = R_EARTH + 400e3;
    const ra = R_EARTH + 35_000e3;
    const a = (rp + ra) / 2;
    const vp = Math.sqrt(MU_EARTH * (2 / rp - 1 / a));
    const state = kinematicState(t, v3(rp, 0, 0), v3(0, 0, vp));
    const attractors = ephemeris.attractorsAt(t);

    const expected = keplerPeriod(a, MU_EARTH);
    const actual = orbitPeriodOf(state, attractors);
    assert.ok(Math.abs(actual - expected) / expected < 1e-6, `周期: ${actual}, 期待値: ${expected}`);

    const circularAtPerigee = keplerPeriod(rp, MU_EARTH);
    assert.ok(actual > circularAtPerigee * 2, `近地点半径基準の円軌道周期に短縮されている: ${actual}`);
  });

  test('plan: nodeTimeRange は DisplayDurationSource の表示期間にそのまま追従する', () => {
    const ephemeris = new Ephemeris(SOLAR_SYSTEM, 'earth', EPOCH_T_OFFSET, { sun: 0, moon: 0 });
    const t = 1000;
    const rp = R_EARTH + 400e3;
    const state = kinematicState(t, v3(rp, 0, 0), v3(0, 0, Math.sqrt(MU_EARTH / rp)));
    const attractors = ephemeris.attractorsAt(t);
    const period = orbitPeriodOf(state, attractors);

    const plan = new Plan();

    // 'orbit' 相当のスタブ: 参照期間(起点の軌道周期)をそのまま返す
    const orbitDuration = { durationSec: (referencePeriod: number) => referencePeriod };
    assert.ok(Math.abs(plan.nodeTimeRange(0, state, ephemeris, orbitDuration).max - (t + period)) < 1e-6);

    // 固定プリセット相当のスタブ: 参照期間によらず一定値を返す
    const fixedDuration = { durationSec: () => 86400 };
    assert.equal(plan.nodeTimeRange(0, state, ephemeris, fixedDuration).max, t + 86400);
  });

  test('plan: 起点が凍結されるのはノードがある間だけ', () => {
    const ship = kinematicState(0, v3(R_EARTH + 400e3, 0, 0), v3(0, 0, 7670));
    const later = kinematicState(100, v3(R_EARTH + 500e3, 0, 0), v3(0, 0, 7600));
    const plan = new Plan();

    // ノードが1件も無い間は、起点は毎回渡された自機状態そのもの。
    assert.equal(plan.anchorOr(ship), ship);
    assert.equal(plan.frozenData(), null);

    // 1件目を置いた時点で起点が凍結し、以降 anchorOr の引数は無視される。
    assert.equal(plan.addNode(kinematicState(50, ship.r, ship.v), ship), 0);
    assert.equal(plan.anchorOr(later), ship);
    assert.equal(plan.frozenData()?.anchor, ship);

    // 最後のノードが消えると起点も一緒に落ちる。
    plan.removeNode(0);
    assert.equal(plan.frozenData(), null);
    assert.equal(plan.anchorOr(later), later);
  });

  test('plan: 全ノードを消化すると起点も落ち、revision は空を跨いでも増え続ける', () => {
    const ship = kinematicState(0, v3(R_EARTH + 400e3, 0, 0), v3(0, 0, 7670));
    const reached = kinematicState(60, v3(R_EARTH + 410e3, 0, 0), v3(0, 0, 7660));
    const plan = new Plan();
    plan.addNode(kinematicState(50, ship.r, ship.v), ship);
    const revAfterAdd = plan.revision;

    assert.equal(plan.consumeNodesUpTo(55, reached), 1);
    assert.equal(plan.nodes.length, 0);
    assert.equal(plan.frozenData(), null);
    assert.ok(plan.revision > revAfterAdd);

    // 空にしてから積み直しても世代値は単調に増える(キャッシュ鍵として衝突しない)。
    plan.addNode(kinematicState(200, ship.r, ship.v), ship);
    assert.ok(plan.revision > revAfterAdd + 1);
  });
}
