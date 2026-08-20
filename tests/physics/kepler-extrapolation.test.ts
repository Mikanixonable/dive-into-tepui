// kepler-extrapolation.ts の回帰テスト。
import * as assert from 'node:assert/strict';
import { test } from './harness';
import { extrapolatedRelativeState, extrapolatedRelativeStates } from '../../src/physics/kepler-extrapolation';
import { Attractor } from '../../src/physics/attractor';
import { stepDynamics } from '../../src/physics/dynamics';
import { keplerPeriod, stateFromOrbitalElements } from '../../src/physics/elements';
import { KinematicState, kinematicState } from '../../src/physics/kinematic-state';
import { MU_EARTH, R_EARTH } from '../../src/physics/solar-system';
import { len, sub, v3 } from '../../src/physics/vec3';

const ZERO = v3(0, 0, 0);
const EARTH: Attractor = { id: 'earth', mu: MU_EARTH, radius: R_EARTH, state: kinematicState(0, ZERO, ZERO), accel: ZERO, degree2: null, atmosphere: null, isStar: false };

// tip から t までを stepDynamics(bcInv=0, srpCoeff=0, thrust=null) で密に積分した基準値。
// EARTH は原点に静止しているので、返り値はそのまま中心天体相対 = 絶対 ECI になる。
function integrate(tip: KinematicState, t: number, dt: number): KinematicState {
  let s = tip;
  const steps = Math.round((t - tip.t) / dt);
  for (let i = 0; i < steps; i++) {
    s = stepDynamics(s, dt, [EARTH], null, 0, 0, null);
  }
  return s;
}

function chordDistances(states: readonly KinematicState[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < states.length; i++) out.push(len(sub(states[i]!.r, states[i - 1]!.r)));
  return out;
}

function stdev(xs: readonly number[]): number {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance = xs.reduce((a, x) => a + (x - mean) ** 2, 0) / xs.length;
  return Math.sqrt(variance);
}

