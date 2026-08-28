import * as assert from 'node:assert/strict';
import { Vec3, add, dot, len, scale, sub, v3 } from '../../src/math/vec3';
import {
  BoosterSeparationVelocities,
  boosterSeparationVelocities,
} from '../../src/game/player/booster-separation';
import { test } from '../harness';

function close(actual: number, expected: number, epsilon = 1e-9): void {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`);
}

// ブースターから見た機体の離れ方。分離後の両速度の差。
function relativeVelocity(velocities: BoosterSeparationVelocities): Vec3 {
  return sub(velocities.booster, velocities.player);
}

// 分離後の並進運動量の総和。分離前の m*v と一致しなければならない。
function totalMomentum(
  velocities: BoosterSeparationVelocities,
  playerMass: number,
  boosterMass: number,
): Vec3 {
  return add(scale(velocities.player, playerMass), scale(velocities.booster, boosterMass));
}

export function register(): void {
  test('booster separation: 相対速度は船尾方向で指定値になる', () => {
    const forward = v3(0, 0, 1);
    const velocities = boosterSeparationVelocities(v3(10, 20, 30), forward, 2_000, 1_000, 8);
    const relative = relativeVelocity(velocities);
    close(len(relative), 8);
    close(dot(relative, forward), -8);
  });

  test('booster separation: 分離前後の並進運動量を保存する', () => {
    const base = v3(100, -50, 25);
    const playerMass = 1_750;
    const boosterMass = 650;
    const velocities = boosterSeparationVelocities(base, v3(0, 0, 1), playerMass, boosterMass, 8);
    const after = totalMomentum(velocities, playerMass, boosterMass);
    const before = scale(base, playerMass + boosterMass);
    close(len(sub(after, before)), 0, 1e-8);
  });
}
