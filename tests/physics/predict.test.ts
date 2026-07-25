// predict.ts の回帰テスト。
// - predictTrajectory は state0 起点で単一 arc を自由伝播し、軌道点列を返す。
// - propagateState は targetT までの終端状態だけを返す。同じ刻み系列で積分するので、
//   predictTrajectory を targetT まで回した終端と一致するはず(自己整合)。
// マニューバノードによる区間分割は plan 側の責務なので、ここでは扱わない。
// 数値予測の絶対値そのものは実測基準(RK4 の刻み・間引きに依存)なので、往復・自己
// 整合の形で挙動を固定する。
import * as assert from 'node:assert/strict';
import { test } from './harness';
import { MU_EARTH, R_EARTH, orbitState } from '../../src/physics/orbital';
import { predictTrajectory, propagateState, sampleAt } from '../../src/physics/predict';
import { Ephemeris } from '../../src/physics/ephemeris';
import { len, sub, v3 } from '../../src/physics/vec3';

// 決定的な位相(既定の moonPhase0 は乱数なので明示指定する)。
const EPHEMERIS = new Ephemeris(0, 0);
const MAX_SAMPLES = 2000;

// 420km 円軌道(赤道面)の状態。
function circularState() {
  const r0 = R_EARTH + 420e3;
  const vc = Math.sqrt(MU_EARTH / r0);
  return orbitState(0, v3(r0, 0, 0), v3(0, vc, 0));
}

export function register(): void {
  test('predict: trajectory stays a bounded orbit (radius near-constant)', () => {
    const s0 = circularState();
    const r0 = len(s0.r);
    const samples = predictTrajectory(s0, 3000, EPHEMERIS, MAX_SAMPLES);
    assert.ok(samples.length > 2, 'expected multiple samples');
    // 円軌道なので全サンプルの動径は初期値付近に留まる。J2(赤道扁平)と第三体で
    // 0.1〜数% 程度は変動するので、暴走しない範囲を実測基準で緩く固定する。
    for (const s of samples) {
      assert.ok(Math.abs(len(s.r) - r0) / r0 < 1e-2, 'radius drifted too much on circular orbit');
    }
  });

  test('predict: propagateState matches the free-propagation endpoint', () => {
    const s0 = circularState();
    const targetT = 1500;
    const arriving = propagateState(s0, targetT, EPHEMERIS);

    // 同じ刻み系列で targetT まで積分した終端(predictTrajectory)と一致するはず。
    const free = predictTrajectory(s0, targetT, EPHEMERIS, MAX_SAMPLES);
    const end = free[free.length - 1]!;
    assert.ok(Math.abs(end.t - targetT) < 1e-6, 'free propagation should end at targetT');
    assert.ok(Math.abs(arriving.t - targetT) < 1e-6, 'propagateState should end at targetT');
    assert.ok(len(sub(arriving.r, end.r)) < 1e-6, 'arriving position should match free propagation');
    assert.ok(len(sub(arriving.v, end.v)) < 1e-9, 'arriving velocity should match free propagation');
  });

  test('predict: propagateState leaves the input state unmutated', () => {
    const s0 = circularState();
    const r0 = { ...s0.r };
    const v0 = { ...s0.v };
    propagateState(s0, 1500, EPHEMERIS);
    assert.ok(len(sub(s0.r, r0)) === 0 && len(sub(s0.v, v0)) === 0, 'input state must not be mutated');
  });

  test('predict: sampleAt interpolates within the trajectory', () => {
    const s0 = circularState();
    const samples = predictTrajectory(s0, 3000, EPHEMERIS, MAX_SAMPLES);
    const mid = sampleAt(samples, 1500);
    assert.ok(mid, 'expected a sample at t=1500');
    assert.ok(Math.abs(mid!.t - 1500) < 1e-6, 'sampleAt should return the requested time');
    // 補間点も円軌道の動径付近に留まる。
    assert.ok(Math.abs(len(mid!.r) - len(s0.r)) / len(s0.r) < 1e-2, 'interpolated radius stays bounded');
  });
}
