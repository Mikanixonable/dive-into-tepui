import * as assert from 'node:assert/strict';
import { v3 } from '../../src/math/vec3';
import { separationImpulseVelocities } from '../../src/game/ship/ship-decoupling';
import { test } from '../harness';

export function register(): void {
  test('ship decoupling: 分離速度は相対速度を作りつつ並進運動量を保存する', () => {
    const result = separationImpulseVelocities(
      v3(3, 0, 0), v3(3, 0, 0), v3(1, 0, 0), 2, 3, 8,
    );
    assert.ok(Math.abs(result.detached.x - result.retained.x - 8) < 1e-12);
    assert.ok(Math.abs(2 * result.retained.x + 3 * result.detached.x - 15) < 1e-12);
    assert.equal(result.retained.y, 0);
    assert.equal(result.detached.y, 0);
  });
}
