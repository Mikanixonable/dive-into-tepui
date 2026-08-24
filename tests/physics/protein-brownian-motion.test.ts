import * as assert from 'node:assert/strict';
import { test } from './harness';
import {
  ProteinBrownianSampler, proteinBrownianSeedFor,
} from '../../src/game/protein/protein-brownian-motion';

export function register(): void {
  test('protein Brownian: identifier seeds are stable and well distributed', () => {
    assert.equal(proteinBrownianSeedFor('enemy-42'), proteinBrownianSeedFor('enemy-42'));
    assert.notEqual(proteinBrownianSeedFor('enemy-42'), proteinBrownianSeedFor('enemy-43'));
    assert.notEqual(proteinBrownianSeedFor(''), proteinBrownianSeedFor('enemy-42'));
  });

  test('protein Brownian: sample is independent of seek history', () => {
    const modes = [{ relaxationRate: 1.2, rmsAmplitude: 0.8 }, { relaxationRate: 0.35, rmsAmplitude: 1.4 }];
    const direct = new ProteinBrownianSampler(modes, 30, 1234);
    const sought = new ProteinBrownianSampler(modes, 30, 1234);
    const a = new Float64Array(2);
    const b = new Float64Array(2);
    direct.sampleAt(12.375, a);
    sought.sampleAt(0, b);
    sought.sampleAt(100, b);
    sought.sampleAt(12.375, b);
    assert.deepEqual([...b], [...a]);
    sought.sampleAt(2, b);
    sought.sampleAt(12.375, b);
    assert.deepEqual([...b], [...a]);
  });

  test('protein Brownian: invalid parameters and times never produce NaN', () => {
    const sampler = new ProteinBrownianSampler([
      { relaxationRate: Number.NaN, rmsAmplitude: Number.NaN },
      { relaxationRate: -1, rmsAmplitude: -1 },
      { relaxationRate: Number.POSITIVE_INFINITY, rmsAmplitude: Number.POSITIVE_INFINITY },
    ], Number.NaN, Number.NaN);
    const out = new Float64Array(3);
    for (const time of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0, 1]) {
      sampler.sampleAt(time, out);
      assert.ok(out.every(Number.isFinite));
    }
    assert.throws(() => sampler.sampleAt(0, new Float64Array(2)), RangeError);
  });

  test('protein Brownian: stationary RMS and autocorrelation match OU process', () => {
    const sampleHz = 30;
    const relaxationRate = 0.8;
    const rmsAmplitude = 1.7;
    const sampler = new ProteinBrownianSampler([{ relaxationRate, rmsAmplitude }], sampleHz, 0xdecafbad);
    const out = new Float64Array(1);
    const values: number[] = [];
    for (let tick = 0; tick < 8_000; tick += 1) {
      sampler.sampleAt(tick / sampleHz, out);
      if (tick >= 500) values.push(out[0]);
    }
    let sum = 0;
    for (const value of values) sum += value;
    const mean = sum / values.length;
    let variance = 0;
    let lagProduct = 0;
    for (let index = 0; index < values.length; index += 1) {
      const centered = values[index] - mean;
      variance += centered * centered;
      if (index > 0) lagProduct += centered * (values[index - 1] - mean);
    }
    variance /= values.length;
    const autocorrelation = lagProduct / (values.length - 1) / variance;
    // A finite stationary trace has correlated samples, so its sample mean is
    // intentionally checked more loosely than the RMS (the latter is the
    // parameterized quantity).
    assert.ok(Math.abs(mean) < rmsAmplitude * 0.15, `mean=${mean}`);
    assert.ok(Math.abs(Math.sqrt(variance) - rmsAmplitude) < rmsAmplitude * 0.05, `rms=${Math.sqrt(variance)}`);
    assert.ok(Math.abs(autocorrelation - Math.exp(-relaxationRate / sampleHz)) < 0.025, `lag=${autocorrelation}`);
  });

  test('protein Brownian: repeated frame-rate sampling is deterministic', () => {
    const modes = [{ relaxationRate: 2, rmsAmplitude: 1 }];
    const first = new ProteinBrownianSampler(modes, 24, 88);
    const second = new ProteinBrownianSampler(modes, 24, 88);
    const a = new Float64Array(1);
    const b = new Float64Array(1);
    const times = [0, 1 / 60, 1 / 30, 0.11, 0.375, 2.01, 0.04, 2.01];
    for (const time of times) {
      first.sampleAt(time, a);
      second.sampleAt(time, b);
      assert.deepEqual([...b], [...a]);
    }
  });

  test('protein Brownian: adjacent cache agrees with a fresh rebuild at fractional times', () => {
    const modes = [
      { relaxationRate: 1.1, rmsAmplitude: 0.7 },
      { relaxationRate: 0.25, rmsAmplitude: 1.2 },
    ];
    const sampleHz = 30;
    const sequential = new ProteinBrownianSampler(modes, sampleHz, 0x12345678);
    const sequentialOut = new Float64Array(2);
    const directOut = new Float64Array(2);
    for (let tick = 0; tick < 120; tick += 1) {
      const time = (tick + 0.37) / sampleHz;
      sequential.sampleAt(time, sequentialOut);
      const direct = new ProteinBrownianSampler(modes, sampleHz, 0x12345678);
      direct.sampleAt(time, directOut);
      for (let mode = 0; mode < modes.length; mode += 1) {
        assert.ok(Math.abs(sequentialOut[mode] - directOut[mode]) < 1e-12,
          `tick=${tick}, mode=${mode}: ${sequentialOut[mode]} vs ${directOut[mode]}`);
      }
    }
  });

  test('protein Brownian: bounded multi-tick catch-up agrees with a fresh rebuild', () => {
    const modes = [{ relaxationRate: 0.9, rmsAmplitude: 0.9 }, { relaxationRate: 0.2, rmsAmplitude: 1.1 }];
    const sampleHz = 30;
    const sequential = new ProteinBrownianSampler(modes, sampleHz, 0xabcddcba);
    const sequentialOut = new Float64Array(2);
    const directOut = new Float64Array(2);
    sequential.sampleAt(6.25 / sampleHz, sequentialOut);
    const targetTime = (6 + 17 + 0.41) / sampleHz;
    sequential.sampleAt(targetTime, sequentialOut);
    const direct = new ProteinBrownianSampler(modes, sampleHz, 0xabcddcba);
    direct.sampleAt(targetTime, directOut);
    for (let mode = 0; mode < modes.length; mode += 1) {
      assert.ok(Math.abs(sequentialOut[mode] - directOut[mode]) < 1e-12,
        `mode=${mode}: ${sequentialOut[mode]} vs ${directOut[mode]}`);
    }
  });
}
