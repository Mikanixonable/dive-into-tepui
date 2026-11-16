// 巻雲の鱗の間隔と出る条件の CPU 基準式の不変条件を固定する。型の重みの和と値域、隅の値、
// 入力を滑らかに動かしたときの間隔の連続性、門の値域と単調性、シアの値域が、鱗の形を決める入力として成り立つ根拠。
import * as assert from 'node:assert/strict';
import {
  scaleGate, scaleRegimeWeights, scaleShearOf, scaleSpacingKm, type ScaleRegimeWeights,
} from '../../src/render/earth-weather/cloud/cirrus-scale';
import { test } from '../harness';

const STEP = 0.001;
const MAX_LOG_JUMP = 0.05;

// lo..hi を STEP 刻みで並べた入力列。
function sweep(lo: number, hi: number): number[] {
  const values: number[] = [];
  for (let x = lo; x <= hi + 1e-9; x += STEP) values.push(Math.round(x * 1e6) / 1e6);
  return values;
}

function weightsSum(w: ScaleRegimeWeights): number {
  return w.closed + w.open + w.roll + w.wave;
}

export function register(): void {
  test('cirrus scale: 型の重みの和は常に 1 で、各重みは 0..1 に収まる', () => {
    for (const shear of [0, 0.25, 0.5, 0.75, 1]) {
      for (const instability of [0, 0.3, 0.6, 1]) {
        for (const amount of [0, 0.5, 1]) {
          const w = scaleRegimeWeights(shear, instability, amount);
          assert.ok(Math.abs(weightsSum(w) - 1) < 1e-12, `sum at (${shear}, ${instability}, ${amount})`);
          for (const v of [w.closed, w.open, w.roll, w.wave]) {
            assert.ok(v >= 0 && v <= 1, `weight out of range at (${shear}, ${instability}, ${amount}): ${v}`);
          }
        }
      }
    }
  });

  test('cirrus scale: 隅の重みは閉じた・開いた・列・波のそれぞれ 1', () => {
    assert.deepEqual(scaleRegimeWeights(0, 0, 0.5), { closed: 1, open: 0, roll: 0, wave: 0 });
    assert.deepEqual(scaleRegimeWeights(0, 1, 0.5), { closed: 0, open: 1, roll: 0, wave: 0 });
    assert.deepEqual(scaleRegimeWeights(1, 1, 0.5), { closed: 0, open: 0, roll: 1, wave: 0 });
    assert.deepEqual(scaleRegimeWeights(1, 0, 0.5), { closed: 0, open: 0, roll: 0, wave: 1 });
  });

  test('cirrus scale: 隅の重みに対する間隔は縦横比そのもの', () => {
    const closed = scaleRegimeWeights(0, 0, 0.5);
    const open = scaleRegimeWeights(0, 1, 0.5);
    const roll = scaleRegimeWeights(1, 1, 0.5);
    const wave = scaleRegimeWeights(1, 0, 0.5);
    assert.ok(Math.abs(scaleSpacingKm(1, closed) - 4.5) < 1e-9);
    assert.ok(Math.abs(scaleSpacingKm(1, open) - 15) < 1e-9);
    assert.ok(Math.abs(scaleSpacingKm(1, roll) - 3) < 1e-9);
    assert.ok(Math.abs(scaleSpacingKm(1, wave) - 2.7) < 1e-9);
  });

  test('cirrus scale: 間隔は層の深さに比例する', () => {
    const w = scaleRegimeWeights(0.3, 0.6, 0.4);
    assert.ok(Math.abs(scaleSpacingKm(2, w) - 2 * scaleSpacingKm(1, w)) < 1e-9);
  });

  test('cirrus scale: 間隔の対数はシアと上層の不安定度に対して連続で、隣の差が閾値を超えない', () => {
    const grid = sweep(0, 1);
    for (const fixed of [0, 0.5, 1]) {
      // シアを動かす(不安定度は固定)。
      for (const amount of [0.2, 0.8]) {
        let previous: number | null = null;
        for (const shear of grid) {
          const log = Math.log(scaleSpacingKm(1, scaleRegimeWeights(shear, fixed, amount)));
          if (previous !== null) assert.ok(Math.abs(log - previous) <= MAX_LOG_JUMP, `jump in shear at ${shear}`);
          previous = log;
        }
      }
      // 不安定度を動かす(シアは固定)。
      for (const amount of [0.2, 0.8]) {
        let previous: number | null = null;
        for (const instability of grid) {
          const log = Math.log(scaleSpacingKm(1, scaleRegimeWeights(fixed, instability, amount)));
          if (previous !== null) assert.ok(Math.abs(log - previous) <= MAX_LOG_JUMP, `jump in instability at ${instability}`);
          previous = log;
        }
      }
    }
  });

  test('cirrus scale: 鱗が立つ強さは 0..1 に収まり、シアに対して単調非減少', () => {
    const shearGrid = sweep(0, 1);
    for (const instability of [0, 0.2, 0.5, 0.8, 1]) {
      let previous = -1;
      for (const shear of shearGrid) {
        const gate = scaleGate(shear, instability);
        assert.ok(gate >= 0 && gate <= 1, `gate out of range at (${shear}, ${instability}): ${gate}`);
        assert.ok(gate >= previous - 1e-12, `not monotone in shear at (${shear}, ${instability})`);
        previous = gate;
      }
    }
  });

  test('cirrus scale: シアは 4 m/s 以下で 0、14 m/s 以上で 1', () => {
    assert.equal(scaleShearOf(0), 0);
    assert.equal(scaleShearOf(4), 0);
    assert.equal(scaleShearOf(14), 1);
    assert.equal(scaleShearOf(30), 1);
  });

  test('cirrus scale: シアは 0..1 に収まり、風の差に対して単調非減少', () => {
    const diff = sweep(0, 20);
    let previous = -1;
    for (const d of diff) {
      const s = scaleShearOf(d);
      assert.ok(s >= 0 && s <= 1, `shear out of range at ${d}: ${s}`);
      assert.ok(s >= previous - 1e-12, `not monotone at ${d}`);
      previous = s;
    }
  });
}
