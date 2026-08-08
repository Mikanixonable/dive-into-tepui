// physics/dynamic-trajectory.ts の回帰テスト。game/game-entity/game-entity.ts の GameEntity から
// 切り出した「時刻付き状態 + その手前のサンプル列(間引き済み)+ 自分を1ステップ進める能力」の
// 単体テスト(better_predict.md Step 2)。過去列にも将来列にも同じ実装を使う前提なので、
// ここでの検証は GameEntity.actualTrajectory(過去列側)としての用法をそのまま代表する。
import * as assert from 'node:assert/strict';
import { test } from './harness';
import { KinematicState, kinematicState } from '../../src/physics/kinematic-state';
import { MU_EARTH, R_EARTH } from '../../src/physics/solar-system';
import { DynamicTrajectory } from '../../src/physics/dynamic-trajectory';
import { Ephemeris } from '../../src/physics/ephemeris';
import { len, sub, v3 } from '../../src/physics/vec3';

const EPH = new Ephemeris({ moon: 0 }); // 初期位相を固定して決定的にする
const bodiesAt = (t: number) => EPH.attractorsAt(t); // step() が要求する重力源をステップ中点で引く

function circularState(t = 0): KinematicState {
  const r0 = R_EARTH + 420e3;
  const vc = Math.sqrt(MU_EARTH / r0);
  return kinematicState(t, v3(r0, 0, 0), v3(0, vc, 0));
}

