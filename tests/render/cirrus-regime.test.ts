// 巻雲の鱗の診断量(上層の不安定度・鱗の層の深さ・前線の盾)の CPU 基準式の不変条件を固定する。
// 値域・単調性・端の値・入力を滑らかに動かしたときの連続性が、鱗の形を決める入力として成り立つ根拠。
import * as assert from 'node:assert/strict';
import { layerDepthKm, shieldOf, upperInstabilityOf } from '../../src/render/earth-weather/cloud/cirrus-regime';
import { test } from '../harness';

const STEP = 0.001;
const MAX_JUMP = 0.05;

// lo..hi を STEP 刻みで並べた入力列。
function sweep(lo: number, hi: number): number[] {
  const values: number[] = [];
  for (let x = lo; x <= hi + 1e-9; x += STEP) values.push(Math.round(x * 1e6) / 1e6);
  return values;
}

// 入力列の上で出力が単調に非減少か、隣り合う差が閾値を超えないか。
function assertMonotoneAndContinuous(outputs: number[], direction: 1 | -1): void {
  for (let i = 1; i < outputs.length; i++) {
    const delta = (outputs[i] - outputs[i - 1]) * direction;
    assert.ok(delta >= -1e-12, `not monotone at index ${i}`);
    assert.ok(Math.abs(outputs[i] - outputs[i - 1]) <= MAX_JUMP, `jump at index ${i}`);
  }
}

export function register(): void {
  test('cirrus regime: 上層の不安定度は常に 0..1 に収まる', () => {
    for (const activity of [0, 0.3, 0.6, 1]) {
      for (const patch of [-1, -0.2, 0.5, 1]) {
        for (const lift of [-0.06, 0, 0.02, 0.06]) {
          const value = upperInstabilityOf(activity, patch, lift);
          assert.ok(value >= 0 && value <= 1, `out of range at (${activity}, ${patch}, ${lift}): ${value}`);
        }
      }
    }
  });

  test('cirrus regime: 上層の不安定度の端の値は 0 と 1', () => {
    assert.equal(upperInstabilityOf(0.3, -1, 0), 0);
    assert.ok(Math.abs(upperInstabilityOf(1, 1, 0.06) - 1) < 1e-12);
  });

  test('cirrus regime: 上層の不安定度は対流の活発度・斑・上昇のそれぞれに単調', () => {
    const activity = sweep(0, 1);
    for (const patch of [-1, 0, 1]) {
      for (const lift of [-0.02, 0, 0.03]) {
        assertMonotoneAndContinuous(activity.map((a) => upperInstabilityOf(a, patch, lift)), 1);
      }
    }
    const patch = sweep(-1, 1);
    for (const act of [0.3, 0.7, 1]) {
      for (const lift of [0, 0.03]) {
        assertMonotoneAndContinuous(patch.map((p) => upperInstabilityOf(act, p, lift)), 1);
      }
    }
    const lift = sweep(-0.06, 0.06);
    for (const act of [0.3, 0.7, 1]) {
      for (const p of [-1, 0, 1]) {
        assertMonotoneAndContinuous(lift.map((l) => upperInstabilityOf(act, p, l)), 1);
      }
    }
  });

  test('cirrus regime: 鱗の層の深さは湿度 0.45 以下で下限 0.5 km、0.9 以上で上限 2.0 km', () => {
    assert.equal(layerDepthKm(0), 0.5);
    assert.equal(layerDepthKm(0.45), 0.5);
    assert.equal(layerDepthKm(0.9), 2.0);
    assert.equal(layerDepthKm(1), 2.0);
  });

  test('cirrus regime: 鱗の層の深さは湿度に対して単調増加し、滑らかに動く', () => {
    const humidity = sweep(0, 1);
    assertMonotoneAndContinuous(humidity.map((h) => layerDepthKm(h)), 1);
  });

  test('cirrus regime: 盾は前線 0・暖気 0 以下・閉塞の芯 1 で 0', () => {
    assert.equal(shieldOf(0, 0.5, 0), 0);
    assert.equal(shieldOf(1, 0, 0), 0);
    assert.equal(shieldOf(1, -0.3, 0), 0);
    assert.equal(shieldOf(1, 0.5, 1), 0);
  });

  test('cirrus regime: 盾は前線 1・暖気 0.35 以上・閉塞の芯 0 で 1', () => {
    assert.ok(Math.abs(shieldOf(1, 0.35, 0) - 1) < 1e-12);
    assert.ok(Math.abs(shieldOf(1, 0.8, 0) - 1) < 1e-12);
  });

  test('cirrus regime: 盾は暖気に対して単調非減少で、0 から 1 へ滑らかに立つ', () => {
    const warmth = sweep(-0.5, 1);
    assertMonotoneAndContinuous(warmth.map((w) => shieldOf(1, w, 0)), 1);
  });

  test('cirrus regime: 盾は前線・閉塞の芯に対して滑らかに動く', () => {
    const front = sweep(0, 1);
    assertMonotoneAndContinuous(front.map((f) => shieldOf(f, 0.5, 0)), 1);
    const core = sweep(0, 1);
    assertMonotoneAndContinuous(core.map((c) => shieldOf(1, 0.5, c)), -1);
  });
}
