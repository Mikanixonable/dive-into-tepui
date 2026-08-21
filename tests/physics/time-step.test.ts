import * as assert from 'node:assert/strict';
import { reentryAwareMaxStep, simulationStepDuration } from '../../src/game/simulation/time-step';
import { test } from './harness';
import { v3 } from '../../src/physics/vec3';
import { kinematicState } from '../../src/physics/kinematic-state';
import { CelestialBody } from '../../src/physics/celestial-body';
import { Atmosphere } from '../../src/physics/atmosphere';
import { REENTRY_SUBSTEP_ALT, REENTRY_SUBSTEP_MAX_DT } from '../../src/game/const';

// 基準楕円体の半径がちょうど 1000 の真球で、層は1つだけの試験用の大気。高度がそのまま
// 読めるので、境界の判定だけを見られる。
const UNIT_ATMOSPHERE: Atmosphere = {
  equatorRadius: 1000, polarRadius: 1000, spinRate: 0, layers: [[0, 1, 100]], pole: v3(0, 1, 0),
};

// center を中心に静止した、大気を持つ/持たない天体。
function body(atmosphere: Atmosphere | null, center = v3()): CelestialBody {
  return {
    id: 'b', mu: 1, radius: 1000, state: kinematicState(0, center, v3()), accel: v3(),
    degree2: null, atmosphere, isStar: false,
  };
}

export function register(): void {
  test('time-step: known event boundary is never crossed', () => {
    assert.equal(simulationStepDuration(100, 200, 20, 107.5), 7.5);
  });

  test('time-step: frame and maximum-step boundaries still apply without an earlier event', () => {
    assert.equal(simulationStepDuration(100, 110, 20, null), 10);
    assert.equal(simulationStepDuration(100, 200, 20, 150), 20);
  });

  test('time-step: reentry boundary and just below stay on the fine step', () => {
    const at = (alt: number) => kinematicState(0, v3(1000 + alt, 0, 0), v3(-100, 0, 0));
    const bodies = [body(UNIT_ATMOSPHERE)];
    assert.equal(reentryAwareMaxStep([at(REENTRY_SUBSTEP_ALT)], bodies, 20), REENTRY_SUBSTEP_MAX_DT);
    assert.equal(reentryAwareMaxStep([at(REENTRY_SUBSTEP_ALT - 0.001)], bodies, 20), REENTRY_SUBSTEP_MAX_DT);
  });

  test('time-step: just above reentry boundary stops exactly at it', () => {
    // 境界の 1m 上を 100m/s で降りるので、境界へ届くのは 0.01s 後。
    const state = kinematicState(0, v3(1000 + REENTRY_SUBSTEP_ALT + 1, 0, 0), v3(-100, 0, 0));
    assert.ok(Math.abs(reentryAwareMaxStep([state], [body(UNIT_ATMOSPHERE)], 20) - 0.01) < 1e-12);
  });

  test('time-step: 大気を持たない天体のすぐ上では、どれだけ低くても細分化しない', () => {
    // 大気の密度勾配が細分化の理由なので、大気の無いところに再突入域は存在しない。
    const onSurface = kinematicState(0, v3(1000, 0, 0), v3(-100, 0, 0));
    assert.equal(reentryAwareMaxStep([onSurface], [body(null)], 20), 20);
    assert.equal(reentryAwareMaxStep([onSurface], [], 20), 20);
  });

  test('time-step: 高度は ECI 原点ではなく、その大気天体の中心から測る', () => {
    // 天体を原点から遠くへ置く。原点基準で測っていれば「はるか高空」に見えるが、
    // その天体から見れば再突入域の中にいる。
    const center = v3(0, 0, 5e7);
    const inside = kinematicState(0, v3(0, 0, 5e7 + 1000 + REENTRY_SUBSTEP_ALT / 2), v3(0, 0, -100));
    assert.equal(reentryAwareMaxStep([inside], [body(UNIT_ATMOSPHERE, center)], 20), REENTRY_SUBSTEP_MAX_DT);
  });

  test('time-step: 上昇中は境界の外にいる限り刻みを縮めない', () => {
    const climbing = kinematicState(0, v3(1000 + REENTRY_SUBSTEP_ALT * 1.5, 0, 0), v3(100, 0, 0));
    assert.equal(reentryAwareMaxStep([climbing], [body(UNIT_ATMOSPHERE)], 20), 20);
  });
}
