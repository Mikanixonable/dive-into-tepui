import * as assert from 'node:assert/strict';
import { SPHERE_LOD_LADDER, sphereLodLevel } from '../../src/render/celestial/screen-lod';
import { test } from '../harness';

export function register(): void {
  test('screen lod: 初回選択は純粋で不正値を決定的に処理する', () => {
    assert.strictEqual(sphereLodLevel(0), SPHERE_LOD_LADDER[0]);
    assert.strictEqual(sphereLodLevel(-1), SPHERE_LOD_LADDER[0]);
    assert.strictEqual(sphereLodLevel(Number.NaN), SPHERE_LOD_LADDER[0]);
    assert.strictEqual(sphereLodLevel(Number.POSITIVE_INFINITY), SPHERE_LOD_LADDER.at(-1));
    assert.strictEqual(sphereLodLevel(2_000), SPHERE_LOD_LADDER[1]);
  });

}
