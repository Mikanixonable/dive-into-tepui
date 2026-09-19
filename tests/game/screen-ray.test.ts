import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { screenRay } from '../../src/game/camera/screen-ray';
import { projectToNdc, type Viewpoint } from '../../src/math/projection';
import { add, scale, v3 } from '../../src/math/vec3';

export function register(): void {
  const viewport = { width: 800, height: 600, pixelRatio: 2 };
  const view: Viewpoint = {
    position: v3(10, 20, 30), lookTarget: v3(10, 20, 31), up: v3(0, 1, 0), fovDeg: 60, aspect: 4 / 3,
  };

  test('screen ray: perspective の画面点を通る ray は同じ viewpoint の投影へ戻る', () => {
    const ray = screenRay(view, viewport, 150, 240);
    const point = add(ray.origin, scale(ray.dir, 100));
    const projected = projectToNdc(view, point);
    assert.ok(Math.abs((projected.x * 0.5 + 0.5) * viewport.width - 150) < 1e-9);
    assert.ok(Math.abs((-projected.y * 0.5 + 0.5) * viewport.height - 240) < 1e-9);
  });

  test('screen ray: orthographic は画面位置で始点だけが動き、方向は一定', () => {
    const orthographic = { ...view, projection: 'orthographic' as const, orthographicHalfHeight: 50 };
    const left = screenRay(orthographic, viewport, 0, 300);
    const right = screenRay(orthographic, viewport, 800, 300);
    assert.deepEqual(left.dir, right.dir);
    assert.notDeepEqual(left.origin, right.origin);
  });
}
