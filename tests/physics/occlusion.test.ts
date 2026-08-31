// occlusion.ts の回帰テスト。
import { fixedMotion } from './test-helpers';
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { isOccluded, occlusionOpacity } from '../../src/physics/occlusion';
import { CelestialMotion } from '../../src/physics/celestial-motion';
import { kinematicState } from '../../src/physics/kinematic-state';
import { v3 } from '../../src/math/vec3';

const ZERO = v3(0, 0, 0);
const EARTH: CelestialMotion = fixedMotion({
  id: 'earth', mu: 1, radius: 6.371e6, state: kinematicState<'eci'>(0, ZERO, ZERO), accel: ZERO, degree2: null, atmosphere: null,
});

export function register(): void {
  test('occlusion: マップ上の見かけ半径を基準に1.5Rから1.0Rでフェードする', () => {
    const cameraPos = v3(-2e7, 0, 0);
    const centerDistance = 2e7;
    const apparentRadius = Math.asin(EARTH.def.radius / centerDistance);
    const pointAt = (multiple: number): ReturnType<typeof v3> => {
      const angle = apparentRadius * multiple;
      const dir = v3(Math.cos(angle), Math.sin(angle), 0);
      return v3(cameraPos.x + dir.x * 6e7, dir.y * 6e7, 0);
    };

    assert.equal(occlusionOpacity(cameraPos, pointAt(1.5), [EARTH], 0), 1);
    assert.ok(Math.abs(occlusionOpacity(cameraPos, pointAt(1.25), [EARTH], 0) - 0.5) < 1e-12);
    assert.ok(occlusionOpacity(cameraPos, pointAt(1), [EARTH], 0) < 1e-12);
    assert.equal(occlusionOpacity(cameraPos, pointAt(0.5), [EARTH], 0), 0);
  });

  test('occlusion: 天体の裏側の点は遮蔽される', () => {
    const cameraPos = v3(-2e7, 0, 0);
    const farSide = v3(EARTH.def.radius + 1e5, 0, 0); // カメラから見て地球の向こう側
    assert.equal(isOccluded(cameraPos, farSide, [EARTH], 0), true);
  });

  test('occlusion: カメラ側の点は遮蔽されない', () => {
    const cameraPos = v3(-2e7, 0, 0);
    const nearSide = v3(-(EARTH.def.radius + 1e5), 0, 0); // カメラから見て地球の手前側
    assert.equal(isOccluded(cameraPos, nearSide, [EARTH], 0), false);
  });

  test('occlusion: 天体から外れた視線上の点は遮蔽されない', () => {
    const cameraPos = v3(-2e7, 0, 0);
    const offAxis = v3(EARTH.def.radius + 1e5, 2 * EARTH.def.radius, 0);
    assert.equal(isOccluded(cameraPos, offAxis, [EARTH], 0), false);
  });

  test('occlusion: 対象天体自身の表面上の点(自分自身を回っている物体)は自己遮蔽しない', () => {
    const cameraPos = v3(-2e7, 0, 0);
    const onSurfaceFacingCamera = v3(-EARTH.def.radius, 0, 0);
    assert.equal(isOccluded(cameraPos, onSurfaceFacingCamera, [EARTH], 0), false);
  });

  test('occlusion: 天体自身の中心(その天体のラベル位置)は自己遮蔽しない', () => {
    const cameraPos = v3(-2e7, 0, 0);
    assert.equal(isOccluded(cameraPos, EARTH.stateAt(0).r, [EARTH], 0), false);
  });

  test('occlusion: カメラの後方にある天体は遮蔽しない', () => {
    const cameraPos = v3(0, 0, 0);
    const point = v3(1e7, 0, 0);
    const behindCamera: CelestialMotion = fixedMotion({
      id: 'earth', mu: EARTH.def.mu, radius: EARTH.def.radius,
      state: kinematicState<'eci'>(0, v3(-1e7, 0, 0), ZERO),
    });
    assert.equal(isOccluded(cameraPos, point, [behindCamera], 0), false);
  });
}
