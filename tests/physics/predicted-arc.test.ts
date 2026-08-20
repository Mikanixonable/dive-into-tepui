// game/simulation/predicted-arc.ts の回帰。実シミュレーションが状態を引く弧(consumable)の
// 刻みが simulationMaxStep に揃うことと、その刻み・間引きが表示期間(requiredEnd)に依存しない
// ことを固定する — 依存すると PREDICT パネルの選択が実体の軌道と HUD の読みを変えてしまう。
// consumable でない弧が requiredEnd に依存したままであることも併せて固定し、前者が
// 「requiredEnd が誰にも効かなくなった」ことの確認になっていないようにする。
import * as assert from 'node:assert/strict';
import { test } from './harness';
import { Attractor } from '../../src/physics/attractor';
import { KinematicState, kinematicState } from '../../src/physics/kinematic-state';
import { MU_EARTH, R_EARTH } from '../../src/physics/solar-system';
import { v3 } from '../../src/physics/vec3';
import { PredictedArc } from '../../src/game/simulation/predicted-arc';
import type { FutureAttractorProvider } from '../../src/game/simulation/arc-bodies';

function circularState(t = 0): KinematicState {
  const r0 = R_EARTH + 420e3;
  const vc = Math.sqrt(MU_EARTH / r0);
  return kinematicState(t, v3(r0, 0, 0), v3(0, vc, 0));
}

// 地球1体だけを引く provider。地球は ECI 原点に静止させる(dynamic-trajectory.test.ts の EARTH と同じ)。
function earthOnlyProvider(): FutureAttractorProvider {
  const earthAt = (t: number): Attractor => ({
    id: 'earth', mu: MU_EARTH, radius: R_EARTH,
    state: kinematicState(t, v3(), v3()), accel: v3(), degree2: null, isStar: false,
  });
  return {
    revision: 0,
    candidateRevision: 0,
    candidates: () => [{ id: 'earth', mu: MU_EARTH, radius: R_EARTH }],
    bodyAt: (_id, t) => earthAt(t),
  };
}

// 弧を steps 歩ぶん伸ばし、毎歩の先端時刻を集める。
function tipTimes(arc: PredictedArc, steps: number): number[] {
  const times: number[] = [];
  for (let i = 0; i < steps; i++) {
    assert.ok(arc.step(), `step ${i} should still grow within requiredEnd`);
    times.push(arc.trajectory.state.t);
  }
  return times;
}