export function register(): void {
  test('kepler-extrapolation: extrapolatedRelativeState は円軌道を1周期ぶん外挿すると元の位置に戻る', () => {
    const a = R_EARTH + 500e3;
    const vc = Math.sqrt(MU_EARTH / a);
    const period = keplerPeriod(a, MU_EARTH);
    const tip = kinematicState(1000, v3(a, 0, 0), v3(0, vc, 0));

    const back = extrapolatedRelativeState(tip, EARTH, tip.t + period);
    assert.ok(back, 'expected a valid extrapolation');
    const posErr = len(sub(back!.r, tip.r)) / a;
    const velErr = len(sub(back!.v, tip.v)) / vc;
    assert.ok(posErr < 1e-9, `position round trip after 1 period: ${posErr}`);
    assert.ok(velErr < 1e-9, `velocity round trip after 1 period: ${velErr}`);
    assert.ok(Math.abs(back!.t - (tip.t + period)) < 1e-9, 'returned state carries the queried time');
  });

  test('kepler-extrapolation: extrapolatedRelativeState は離心軌道(e=0.6)で密な数値積分と一致する', () => {
    const a = R_EARTH + 500e3;
    const e = 0.6;
    const tip = stateFromOrbitalElements(0, a, e, 0, 0, 0, 0, MU_EARTH); // nu=0 = 近点
    const period = keplerPeriod(a, MU_EARTH);
    const target = tip.t + period * 0.37; // 近点通過直後を避けた任意の時刻

    const extrapolated = extrapolatedRelativeState(tip, EARTH, target);
    assert.ok(extrapolated, 'expected a valid extrapolation');
    const reference = integrate(tip, target, 2);

    const posErr = len(sub(extrapolated!.r, reference.r)) / len(reference.r);
    const velErr = len(sub(extrapolated!.v, reference.v)) / len(reference.v);
    assert.ok(posErr < 1e-3, `position vs. numeric integration: ${posErr}`);
    assert.ok(velErr < 1e-3, `velocity vs. numeric integration: ${velErr}`);
  });

  test('kepler-extrapolation: extrapolatedRelativeStates は時刻昇順で、最後の要素がちょうど untilT', () => {
    const a = R_EARTH + 500e3;
    const e = 0.4;
    const tip = stateFromOrbitalElements(500, a, e, 0.3, 0.2, 0.1, 0.8, MU_EARTH);
    const period = keplerPeriod(a, MU_EARTH);
    const untilT = tip.t + period * 1.7;

    const states = extrapolatedRelativeStates(tip, EARTH, untilT, 12);
    assert.equal(states.length, 12);
    for (let i = 1; i < states.length; i++) {
      assert.ok(states[i]!.t > states[i - 1]!.t, `ascending times: ${states.map((s) => s.t)}`);
    }
    assert.equal(states[states.length - 1]!.t, untilT, 'last sample lands exactly on untilT');
  });

  test('kepler-extrapolation: extrapolatedRelativeStates は複数周(3.5周)にまたがっても時刻が単調増加し、位置が飛ばない', () => {
    const a = R_EARTH + 500e3;
    const e = 0.6;
    const tip = stateFromOrbitalElements(0, a, e, 0, 0, 0, 0, MU_EARTH);
    const period = keplerPeriod(a, MU_EARTH);
    const untilT = tip.t + period * 3.5;
    const count = 60;

    const states = extrapolatedRelativeStates(tip, EARTH, untilT, count);
    assert.equal(states.length, count);
    for (let i = 1; i < states.length; i++) {
      assert.ok(states[i]!.t > states[i - 1]!.t, `monotonically increasing times at i=${i}`);
    }

    // 単調な E から求めているので、隣接サンプルの間隔は中央値の数倍を超えない
    // (巻き戻りバグがあれば、ある1点だけ軌道径ぶんの跳躍が出るはず)。
    const chords = chordDistances([tip, ...states]);
    const sorted = [...chords].sort((x, y) => x - y);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    assert.ok(Math.max(...chords) < median * 6, `no single jump among chord distances: max=${Math.max(...chords)}, median=${median}`);
  });

  test('kepler-extrapolation: extrapolatedRelativeStates は等時間刻みより弧長のばらつきが小さい(離心率0.8で1周)', () => {
    const a = R_EARTH + 500e3;
    const e = 0.8;
    const tip = stateFromOrbitalElements(0, a, e, 0, 0, 0, 0, MU_EARTH); // 近点始まり
    const period = keplerPeriod(a, MU_EARTH);
    const untilT = tip.t + period;
    const count = 20;

    const byE = extrapolatedRelativeStates(tip, EARTH, untilT, count);
    const byTime: KinematicState[] = [];
    for (let i = 1; i <= count; i++) {
      const t = tip.t + (period * i) / count;
      byTime.push(extrapolatedRelativeState(tip, EARTH, t)!);
    }

    const stdevByE = stdev(chordDistances([tip, ...byE]));
    const stdevByTime = stdev(chordDistances([tip, ...byTime]));
    assert.ok(
      stdevByE < stdevByTime,
      `E-equal spacing should be more uniform than time-equal spacing: ${stdevByE} vs ${stdevByTime}`,
    );
  });

  test('kepler-extrapolation: 離心率が高すぎる(e>=0.98)/双曲線/放物線(a非有限)/mu<=0 では外挿できない', () => {
    // 楕円のまま e だけ 0.98 を超える(長半径は正のまま — e の条件単体を試す)。
    const nearParabolic = stateFromOrbitalElements(0, R_EARTH + 500e3, 0.99, 0, 0, 0, 0, MU_EARTH);
    assert.equal(extrapolatedRelativeState(nearParabolic, EARTH, 1000), null);
    assert.deepEqual(extrapolatedRelativeStates(nearParabolic, EARTH, 1000, 5), []);

    // 双曲線(e>1、a<0)。
    const rp = R_EARTH + 500e3;
    const e = 1.2;
    const hyperbolic = stateFromOrbitalElements(0, rp / (1 - e), e, 0, 0, 0, 0, MU_EARTH);
    assert.equal(extrapolatedRelativeState(hyperbolic, EARTH, 1000), null);
    assert.deepEqual(extrapolatedRelativeStates(hyperbolic, EARTH, 1000, 5), []);

    // 脱出速度ちょうど: 放物線軌道で長半径が非有限になる。
    const r0 = R_EARTH + 500e3;
    const escapeSpeed = Math.sqrt((2 * MU_EARTH) / r0);
    const parabolic = kinematicState(0, v3(r0, 0, 0), v3(0, escapeSpeed, 0));
    assert.equal(extrapolatedRelativeState(parabolic, EARTH, 1000), null);
    assert.deepEqual(extrapolatedRelativeStates(parabolic, EARTH, 1000, 5), []);

    const noMu: Attractor = { ...EARTH, mu: 0 };
    const circular = kinematicState(0, v3(r0, 0, 0), v3(0, 7000, 0));
    assert.equal(extrapolatedRelativeState(circular, noMu, 1000), null);
    assert.deepEqual(extrapolatedRelativeStates(circular, noMu, 1000, 5), []);
  });

  test('kepler-extrapolation: count<=0 や untilT<=tip.t では空配列', () => {
    const tip = kinematicState(1000, v3(R_EARTH + 500e3, 0, 0), v3(0, 7600, 0));
    assert.deepEqual(extrapolatedRelativeStates(tip, EARTH, 5000, 0), []);
    assert.deepEqual(extrapolatedRelativeStates(tip, EARTH, 5000, -3), []);
    assert.deepEqual(extrapolatedRelativeStates(tip, EARTH, tip.t, 5), []);
    assert.deepEqual(extrapolatedRelativeStates(tip, EARTH, tip.t - 100, 5), []);
  });
}
