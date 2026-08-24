import * as assert from 'node:assert/strict';
import { dot, len, scale, sub, v3 } from '../../src/physics/vec3';
import {
  boosterRelativeVelocity,
  boosterSeparationMomentum,
  boosterSeparationVelocities,
} from '../../src/game/player/booster-separation';
import { test } from './harness';

function close(actual: number, expected: number, epsilon = 1e-9): void {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`);
}

export function register(): void {
  test('booster separation: 相対速度は船尾方向で指定値になる', () => {
    const forward = v3(0, 0, 1);
    const velocities = boosterSeparationVelocities(v3(10, 20, 30), forward, 2_000, 1_000, 8);
    const relative = boosterRelativeVelocity(velocities);
    close(len(relative), 8);
    close(dot(relative, forward), -8);
  });

  test('booster separation: 分離前後の並進運動量を保存する', () => {
    const base = v3(100, -50, 25);
    const playerMass = 1_750;
    const boosterMass = 650;
    const velocities = boosterSeparationVelocities(base, v3(0, 0, 1), playerMass, boosterMass, 8);
    const after = boosterSeparationMomentum(velocities, playerMass, boosterMass);
    const before = scale(base, playerMass + boosterMass);
    close(len(sub(after, before)), 0, 1e-8);
  });
}
