import * as assert from 'node:assert/strict';
import { test } from './harness';
import { distanceSqPointToSegment, pointSphereFade, segmentIntersectsSphere } from '../../src/physics/orbit-line-geometry';
import { v3 } from '../../src/physics/vec3';

export function register(): void {
  test('orbit-line geometry: 線分の途中で球を横切る場合も除外する', () => {
    const center = v3(0, 0, 0);
    const start = v3(-10, 0, 0);
    const end = v3(10, 0, 0);
    assert.equal(distanceSqPointToSegment(center, start, end), 0);
    assert.ok(segmentIntersectsSphere(start, end, center, 1));
    // 端点はいずれも球の外側なので、端点だけを見ていた実装では見落とすケース。
    assert.ok(Math.hypot(start.x, start.y, start.z) > 1);
    assert.ok(Math.hypot(end.x, end.y, end.z) > 1);
  });

  test('orbit-line geometry: 球から離れた線分は除外しない', () => {
    assert.ok(!segmentIntersectsSphere(v3(-10, 3, 0), v3(10, 3, 0), v3(), 1));
  });

  test('orbit-line geometry: 頂点フェードは物理半径に対して単調', () => {
    const center = v3();
    assert.equal(pointSphereFade(center, center, 1), 0);
    assert.equal(pointSphereFade(v3(2, 0, 0), center, 1), 1);
    assert.ok(pointSphereFade(v3(1.5, 0, 0), center, 1) > 0);
  });
}
