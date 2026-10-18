// 建造の表示導出の純粋な部分: 画面ピックと差し込みの動き。
// ピックは「半径内で最も近い候補」、差し込みは「2 m から 0.25 秒で 0 へ単調に収まる」
// という仕様由来の不変条件を固定する。
import * as assert from 'node:assert/strict';
import {
  CONSTRUCTION_TARGET_PICK_RADIUS_SQ, pickConstructionTargetAtScreenPoint,
  type ConstructionTargetScreenPoint,
} from '../../src/game/ship/ship-construction-candidates';
import {
  INSERTION_OFFSET_DISTANCE_M, INSERTION_OFFSET_DURATION_MS, insertionOffsetAt,
} from '../../src/game/ship/ship-construction-view';
import { test } from '../harness';

function point(id: string, x: number, y: number, front = true): ConstructionTargetScreenPoint {
  return { id, x, y, front };
}

export function register(): void {
  test('construction target pick: 半径内で最も近い候補を選ぶ', () => {
    const targets = [
      point('far', 100, 0),
      point('near', 30, 0),
      point('nearest', 10, 0),
    ];
    assert.equal(
      pickConstructionTargetAtScreenPoint(targets, { x: 0, y: 0 }, 2500),
      'nearest',
    );
  });

  test('construction target pick: 半径の外なら null', () => {
    const targets = [point('out', 60, 0)];
    // 半径の2乗 2500(=50px)を 60px 離れた候補は超える。
    assert.equal(pickConstructionTargetAtScreenPoint(targets, { x: 0, y: 0 }, 2500), null);
    // 半径の内側なら選ぶ。
    assert.equal(
      pickConstructionTargetAtScreenPoint(targets, { x: 20, y: 0 }, 2500),
      'out',
    );
  });

  test('construction target pick: カメラの手前に無い候補は選ばない', () => {
    const targets = [point('behind', 5, 0, false), point('front', 40, 0, true)];
    assert.equal(
      pickConstructionTargetAtScreenPoint(targets, { x: 0, y: 0 }, 2500),
      'front',
    );
    assert.equal(
      pickConstructionTargetAtScreenPoint([point('behind', 5, 0, false)], { x: 0, y: 0 }, 2500),
      null,
    );
  });

  test('construction target pick: 同じ入力には同じ結果を返す', () => {
    const targets = [point('a', 10, 0), point('b', -10, 0)];
    const radius = CONSTRUCTION_TARGET_PICK_RADIUS_SQ;
    assert.equal(
      pickConstructionTargetAtScreenPoint(targets, { x: 0, y: 0 }, radius),
      pickConstructionTargetAtScreenPoint(targets, { x: 0, y: 0 }, radius),
    );
  });

  test('insertion offset: 0 で最大、時間を過ぎると 0', () => {
    assert.equal(insertionOffsetAt(0), INSERTION_OFFSET_DISTANCE_M);
    assert.equal(insertionOffsetAt(-10), INSERTION_OFFSET_DISTANCE_M);
    assert.equal(insertionOffsetAt(INSERTION_OFFSET_DURATION_MS), 0);
    assert.equal(insertionOffsetAt(INSERTION_OFFSET_DURATION_MS + 1), 0);
  });

  test('insertion offset: 2 m から 0 へ単調に減る', () => {
    let previous = INSERTION_OFFSET_DISTANCE_M;
    for (let ms = 0; ms < INSERTION_OFFSET_DURATION_MS; ms += 10) {
      const offset = insertionOffsetAt(ms);
      assert.ok(offset <= previous, `offset grew at ${ms}ms: ${offset} > ${previous}`);
      assert.ok(offset >= 0);
      previous = offset;
    }
    // 途中では 0 より大きい(差し込み途中のモジュールが見える)。
    assert.ok(insertionOffsetAt(INSERTION_OFFSET_DURATION_MS / 2) > 0);
    assert.ok(insertionOffsetAt(INSERTION_OFFSET_DURATION_MS / 2) < INSERTION_OFFSET_DISTANCE_M);
  });
}
