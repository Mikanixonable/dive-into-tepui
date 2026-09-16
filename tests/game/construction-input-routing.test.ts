import * as assert from 'node:assert/strict';
import { gameInputMode } from '../../src/game/input/game-input-router';
import { test } from '../harness';

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
}
