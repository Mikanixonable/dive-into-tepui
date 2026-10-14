// 時間方向の蓄積で使うフレーム番号の進み方と履歴上限の不変条件を検査する。
import * as assert from 'node:assert/strict';
import { frameStepOf, historyCapOf } from '../../src/render/pipeline/screen-space/temporal-accumulation';
import { test } from '../harness';

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

  test('temporal accumulation: 履歴上限は静止時に時定数、切り替え時と時定数 1 で 1 になる', () => {
    assert.equal(historyCapOf(8, 0), 8);
    assert.equal(historyCapOf(8, Infinity), 1);
    for (const change of [0, 0.25, 1, 8, Infinity]) assert.equal(historyCapOf(1, change), 1);
  });

  test('temporal accumulation: 履歴上限は実数のまま、変化量に対して減少する', () => {
    assert.equal(historyCapOf(8, 2), 8 / 3);
    const changes = [0, 0.25, 1, 2, 8, Infinity];
    const caps = changes.map((change) => historyCapOf(8, change));
    for (let index = 1; index < caps.length; index++) {
      assert.ok(caps[index]! <= caps[index - 1]!);
      assert.ok(caps[index]! >= 1);
    }
  });

  test('temporal accumulation: 不正な番号・変化量・時定数を拒否する', () => {
    for (const frame of [-1, 1.5, Number.NaN, Infinity]) {
      assert.throws(() => frameStepOf(null, frame, 0), RangeError);
    }
    for (const previous of [-1, 1.5, Number.NaN, Infinity]) {
      assert.throws(() => frameStepOf(previous, 2, 0), RangeError);
    }
    for (const change of [-1, Number.NaN, -Infinity]) {
      assert.throws(() => frameStepOf(0, 1, change), RangeError);
      assert.throws(() => historyCapOf(8, change), RangeError);
    }
    for (const timeConstant of [0, 0.5, 1.5, Number.NaN, Infinity]) {
      assert.throws(() => historyCapOf(timeConstant, 0), RangeError);
    }
  });
}
