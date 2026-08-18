import * as assert from 'node:assert/strict';
import { test } from '../physics/harness';
import { addToCluster, mergeCluster, removeFromCluster } from '../../src/game/vessel/docking-cluster';
import { v3 } from '../../src/physics/vec3';

export function register(): void {
  test('docking cluster preserves center-of-mass velocity', () => {
    const a = { id: 'a', mass: 2, position: v3(0, 0, 0), velocity: v3(1, 0, 0), radius: 1 };
    const b = { id: 'b', mass: 3, position: v3(10, 0, 0), velocity: v3(-1, 0, 0), radius: 1 };
    const cluster = mergeCluster(a, b);
    assert.equal(cluster.mass, 5);
    assert.equal(cluster.velocity.x, -0.2);
    assert.equal(removeFromCluster(addToCluster(cluster, { ...b, id: 'c' }), 'c').cluster!.mass, 5);
  });
}
