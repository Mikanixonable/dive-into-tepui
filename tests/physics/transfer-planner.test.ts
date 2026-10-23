// 遷移候補求解の回帰テスト。格子求解が「出発→(二体伝播)→到着」の整合を保つこと、
// 制約(期限・Δv 上限)が候補を削ることを固定する。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { fixedMotion, motionOf, solarSystemParts } from './test-helpers';
import { planTransfers } from '../../src/physics/transfer-planner';
import { orbitalElementsOf, stateOnOrbitAt, keplerPeriod } from '../../src/physics/elements';
import { kinematicState } from '../../src/physics/kinematic-state';
import { add, dot, len, sub, v3 } from '../../src/math/vec3';
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

  // 出発側・目標側とも赤道面内の円軌道を回る幾何を組む道具。既定テストと同じ回転方向。
  const coplanarSetup = (rTarget: number, phase0: number, t0: number) => {
    const earth = motionOf(solarSystemParts(), 'earth');
    const c0 = earth.stateAt(t0);
    const ship = kinematicState<'eci'>(
      t0, add(c0.r, v3(R1, 0, 0)), add(c0.v, v3(0, 0, Math.sqrt(MU_EARTH / R1))));
    const vCircT = Math.sqrt(MU_EARTH / rTarget);
    const nT = Math.sqrt(MU_EARTH / rTarget ** 3);
    const target = {
      stateAt: (t: number) => {
        const ct = earth.stateAt(t);
        const th = phase0 + nT * (t - t0);
        return kinematicState<'eci'>(
          t,
          add(ct.r, v3(rTarget * Math.cos(th), 0, rTarget * Math.sin(th))),
          add(ct.v, v3(-vCircT * Math.sin(th), 0, vCircT * Math.cos(th))),
        );
      },
      period: keplerPeriod(rTarget, MU_EARTH),
    };
    return { earth, ship, target };
  };

  test('transfer-planner: 周回を挟む低エネルギー候補は直行より Δv が小さく到着が遅い', () => {
    const t0 = 1_000;
    const { earth, ship, target } = coplanarSetup(R2, 0.7, t0);
    const cands = planTransfers(ship, earth, target, { maxCandidates: 512 });
    const direct = cands.filter((c) => c.method === 'lambert');
    const low = cands.filter((c) => c.method === 'low-energy');
    assert.ok(direct.length > 0, '直行候補が無い');
    assert.ok(low.length > 0, '低エネルギー候補が無い');
    const bestDirect = direct.reduce((m, c) => Math.min(m, c.deltaV), Infinity);
    const bestLow = low.reduce((m, c) => Math.min(m, c.deltaV), Infinity);
    assert.ok(bestLow < bestDirect, `低エネルギー最良 ${bestLow} が直行最良 ${bestDirect} を下回らない`);
    // 低エネルギー候補は出発周期より長い飛行時間を持つ。
    for (const c of low) {
      assert.ok(c.arriveAt - c.departAt > keplerPeriod(R1, MU_EARTH));
    }
    // 低エネルギー最良は直行最良より遅く着く。
    const slowest = low.find((c) => c.deltaV === bestLow);
    const fastest = direct.find((c) => c.deltaV === bestDirect);
    assert.ok(slowest !== undefined && fastest !== undefined);
    assert.ok(slowest.arriveAt > fastest.arriveAt);
  });

  test('transfer-planner: 二重楕円候補は中間遠点を経る3インパルスで出発経度へ戻る', () => {
    const t0 = 1_000;
    const { earth, ship, target } = coplanarSetup(R2, 0.7, t0);
    const cands = planTransfers(ship, earth, target, { maxCandidates: 512 });
    const bi = cands.filter((c) => c.method === 'bi-elliptic');
    assert.ok(bi.length > 0, '二重楕円候補が無い');
    for (const c of bi) {
      assert.equal(c.nodes.length, 3);
      // 中間ノードは両軌道半径より高い遠点で、出発点と正反対の経度にある。
      const relMid = sub(c.nodes[1].r, earth.stateAt(c.nodes[1].t).r);
      assert.ok(len(relMid) > R2 && len(relMid) > R1);
      const relD = sub(c.nodes[0].r, earth.stateAt(c.departAt).r);
      assert.ok(dot(relMid, relD) < 0, '中間遠点が出発点と同じ側にある');
      // 到着点の経度は出発点へ戻る。
      const relA = sub(c.nodes[2].r, earth.stateAt(c.arriveAt).r);
      const cos = dot(relD, relA) / (len(relD) * len(relA));
      assert.ok(cos > 0.99, `到着経度が出発経度へ戻っていない (cos=${cos})`);
      // 到着ノードは目標状態そのもの。
      const tgt = target.stateAt(c.arriveAt);
      assert.ok(tgt !== null && len(sub(c.nodes[2].r, tgt.r)) < 1);
    }
  });

  test('transfer-planner: 大気減速候補は大気を持つ天体で遠点円化の3インパルスを持つ', () => {
    // 指数大気1層を持つ静止した惑星。密度は 1 パスで遠点を半分程度削れる深さが
    // 廊下の中に来るよう、テスト用の値(地表密度 0.5 kg/m³・スケールハイト 50 km)を置く。
    const RADIUS = 6_400e3;
    const ATM = {
      equatorRadius: RADIUS, polarRadius: RADIUS, spinRate: 0, pole: v3(0, 1, 0),
      layers: [[0, 0.5, 50e3]] as const,
    };
    const planet = fixedMotion({
      id: 'aero-planet', mu: MU_EARTH, radius: RADIUS,
      state: kinematicState<'eci'>(0, v3(), v3()), atmosphere: ATM,
    });
    const R_HIGH = 30_000e3;
    const R_LOW = 8_000e3;
    const t0 = 0;
    const ship = kinematicState<'eci'>(t0, v3(R_HIGH, 0, 0), v3(0, 0, Math.sqrt(MU_EARTH / R_HIGH)));
    const vLow = Math.sqrt(MU_EARTH / R_LOW);
    const nLow = Math.sqrt(MU_EARTH / R_LOW ** 3);
    const target = {
      stateAt: (t: number) => kinematicState<'eci'>(
        t,
        v3(R_LOW * Math.cos(nLow * t), 0, R_LOW * Math.sin(nLow * t)),
        v3(-vLow * Math.sin(nLow * t), 0, vLow * Math.cos(nLow * t)),
      ),
      period: keplerPeriod(R_LOW, MU_EARTH),
    };
    const cands = planTransfers(ship, planet, target, { bcInv: 0.02, maxCandidates: 512 });
    const aero = cands.filter((c) => c.method === 'aerobrake');
    assert.ok(aero.length > 0, '大気減速候補が無い');
    const direct = cands.filter((c) => c.method === 'lambert');
    assert.ok(direct.length > 0);
    for (const c of aero) {
      assert.equal(c.nodes.length, 3);
      // 中間ノード(近点トリム)の遠点距離は目標半径と出発半径の間にある。
      const rMid = len(sub(c.nodes[1].r, planet.stateAt(c.nodes[1].t).r));
      assert.ok(rMid > R_LOW && rMid < R_HIGH, `中間遠点 ${rMid} が範囲外`);
    }
    // 抗力で遠点を削るので、推進 Δv は直行候補の最良を下回る。
    const bestAero = aero.reduce((m, c) => Math.min(m, c.deltaV), Infinity);
    const bestDirect = direct.reduce((m, c) => Math.min(m, c.deltaV), Infinity);
    assert.ok(bestAero < bestDirect, `大気減速最良 ${bestAero} が直行最良 ${bestDirect} を下回らない`);

    // 大気を持たない天体・弾道係数の指定がない呼び出しでは候補に出ない。
    const bare = fixedMotion({
      id: 'aero-bare', mu: MU_EARTH, radius: RADIUS, state: kinematicState<'eci'>(0, v3(), v3()),
    });
    const noAtm = planTransfers(ship, bare, target, { bcInv: 0.02, maxCandidates: 512 });
    assert.equal(noAtm.filter((c) => c.method === 'aerobrake').length, 0);
    const noBc = planTransfers(ship, planet, target, { maxCandidates: 512 });
    assert.equal(noBc.filter((c) => c.method === 'aerobrake').length, 0);
  });
}
