// 時間方向の蓄積で使うフレーム番号の進み方と履歴長の上限の不変条件を検査する。
import * as assert from 'node:assert/strict';
import { frameStepOf, lengthCapOf } from '../../src/render/pipeline/screen-space/temporal-accumulation';
import { test } from '../harness';

// フレーム番号の進み方と履歴長の上限の検査を登録する。
export function register(): void {
  test('temporal accumulation: 初回・再描画・連続番号・飛びと戻りを分類する', () => {
    assert.equal(frameStepOf(null, 0, 0), 'cut');
    assert.equal(frameStepOf(4, 4, 0), 'repeat');
    assert.equal(frameStepOf(4, 5, 0), 'advance');
    assert.equal(frameStepOf(4, 6, 0), 'cut');
    assert.equal(frameStepOf(4, 3, 0), 'cut');
  });

  test('temporal accumulation: 同じ番号では変化量を読まず、連続番号の Infinity は履歴を切る', () => {
    assert.equal(frameStepOf(4, 4, Number.NaN), 'repeat');
    assert.equal(frameStepOf(4, 5, Infinity), 'cut');
  });

  test('temporal accumulation: 履歴長の上限は静止時に履歴の上限と一致し、無限の変化量で 1 になる', () => {
    for (const historyCap of [1, 2, 3, 8, 24, 32]) assert.equal(lengthCapOf(historyCap, 0), historyCap);
    assert.equal(lengthCapOf(8, Infinity), 1);
    for (const change of [0, 0.25, 1, 8, Infinity]) assert.equal(lengthCapOf(1, change), 1);
  });

  test('temporal accumulation: 履歴長の上限は履歴の上限で増え、変化量で減り、1 以上に保たれる', () => {
    const historyCaps = [1, 2, 3, 8, 24, 32];
    const changes = [0, 0.25, 1, 2, 8, Infinity];
    const byHistoryCap = historyCaps.map((historyCap) => lengthCapOf(historyCap, 0.5));
    for (let index = 1; index < byHistoryCap.length; index++) {
      assert.ok(byHistoryCap[index]! >= byHistoryCap[index - 1]!);
    }
    const caps = changes.map((change) => lengthCapOf(8, change));
    for (let index = 1; index < caps.length; index++) {
      assert.ok(caps[index]! <= caps[index - 1]!);
    }
    for (const historyCap of historyCaps) {
      for (const change of changes) assert.ok(lengthCapOf(historyCap, change) >= 1);
    }
  });

  test('temporal accumulation: 履歴長の上限は小さな変化量で 1/(1/s + d)、1/s ≪ d ≪ 1 で 1/d に近づく', () => {
    for (const change of [1e-6, 1e-5, 1e-3]) {
      const actual = lengthCapOf(10_000, change);
      const approximate = 1 / (1 / 10_000 + change);
      assert.ok(Math.abs(actual / approximate - 1) < 1e-3);
    }
    const actual = lengthCapOf(1e6, 1e-3);
    assert.ok(Math.abs(actual / (1 / 1e-3) - 1) < 1e-2);
  });

  test('temporal accumulation: 不正な番号・変化量・履歴の上限を拒否する', () => {
    for (const frame of [-1, 1.5, Number.NaN, Infinity]) {
      assert.throws(() => frameStepOf(null, frame, 0), RangeError);
    }
    for (const previous of [-1, 1.5, Number.NaN, Infinity]) {
      assert.throws(() => frameStepOf(previous, 2, 0), RangeError);
    }
    for (const change of [-1, Number.NaN, -Infinity]) {
      assert.throws(() => frameStepOf(0, 1, change), RangeError);
      assert.throws(() => lengthCapOf(8, change), RangeError);
    }
    for (const historyCap of [0, 0.5, 1.5, Number.NaN, Infinity]) {
      assert.throws(() => lengthCapOf(historyCap, 0), RangeError);
    }
  });
}
