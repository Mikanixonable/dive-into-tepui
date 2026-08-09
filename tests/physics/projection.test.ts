// projection.ts の回帰テスト: THREE.js の Object3D.lookAt + PerspectiveCamera と
// 同じ基底構築・透視除算になっていることを、手計算できる配置で検証する。
import * as assert from 'node:assert/strict';
import { test } from './harness';
import { metersPerPixel, ndcToScreen, projectToNdc, Viewpoint } from '../../src/physics/projection';
import { addScaled, cross, norm, sub, v3 } from '../../src/physics/vec3';

export function register(): void {
  // forward = +Z, up = +Y, fov=90deg(tanHalf=1) の単純な視点。
  const view: Viewpoint = {
    position: v3(0, 0, 0),
    lookTarget: v3(0, 0, 1),
    up: v3(0, 1, 0),
    fovDeg: 90,
    aspect: 1,
  };

  test('projection: point straight ahead maps to NDC center', () => {
    const p = projectToNdc(view, v3(0, 0, 10));
    assert.ok(p.front);
    assert.ok(Math.abs(p.x) < 1e-9);
    assert.ok(Math.abs(p.y) < 1e-9);
  });

  test('projection: point behind the camera is not front', () => {
    const p = projectToNdc(view, v3(0, 0, -5));
    assert.equal(p.front, false);
  });

  test('projection: point at the frustum edge maps to NDC +-1 (fov=90 => tanHalf=1)', () => {
    // right = normalize(cross(forward,up)) = (-1,0,0) なので、+X 方向へ画角の
    // 半分だけ振った点は ndcX = -1 側の縁に来る。
    const p = projectToNdc(view, v3(10, 0, 10));
    assert.ok(p.front);
    assert.ok(Math.abs(p.x - -1) < 1e-9, `x: ${p.x}`);
    assert.ok(Math.abs(p.y) < 1e-9);
  });

  test('projection: wider aspect shrinks the same horizontal offset in NDC', () => {
    const wide: Viewpoint = { ...view, aspect: 2 };
    const p = projectToNdc(wide, v3(10, 0, 10));
    assert.ok(Math.abs(p.x - -0.5) < 1e-9, `x: ${p.x}`);
  });

  test('ndcToScreen: center maps to the pixel-rect center, +-1 maps to its edges', () => {
    const c = ndcToScreen({ x: 0, y: 0, front: true }, 800, 600);
    assert.ok(Math.abs(c.x - 400) < 1e-9 && Math.abs(c.y - 300) < 1e-9);

    const topRight = ndcToScreen({ x: 1, y: 1, front: true }, 800, 600, 100, 50);
    assert.ok(Math.abs(topRight.x - 900) < 1e-9, `x: ${topRight.x}`); // offsetX + width
    assert.ok(Math.abs(topRight.y - 50) < 1e-9, `y: ${topRight.y}`); // top edge (NDC +Y = screen top)
  });

  // metersPerPixel は垂直画角と縦解像度から決まるので、縦方向の変位で検証する
  // (横方向は aspect が width/height と一致する場合にだけ同じ倍率になる)。
  test('metersPerPixel: N * metersPerPixel displacement maps to N screen pixels', () => {
    const width = 800;
    const height = 600;
    const p = v3(0, 0, 10);
    const mpp = metersPerPixel(view, p, height);

    const forward = norm(sub(view.lookTarget, view.position));
    const right = norm(cross(forward, view.up));
    const camUp = cross(right, forward);
    const n = 100;
    const p2 = addScaled(p, camUp, mpp * n);

    const screen1 = ndcToScreen(projectToNdc(view, p), width, height);
    const screen2 = ndcToScreen(projectToNdc(view, p2), width, height);
    assert.ok(Math.abs(Math.abs(screen2.y - screen1.y) - n) < 1e-6, `dy: ${screen2.y - screen1.y}`);
  });

  test('metersPerPixel: doubling depth doubles metersPerPixel', () => {
    const height = 600;
    const near = metersPerPixel(view, v3(0, 0, 10), height);
    const far = metersPerPixel(view, v3(0, 0, 20), height);
    assert.ok(Math.abs(far - near * 2) < 1e-12, `near: ${near}, far: ${far}`);
  });
}
