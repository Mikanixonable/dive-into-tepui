import * as assert from 'node:assert/strict';
import { gameInputMode } from '../../src/game/input/game-input-router';
import { nextCatalogDefinitionId } from '../../src/game/ship/ship-construction-pointer';
import { test } from '../harness';

// 入力の振り分けとカタログ巡回のテストを登録する。
export function register(): void {
  test('construction input routing: 建造中は camera と建造操作だけを通す', () => {
    assert.deepEqual(gameInputMode(false, false, true), {
      camera: true, construction: true, world: false, simulation: false,
    });
  });

  test('construction input routing: 通常・pause・modal の優先順位を保つ', () => {
    assert.deepEqual(gameInputMode(false, false, false), {
      camera: true, construction: false, world: true, simulation: true,
    });
    assert.deepEqual(gameInputMode(true, false, false), {
      camera: true, construction: false, world: false, simulation: false,
    });
    assert.deepEqual(gameInputMode(false, true, true), {
      camera: false, construction: false, world: false, simulation: false,
    });
  });

  test('construction catalog cycle: 定義順で送り、端では折り返す', () => {
    const ids = ['a', 'b', 'c'];
    assert.equal(nextCatalogDefinitionId(ids, 'a', 1), 'b');
    assert.equal(nextCatalogDefinitionId(ids, 'c', 1), 'a');
    assert.equal(nextCatalogDefinitionId(ids, 'a', -1), 'c');
    // 持っていない・一覧に無いときは、次へは先頭、前へは末尾へ送る。
    assert.equal(nextCatalogDefinitionId(ids, null, 1), 'a');
    assert.equal(nextCatalogDefinitionId(ids, 'z', -1), 'c');
    assert.equal(nextCatalogDefinitionId([], null, 1), null);
  });
}
