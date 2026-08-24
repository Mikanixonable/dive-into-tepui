// occlusion.ts の回帰テスト。
import * as assert from 'node:assert/strict';
import { test } from './harness';
import { isOccluded, occlusionOpacity } from '../../src/physics/occlusion';
import { CelestialBody } from '../../src/physics/celestial-body';
import { kinematicState } from '../../src/physics/kinematic-state';
import { v3 } from '../../src/physics/vec3';

const ZERO = v3(0, 0, 0);
const EARTH: CelestialBody = {
  id: 'earth', mu: 1, radius: 6.371e6, state: kinematicState(0, ZERO, ZERO), accel: ZERO, degree2: null, atmosphere: null, isStar: false,
};

export function register(): void {
  test('occlusion: マップ上の見かけ半径を基準に1.5Rから1.0Rでフェードする', () => {
    const cameraPos = v3(-2e7, 0, 0);
    const centerDistance = 2e7;
    const apparentRadius = Math.asin(EARTH.radius / centerDistance);
    const pointAt = (multiple: number): ReturnType<typeof v3> => {
      const angle = apparentRadius * multiple;
      const dir = v3(Math.cos(angle), Math.sin(angle), 0);
      return v3(cameraPos.x + dir.x * 6e7, dir.y * 6e7, 0);
    };

    assert.equal(occlusionOpacity(cameraPos, pointAt(1.5), [EARTH]), 1);
    assert.ok(Math.abs(occlusionOpacity(cameraPos, pointAt(1.25), [EARTH]) - 0.5) < 1e-12);
    assert.ok(occlusionOpacity(cameraPos, pointAt(1), [EARTH]) < 1e-12);
    assert.equal(occlusionOpacity(cameraPos, pointAt(0.5), [EARTH]), 0);
  });

  test('occlusion: 天体の裏側の点は遮蔽される', () => {
    const cameraPos = v3(-2e7, 0, 0);
    const farSide = v3(EARTH.radius + 1e5, 0, 0); // カメラから見て地球の向こう側
    assert.equal(isOccluded(cameraPos, farSide, [EARTH]), true);
  });

  test('occlusion: カメラ側の点は遮蔽されない', () => {
    const cameraPos = v3(-2e7, 0, 0);
    const nearSide = v3(-(EARTH.radius + 1e5), 0, 0); // カメラから見て地球の手前側
    assert.equal(isOccluded(cameraPos, nearSide, [EARTH]), false);
  });

  test('occlusion: 天体から外れた視線上の点は遮蔽されない', () => {
    const cameraPos = v3(-2e7, 0, 0);
    const offAxis = v3(EARTH.radius + 1e5, 2 * EARTH.radius, 0);
    assert.equal(isOccluded(cameraPos, offAxis, [EARTH]), false);
  });

  test('occlusion: 対象天体自身の表面上の点(自分自身を回っている物体)は自己遮蔽しない', () => {
    const cameraPos = v3(-2e7, 0, 0);
    const onSurfaceFacingCamera = v3(-EARTH.radius, 0, 0);
    assert.equal(isOccluded(cameraPos, onSurfaceFacingCamera, [EARTH]), false);
  });

  test('occlusion: 天体自身の中心(その天体のラベル位置)は自己遮蔽しない', () => {
    const cameraPos = v3(-2e7, 0, 0);
    assert.equal(isOccluded(cameraPos, EARTH.state.r, [EARTH]), false);
  });

  test('occlusion: カメラの後方にある天体は遮蔽しない', () => {
    const cameraPos = v3(0, 0, 0);
    const point = v3(1e7, 0, 0);
    const behindCamera: CelestialBody = { ...EARTH, state: kinematicState(0, v3(-1e7, 0, 0), ZERO) };
    assert.equal(isOccluded(cameraPos, point, [behindCamera]), false);
  });
}
