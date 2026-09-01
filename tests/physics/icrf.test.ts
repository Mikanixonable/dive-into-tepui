// ICRF 軸からゲームの固定慣性軸への付け替え。**原点は動かさない。**
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { icrfToGameEci } from '../../src/physics/icrf';
import { v3 } from '../../src/math/vec3';

export function register(): void {
  test('icrf: ICRF Z極をゲームECI Y極へ右手系で写す', () => {
    assert.deepEqual(icrfToGameEci(v3(1, 2, 3)), v3(1, 3, -2));
  });
}