export function register(): void {
  test('dynamic-trajectory: step only records a history sample once sampleInterval has elapsed', () => {
    const e = new DynamicTrajectory(circularState());
    const dt = 5;
    const sampleInterval = 23; // dt では割り切れない値にして端数の丸まり方を確認する
    for (let i = 0; i < 100; i++) {
      e.step(dt, bodiesAt(e.state.t + dt / 2), 0, null, sampleInterval, 100000);
    }
    // 500秒ぶん進めて間隔 23s なので、間引き後のサンプル数はおよそ 20 件前後のはず
    // (毎ステップ記録すれば100件になるところを大幅に間引けていることを確認する)。
    assert.ok(e.history.size > 5 && e.history.size < 30, `expected a decimated history, got ${e.history.size}`);
  });

  test('dynamic-trajectory: step never touches history when keepDuration is 0', () => {
    const e = new DynamicTrajectory(circularState());
    for (let i = 0; i < 50; i++) {
      e.step(1, bodiesAt(e.state.t + 0.5), 0, null, 1, 0);
    }
    assert.equal(e.history.size, 0);
  });

  test('dynamic-trajectory: keepDuration bounds how many history samples accumulate', () => {
    const e = new DynamicTrajectory(circularState());
    const dt = 10;
    const sampleInterval = 10; // 毎ステップ記録
    const keepDuration = 200; // 保持窓 200s ÷ 間隔 10s ≈ 20 件程度で頭打ちになるはず
    for (let i = 0; i < 500; i++) { // 5000秒ぶん進める(保持窓の25倍)
      e.step(dt, bodiesAt(e.state.t + dt / 2), 0, null, sampleInterval, keepDuration);
    }
    assert.ok(e.history.size < 30, `history should stay bounded by keepDuration, got ${e.history.size} samples`);
  });

  test('dynamic-trajectory: at() matches direct re-integration within interpolation error', () => {
    // 密なステップ(sampleInterval を実質無視)で真値の軌跡を作りつつ、同時に大きい
    // sampleInterval で間引いた DynamicTrajectory を並行して進め、任意時刻の at() が密な真値と
    // 近い(better_predict.md §4 実測の補間誤差 30m 程度)ことを確認する。
    const dense = new DynamicTrajectory(circularState());
    const sparse = new DynamicTrajectory(circularState());
    const dt = 5;
    const sampleInterval = 174; // LEO 1周32点相当の実測値
    const denseStates: KinematicState[] = [];
    for (let i = 0; i < 200; i++) {
      dense.step(dt, bodiesAt(dense.state.t + dt / 2), 0, null, dt, 1e6); // sampleInterval=dt → 実質毎ステップ記録
      sparse.step(dt, bodiesAt(sparse.state.t + dt / 2), 0, null, sampleInterval, 1e6);
      denseStates.push(dense.state);
    }
    const sample = denseStates[100]!; // 保持区間内の中間あたりの時刻
    const interpolated = sparse.at(sample.t);
    assert.ok(interpolated, 'expected an interpolated sample within the retained span');
    const err = len(sub(interpolated!.r, sample.r));
    assert.ok(err < 100, `interpolation error too large: ${err}m`);
  });

  test('dynamic-trajectory: reset discards history samples at or after the new state time', () => {
    const e = new DynamicTrajectory(circularState());
    const dt = 10;
    for (let i = 0; i < 10; i++) {
      e.step(dt, bodiesAt(e.state.t + dt / 2), 0, null, dt, 100000); // 毎ステップ記録: history = t=0..80, state.t=90
    }
    assert.ok(e.history.at(50), 'sanity: t=50 should be recorded before reset');
    e.reset(kinematicState(50, v3(1, 0, 0), v3(0, 1, 0)));
    assert.equal(e.history.at(50), null, 'the sample at the reset time itself should be discarded');
    assert.ok(e.history.at(30), 'samples strictly before the reset time should survive');
    assert.equal(e.state.t, 50);
  });

  test('dynamic-trajectory: prevState always reflects the state immediately before the last step/reset', () => {
    const e = new DynamicTrajectory(circularState());
    assert.equal(e.prevState.t, 0); // 初期状態では自分自身に退化(まだ一度も進んでいない)

    e.step(10, bodiesAt(e.state.t + 5), 0, null, 1000, 0); // keepDuration=0(history 不使用)でも prevState は更新される
    assert.equal(e.prevState.t, 0);
    assert.equal(e.state.t, 10);

    e.step(10, bodiesAt(e.state.t + 5), 0, null, 1000, 0);
    assert.equal(e.prevState.t, 10);
    assert.equal(e.state.t, 20);

    const before = e.state;
    e.reset(kinematicState(20, v3(1, 0, 0), v3(0, 1, 0)));
    assert.equal(e.prevState.t, before.t, 'reset should also advance prevState to the state it replaced');
  });

  test('dynamic-trajectory: at() returns state itself at t === state.t and null beyond it', () => {
    const e = new DynamicTrajectory(circularState());
    e.step(10, bodiesAt(e.state.t + 5), 0, null, 5, 100000);
    assert.equal(e.at(e.state.t), e.state);
    assert.equal(e.at(e.state.t + 1), null);
  });

  test('dynamic-trajectory: samplesOldestFirst is ordered oldest-to-newest and ends at state', () => {
    const e = new DynamicTrajectory(circularState());
    const dt = 10;
    const sampleInterval = 10; // 毎ステップ記録
    for (let i = 0; i < 20; i++) {
      e.step(dt, bodiesAt(e.state.t + dt / 2), 0, null, sampleInterval, 1e6);
    }
    const samples = e.samplesOldestFirst();
    for (let i = 1; i < samples.length; i++) {
      assert.ok(
        samples[i]!.t > samples[i - 1]!.t,
        `samples should be strictly ascending: ${samples.map((s) => s.t)}`,
      );
    }
    assert.equal(samples[samples.length - 1], e.state, 'the last sample should be the current state itself');
  });

  test('dynamic-trajectory: samplesOldestFirst is just [state] when history is empty', () => {
    const fresh = new DynamicTrajectory(circularState());
    const freshSamples = fresh.samplesOldestFirst();
    assert.equal(freshSamples.length, 1);
    assert.equal(freshSamples[0], fresh.state);

    const noHistory = new DynamicTrajectory(circularState());
    for (let i = 0; i < 10; i++) {
      noHistory.step(1, bodiesAt(noHistory.state.t + 0.5), 0, null, 1, 0); // keepDuration=0 なので history は空のまま
    }
    const noHistorySamples = noHistory.samplesOldestFirst();
    assert.equal(noHistorySamples.length, 1);
    assert.equal(noHistorySamples[0], noHistory.state);
  });
}
