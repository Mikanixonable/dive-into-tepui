// physics/dynamic-trajectory.ts の回帰テスト。game/game-entity/game-entity.ts の GameEntity から
// 切り出した「時刻付き状態 + その手前のサンプル列(間引き済み)+ 自分を1ステップ進める能力」の
// 単体テスト(better_predict.md Step 2)。過去列にも将来列にも同じ実装を使う前提なので、
// ここでの検証は GameEntity.actualTrajectory(過去列側)としての用法をそのまま代表する。
import { solarSystemEphemeris } from './test-helpers';
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { CelestialBody } from '../../src/physics/celestial-body';
import { extrapolatedRelativeState } from '../../src/physics/kepler-extrapolation';
import { KinematicState, kinematicState } from '../../src/physics/kinematic-state';
import { MU_EARTH, R_EARTH } from '../../src/physics/solar-system/constants';
import { DynamicTrajectory } from '../../src/physics/dynamic-trajectory';
import { stepDynamics } from '../../src/physics/dynamics';
import { add, len, sub, v3 } from '../../src/math/vec3';

const EPH = solarSystemEphemeris({ moon: 0 }); // 初期位相を固定して決定的にする
const celestialBodiesAt = (t: number) => EPH.celestialBodiesAt(t); // step() が要求する重力源をステップ中点で引く
const EARTH: CelestialBody = { id: 'earth', mu: MU_EARTH, radius: R_EARTH, state: kinematicState(0, v3(), v3()), accel: v3(), degree2: null, atmosphere: null, isStar: false };

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
      e.step(dt, celestialBodiesAt(e.state.t + dt / 2), [], null, 0, 0, null, sampleInterval, 100000);
    }
    // 500秒ぶん進めて間隔 23s なので、間引き後のサンプル数はおよそ 20 件前後のはず
    // (毎ステップ記録すれば100件になるところを大幅に間引けていることを確認する)。
    assert.ok(e.samplesOldestFirst().length > 5 && e.samplesOldestFirst().length < 30, `expected a decimated history, got ${e.samplesOldestFirst().length}`);
  });

  test('dynamic-trajectory: sampleInterval reports the interval the series was actually decimated at', () => {
    const e = new DynamicTrajectory(circularState());
    assert.equal(e.sampleInterval, 0, '一度も進めていない列は粗さを持たない');
    // 10s 刻みで 50s ごとにだけ記録させる。列の古い端の間隔は要求値ではなく実際の記録間隔。
    for (let i = 0; i < 40; i++) e.step(10, celestialBodiesAt(e.state.t + 5), [], null, 0, 0, null, 50, 1e6);
    assert.equal(e.sampleInterval, 50);
    // 要求間隔を細かくしても、既に積んだ古い端の粗さは変わらない。
    for (let i = 0; i < 3; i++) e.step(10, celestialBodiesAt(e.state.t + 5), [], null, 0, 0, null, 10, 1e6);
    assert.equal(e.sampleInterval, 50, '既に積んだサンプルの粗さは呼び出し側の設定変更で変わらない');
  });

  test('dynamic-trajectory: step retains nothing but the tip when keepDuration is 0', () => {
    const e = new DynamicTrajectory(circularState());
    for (let i = 0; i < 50; i++) {
      e.step(1, celestialBodiesAt(e.state.t + 0.5), [], null, 0, 0, null, 1, 0);
    }
    assert.equal(e.samplesOldestFirst().length, 1, 'keepDuration が 0 なら先端以外は積まれない');
  });

  test('dynamic-trajectory: keepDuration bounds how many history samples accumulate', () => {
    const e = new DynamicTrajectory(circularState());
    const dt = 10;
    const sampleInterval = 10; // 毎ステップ記録
    const keepDuration = 200; // 保持窓 200s ÷ 間隔 10s ≈ 20 件程度で頭打ちになるはず
    for (let i = 0; i < 500; i++) { // 5000秒ぶん進める(保持窓の25倍)
      e.step(dt, celestialBodiesAt(e.state.t + dt / 2), [], null, 0, 0, null, sampleInterval, keepDuration);
    }
    assert.ok(e.samplesOldestFirst().length < 30, `history should stay bounded by keepDuration, got ${e.samplesOldestFirst().length} samples`);
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
      dense.step(dt, celestialBodiesAt(dense.state.t + dt / 2), [], null, 0, 0, null, dt, 1e6); // sampleInterval=dt → 実質毎ステップ記録
      sparse.step(dt, celestialBodiesAt(sparse.state.t + dt / 2), [], null, 0, 0, null, sampleInterval, 1e6);
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
      e.step(dt, celestialBodiesAt(e.state.t + dt / 2), [], null, 0, 0, null, dt, 100000); // 毎ステップ記録: history = t=0..80, state.t=90
    }
    assert.ok(e.at(50), 'sanity: t=50 should be recorded before reset');
    e.reset(kinematicState(50, v3(1, 0, 0), v3(0, 1, 0)));
    assert.equal(e.at(50), e.state, 'the sample at the reset time is the reset state itself');
    assert.ok(e.at(30), 'samples strictly before the reset time should survive');
    assert.equal(e.state.t, 50);
  });

  test('dynamic-trajectory: prevState always reflects the state immediately before the last step/reset', () => {
    const e = new DynamicTrajectory(circularState());
    assert.equal(e.prevState.t, 0); // 初期状態では自分自身に退化(まだ一度も進んでいない)

    e.step(10, celestialBodiesAt(e.state.t + 5), [], null, 0, 0, null, 1000, 0); // keepDuration=0(history 不使用)でも prevState は更新される
    assert.equal(e.prevState.t, 0);
    assert.equal(e.state.t, 10);

    e.step(10, celestialBodiesAt(e.state.t + 5), [], null, 0, 0, null, 1000, 0);
    assert.equal(e.prevState.t, 10);
    assert.equal(e.state.t, 20);

    const before = e.state;
    e.reset(kinematicState(20, v3(1, 0, 0), v3(0, 1, 0)));
    assert.equal(e.prevState.t, before.t, 'reset should also advance prevState to the state it replaced');
  });

  test('dynamic-trajectory: at() returns state itself at t === state.t and null beyond it', () => {
    const e = new DynamicTrajectory(circularState());
    e.step(10, celestialBodiesAt(e.state.t + 5), [], null, 0, 0, null, 5, 100000);
    assert.equal(e.at(e.state.t), e.state);
    assert.equal(e.at(e.state.t + 1), null);
  });

  test('dynamic-trajectory: samplesOldestFirst is ordered oldest-to-newest and ends at state', () => {
    const e = new DynamicTrajectory(circularState());
    const dt = 10;
    const sampleInterval = 10; // 毎ステップ記録
    for (let i = 0; i < 20; i++) {
      e.step(dt, celestialBodiesAt(e.state.t + dt / 2), [], null, 0, 0, null, sampleInterval, 1e6);
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
      noHistory.step(1, celestialBodiesAt(noHistory.state.t + 0.5), [], null, 0, 0, null, 1, 0); // keepDuration=0 なので history は空のまま
    }
    const noHistorySamples = noHistory.samplesOldestFirst();
    assert.equal(noHistorySamples.length, 1);
    assert.equal(noHistorySamples[0], noHistory.state);
  });

  test('dynamic-trajectory: samplesOldestFirst returns the same array reference until step/reset', () => {
    const e = new DynamicTrajectory(circularState());
    e.step(10, celestialBodiesAt(e.state.t + 5), [], null, 0, 0, null, 10, 1e6);
    const a = e.samplesOldestFirst();
    const b = e.samplesOldestFirst();
    assert.equal(a, b, 'repeated calls with no intervening step/reset should be the same reference');

    e.step(10, celestialBodiesAt(e.state.t + 5), [], null, 0, 0, null, 10, 1e6);
    const c = e.samplesOldestFirst();
    assert.notEqual(c, a, 'a step must invalidate the memoized reference');

    e.reset(kinematicState(e.state.t, v3(1, 0, 0), v3(0, 1, 0)));
    const d = e.samplesOldestFirst();
    assert.notEqual(d, c, 'a reset must invalidate the memoized reference');
  });

  test('dynamic-trajectory: extrapolationCenter は既定 null で、省略した step からは変わらない', () => {
    const e = new DynamicTrajectory(circularState());
    assert.equal(e.extrapolationCenter, null);
    e.step(10, celestialBodiesAt(e.state.t + 5), [], null, 0, 0, null, 10, 1e6); // 中心天体を渡さない既存呼び出し
    assert.equal(e.extrapolationCenter, null, '省略時は from before と同じ挙動(null のまま)');
  });

  test('dynamic-trajectory: step に渡した中心天体が extrapolationCenter に反映され、reset で破棄される', () => {
    const e = new DynamicTrajectory(circularState());
    e.step(10, celestialBodiesAt(e.state.t + 5), [], null, 0, 0, null, 10, 1e6, EARTH);
    assert.equal(e.extrapolationCenter, EARTH);

    e.reset(kinematicState(e.state.t, v3(1, 0, 0), v3(0, 1, 0)));
    assert.equal(e.extrapolationCenter, null, '不連続な差し替えで中心天体は破棄される');
  });

  test('dynamic-trajectory: extrapolatedAt は保持区間内・t<=state.t では at(t) と同じ', () => {
    const e = new DynamicTrajectory(circularState());
    for (let i = 0; i < 5; i++) e.step(10, celestialBodiesAt(e.state.t + 5), [], null, 0, 0, null, 10, 1e6, EARTH);
    const mid = e.state.t - 20;
    assert.deepEqual(e.extrapolatedAt(mid, e.state), e.at(mid));
    assert.equal(e.extrapolatedAt(e.state.t, e.state), e.state);
  });

  test('dynamic-trajectory: 中心天体を保持していなければ、先端より先でも extrapolatedAt は at(t) と同じ(null)', () => {
    const e = new DynamicTrajectory(circularState());
    e.step(10, celestialBodiesAt(e.state.t + 5), [], null, 0, 0, null, 10, 1e6); // 中心天体なし
    assert.equal(e.extrapolatedAt(e.state.t + 100, e.state), e.at(e.state.t + 100));
  });

  test('dynamic-trajectory: follow は step と同じ保持方針でサンプルを積む', () => {
    const stepped = new DynamicTrajectory(circularState());
    const followed = new DynamicTrajectory(circularState());
    const dt = 5;
    const sampleInterval = 23; // dt では割り切れない値にして端数の丸まり方を確認する
    const keepDuration = 1000;
    for (let i = 0; i < 100; i++) {
      stepped.step(dt, celestialBodiesAt(stepped.state.t + dt / 2), [], null, 0, 0, null, sampleInterval, keepDuration);
      const next = stepDynamics(followed.state, dt, celestialBodiesAt(followed.state.t + dt / 2), [], null, 0, 0, null);
      followed.follow(next, sampleInterval, keepDuration);
    }
    const steppedSamples = stepped.samplesOldestFirst();
    const followedSamples = followed.samplesOldestFirst();
    assert.equal(followedSamples.length, steppedSamples.length);
    for (let i = 0; i < steppedSamples.length; i++) {
      assert.equal(followedSamples[i]!.t, steppedSamples[i]!.t);
    }
  });

  test('dynamic-trajectory: follow は prevState を直前の先端へ進める', () => {
    const e = new DynamicTrajectory(circularState());
    e.step(10, celestialBodiesAt(e.state.t + 5), [], null, 0, 0, null, 1000, 0);
    const tipBeforeFollow = e.state;
    const next = kinematicState(e.state.t + 10, v3(1, 0, 0), v3(0, 1, 0));
    e.follow(next, 1000, 0);
    assert.equal(e.prevState, tipBeforeFollow);
    assert.equal(e.state, next);
  });

  test('dynamic-trajectory: follow は samplesOldestFirst のメモを無効化する', () => {
    const e = new DynamicTrajectory(circularState());
    e.step(10, celestialBodiesAt(e.state.t + 5), [], null, 0, 0, null, 10, 1e6);
    const before = e.samplesOldestFirst();
    const next = kinematicState(e.state.t + 10, v3(1, 0, 0), v3(0, 1, 0));
    e.follow(next, 10, 1e6);
    const after = e.samplesOldestFirst();
    assert.notEqual(after, before, 'follow はメモを無効化するはず');
    assert.equal(after[after.length - 1], next);
  });

  test('dynamic-trajectory: extrapolatedAt は先端より先を二体軌道として外挿し、中心天体の位置・速度を足し戻す', () => {
    const e = new DynamicTrajectory(circularState());
    e.step(10, [EARTH], [], null, 0, 0, null, 10, 1e6, EARTH); // EARTH のみを重力源にした純二体積分
    const t = e.state.t + 1000;

    const rel = extrapolatedRelativeState(e.state, EARTH, t)!;
    const movingCenter = kinematicState(t, v3(1e6, 2e6, -3e6), v3(10, -20, 30));
    const extrapolated = e.extrapolatedAt(t, movingCenter);
    assert.ok(extrapolated);
    assert.deepEqual(extrapolated!.r, add(rel.r, movingCenter.r));
    assert.deepEqual(extrapolated!.v, add(rel.v, movingCenter.v));
    assert.equal(extrapolated!.t, t);
  });
}