export function register(): void {
  test('predicted-arc: consumable な弧の刻みは simulationMaxStep を超えず、接近していない円軌道ではちょうど simulationMaxStep になる', () => {
    const state0 = circularState();
    const arc = new PredictedArc(state0, earthOnlyProvider(), 0, 0, /* keplerTail */ true, /* consumable */ true);
    arc.requiredEnd = state0.t + 86400; // 1日ぶん先まで伸びてよいことにする(十分大きい)
    arc.retainFrom = state0.t;
    arc.simulationMaxStep = 20;

    let prevT = state0.t;
    for (let i = 0; i < 300; i++) {
      assert.ok(arc.step(), `step ${i} should grow`);
      const t = arc.trajectory.state.t;
      const dt = t - prevT;
      assert.ok(dt <= 20 + 1e-6, `step ${i}: dt=${dt} exceeds simulationMaxStep=20`);
      assert.ok(Math.abs(dt - 20) < 1e-6, `step ${i}: 地球に接近していない円軌道では刻みは simulationMaxStep ちょうどのはず, got ${dt}`);
      prevT = t;
    }
  });

  test('predicted-arc: consumable な弧は再突入域で実シミュレーションと同じ 1s 刻みへ落ちる', () => {
    // 大気の密度は 1 スケールハイトで桁が変わるので、降下中は実シミュレーションと同じ細分化が要る。
    const r0 = R_EARTH + 150e3; // REENTRY_SUBSTEP_ALT(200km)より下
    const state0 = kinematicState(0, v3(r0, 0, 0), v3(0, Math.sqrt(MU_EARTH / r0), 0));
    const arc = new PredictedArc(state0, earthOnlyProvider(), 0, 0, /* keplerTail */ true, /* consumable */ true);
    arc.requiredEnd = state0.t + 86400;
    arc.retainFrom = state0.t;
    arc.simulationMaxStep = 20;

    let prevT = state0.t;
    for (let i = 0; i < 50; i++) {
      assert.ok(arc.step(), `step ${i} should grow`);
      const dt = arc.trajectory.state.t - prevT;
      assert.ok(Math.abs(dt - 1) < 1e-6, `step ${i}: 再突入域では刻みは 1s のはず, got ${dt}`);
      prevT = arc.trajectory.state.t;
    }
  });

  test('predicted-arc: consumable な弧の刻みは simulationMaxStep の値をそのまま反映する', () => {
    const state0 = circularState();
    const arc = new PredictedArc(state0, earthOnlyProvider(), 0, 0, /* keplerTail */ true, /* consumable */ true);
    arc.requiredEnd = state0.t + 86400;
    arc.retainFrom = state0.t;
    arc.simulationMaxStep = 34.1;

    let prevT = state0.t;
    for (let i = 0; i < 300; i++) {
      assert.ok(arc.step(), `step ${i} should grow`);
      const t = arc.trajectory.state.t;
      const dt = t - prevT;
      assert.ok(Math.abs(dt - 34.1) < 1e-6, `step ${i}: expected dt=34.1, got ${dt}`);
      prevT = t;
    }
  });

  test('predicted-arc: consumable な弧の刻み・間引きは requiredEnd を変えても変わらない', () => {
    const state0 = circularState();
    const retainFrom = state0.t;

    const shortArc = new PredictedArc(state0, earthOnlyProvider(), 0, 0, /* keplerTail */ true, /* consumable */ true);
    shortArc.requiredEnd = state0.t + 86400; // 1日
    shortArc.retainFrom = retainFrom;
    shortArc.simulationMaxStep = 20;

    const longArc = new PredictedArc(state0, earthOnlyProvider(), 0, 0, /* keplerTail */ true, /* consumable */ true);
    longArc.requiredEnd = state0.t + 86400 * 28; // 28日
    longArc.retainFrom = retainFrom;
    longArc.simulationMaxStep = 20;

    // ARC_FINE_STEPS(512) を跨いで、毎歩保持 → 周期基準の間引きへ移る歩数まで進める。
    const steps = 800;
    const shortTimes = tipTimes(shortArc, steps);
    const longTimes = tipTimes(longArc, steps);
    assert.deepEqual(shortTimes, longTimes, '先端時刻の列が requiredEnd で変わってはいけない');

    const shortSamples = shortArc.trajectory.samplesOldestFirst();
    const longSamples = longArc.trajectory.samplesOldestFirst();
    assert.equal(shortSamples.length, longSamples.length, '保持サンプルの件数が requiredEnd で変わってはいけない');
    for (let i = 0; i < shortSamples.length; i++) {
      assert.equal(shortSamples[i]!.t, longSamples[i]!.t, `sample ${i} の時刻が requiredEnd で変わってはいけない`);
    }
  });

  test('predicted-arc: consumable でない弧(計画の区間)は requiredEnd に依存したまま', () => {
    const state0 = circularState();
    const retainFrom = state0.t;

    const shortArc = new PredictedArc(state0, earthOnlyProvider(), 0, 0, /* keplerTail */ true, /* consumable */ false);
    shortArc.requiredEnd = state0.t + 86400; // 1日
    shortArc.retainFrom = retainFrom;

    const longArc = new PredictedArc(state0, earthOnlyProvider(), 0, 0, /* keplerTail */ true, /* consumable */ false);
    longArc.requiredEnd = state0.t + 86400 * 28; // 28日
    longArc.retainFrom = retainFrom;

    const steps = 20;
    const shortTimes = tipTimes(shortArc, steps);
    const longTimes = tipTimes(longArc, steps);
    assert.notDeepEqual(shortTimes, longTimes, 'consumable でない弧は requiredEnd で刻みが変わるはず');
  });
}
