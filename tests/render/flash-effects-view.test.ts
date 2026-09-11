// 一時エフェクトの表示同期(render/vfx/flash-effects-view.ts)の回帰テスト。宣言した件数だけが
// 枠へ積まれること、宣言から外れた枠が畳まれること、照準ズーム中に減光する種別だけが暗くなる
// ことを見る。色・大きさ・寿命の調整値そのものは固定しない。
import * as assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { test } from '../harness';
import { FlashEffectsView } from '../../src/render/vfx/flash-effects-view';
import { CameraView } from '../../src/render/camera/camera-view';
import { kinematicState } from '../../src/physics/kinematic-state';
import { v3 } from '../../src/math/vec3';
import type { FlashEffect, FlashKind } from '../../src/render/vfx/flash-effects-view';
import type { CameraFrame } from '../../src/render/camera/camera-frame';
import type { Viewpoint } from '../../src/math/projection';
import type { Viewport } from '../../src/render/viewport';

const VIEWPORT: Viewport = { width: 1280, height: 720, pixelRatio: 1 };

const VIEWPOINT: Viewpoint = {
  position: v3(0, 0, 1e4),
  lookTarget: v3(),
  up: v3(0, 1, 0),
  fovDeg: 50,
  aspect: VIEWPORT.width / VIEWPORT.height,
  projection: 'perspective',
};

// 照準ズーム中かどうかだけを変えた、そのフレームのカメラ。
function cameraFrame(view: CameraView, zoomed: boolean): CameraFrame {
  return view.sync(VIEWPOINT, VIEWPOINT.fovDeg, 1e4, VIEWPORT, 'combat', zoomed, v3());
}

// 種別 kind のフラッシュ1件。寿命の進みは age / duration で決まる。
function effect(kind: FlashKind, age = 0): FlashEffect {
  return { kind, state: kinematicState<'eci'>(0, v3(100, 0, 0), v3()), age, duration: 1, sizeScale: 1 };
}

// view が scene へ置いた InstancedMesh。
function meshIn(scene: THREE.Scene): THREE.InstancedMesh {
  const mesh = scene.children.find((child) => child instanceof THREE.InstancedMesh);
  assert.ok(mesh instanceof THREE.InstancedMesh, 'InstancedMesh がシーンに置かれていない');
  return mesh;
}

// i 番目の枠が畳まれていない(= このフレームに積まれた)か。畳まれた枠は行列がすべて 0。
function occupied(mesh: THREE.InstancedMesh, i: number): boolean {
  const matrix = new THREE.Matrix4();
  mesh.getMatrixAt(i, matrix);
  return matrix.elements.some((value) => value !== 0);
}

// i 番目の枠の明るさ。色に載っているので、成分の和で比べる。
function brightnessAt(mesh: THREE.InstancedMesh, i: number): number {
  const color = new THREE.Color();
  mesh.getColorAt(i, color);
  return color.r + color.g + color.b;
}

export function register(): void {
  test('flash-effects-view: 宣言した件数だけが枠へ積まれる', () => {
    const scene = new THREE.Scene();
    const view = new FlashEffectsView(scene);
    const camera = cameraFrame(new CameraView(), false);
    const mesh = meshIn(scene);

    view.sync([effect('muzzle'), effect('bulletImpact'), effect('gasPuff1')], camera);
    assert.ok(occupied(mesh, 0) && occupied(mesh, 1) && occupied(mesh, 2), '宣言した枠が積まれていない');
    assert.ok(!occupied(mesh, 3), '宣言していない枠が積まれている');
    view.dispose();
  });

  test('flash-effects-view: 宣言から外れた枠は次のフレームで畳まれる', () => {
    const scene = new THREE.Scene();
    const view = new FlashEffectsView(scene);
    const camera = cameraFrame(new CameraView(), false);
    const mesh = meshIn(scene);

    view.sync([effect('muzzle'), effect('bulletImpact')], camera);
    assert.ok(occupied(mesh, 1), '2 件目が積まれていない');
    view.sync([effect('muzzle')], camera);
    assert.ok(occupied(mesh, 0), '残した 1 件が消えている');
    assert.ok(!occupied(mesh, 1), '外れた枠が畳まれていない');

    view.sync([], camera);
    assert.ok(!occupied(mesh, 0), '空の宣言で枠が残っている');
    view.dispose();
  });

  test('flash-effects-view: 同じ宣言を再び sync しても同じ枠になる', () => {
    const scene = new THREE.Scene();
    const view = new FlashEffectsView(scene);
    const camera = cameraFrame(new CameraView(), false);
    const mesh = meshIn(scene);
    const effects = [effect('plasmaImpact', 0.25)];

    view.sync(effects, camera);
    const first = new THREE.Matrix4();
    mesh.getMatrixAt(0, first);
    const firstBrightness = brightnessAt(mesh, 0);

    view.sync(effects, camera);
    const second = new THREE.Matrix4();
    mesh.getMatrixAt(0, second);
    assert.deepEqual([...second.elements], [...first.elements], '同じ宣言で置き方が変わった');
    assert.equal(brightnessAt(mesh, 0), firstBrightness, '同じ宣言で明るさが変わった');
    view.dispose();
  });

  test('flash-effects-view: 寿命が進むほど暗くなる', () => {
    const scene = new THREE.Scene();
    const view = new FlashEffectsView(scene);
    const camera = cameraFrame(new CameraView(), false);
    const mesh = meshIn(scene);

    view.sync([effect('bulletImpact', 0)], camera);
    const fresh = brightnessAt(mesh, 0);
    view.sync([effect('bulletImpact', 0.75)], camera);
    const aged = brightnessAt(mesh, 0);
    assert.ok(aged < fresh, `寿命が進んでも暗くならない (${fresh} → ${aged})`);
    view.dispose();
  });

  test('flash-effects-view: 照準ズーム中は、それで減光する種別だけが暗くなる', () => {
    const scene = new THREE.Scene();
    const view = new FlashEffectsView(scene);
    const cameraView = new CameraView();
    const mesh = meshIn(scene);

    // マズルフラッシュはズームで減光し、着弾フラッシュは減光しない。
    view.sync([effect('muzzle'), effect('bulletImpact')], cameraFrame(cameraView, false));
    const openMuzzle = brightnessAt(mesh, 0);
    const openImpact = brightnessAt(mesh, 1);

    view.sync([effect('muzzle'), effect('bulletImpact')], cameraFrame(cameraView, true));
    assert.ok(brightnessAt(mesh, 0) < openMuzzle, 'ズーム中にマズルフラッシュが減光していない');
    assert.equal(brightnessAt(mesh, 1), openImpact, 'ズームで減光しない種別まで暗くなった');
    view.dispose();
  });
}
