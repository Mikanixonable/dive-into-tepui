// CameraView(render/camera/camera-view.ts)の回帰テスト。1回の sync が、THREE カメラ・投影・
// 尺度・描画原点を「同じ1時点の値」として確定することを見る。期待値の正本は、描画原点の定義
// (カメラ位置を原点へ寄せる)と、同じ入力なら同じ表示になるという決定論性で、近遠クリップ面や
// 画角そのものの調整値は固定しない。
import * as assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { test } from '../harness';
import { CameraView } from '../../src/render/camera/camera-view';
import { v3 } from '../../src/math/vec3';
import type { Viewpoint } from '../../src/math/projection';
import type { Viewport } from '../../src/render/viewport';

const VIEWPORT: Viewport = { width: 1600, height: 900, pixelRatio: 1 };

// 地球半径ほど離れた点から原点を見下ろす視点。位置に大きな絶対値を入れて、描画原点の平行移動が
// 効いていることを見えるようにする。
const EYE = v3(7.0e6, 1.0e6, -2.0e6);
const LOOK = v3(1.0e6, 0, 0);

function perspectiveViewpoint(fovDeg = 50): Viewpoint {
  return {
    position: EYE,
    lookTarget: LOOK,
    up: v3(0, 1, 0),
    fovDeg,
    aspect: VIEWPORT.width / VIEWPORT.height,
    projection: 'perspective',
  };
}

function orthographicViewpoint(): Viewpoint {
  return { ...perspectiveViewpoint(), projection: 'orthographic', orthographicHalfHeight: 4.0e6 };
}

// 注視距離。近遠クリップ面の入力に使う。
const CLIP_DISTANCE = 6.4e6;
const CLIP_FOV_DEG = 50;

export function register(): void {
  test('camera-view: 描画原点はカメラ位置で、THREE カメラは原点に立つ', () => {
    const view = new CameraView();
    const frame = view.sync(
      perspectiveViewpoint(), CLIP_FOV_DEG, CLIP_DISTANCE, VIEWPORT, 'combat', false, v3(),
    );

    // 描画原点を通した視点の位置は、単精度で扱える大きさまで潰れていなければならない。
    const eyeInFrame = frame.floatingOrigin.RtoThreeV3(EYE);
    assert.ok(eyeInFrame.length() === 0, `描画原点がカメラ位置に揃っていない (${eyeInFrame.length()})`);
    assert.ok(frame.camera.position.length() === 0, 'THREE カメラが原点に立っていない');
  });

  test('camera-view: 速度基準を差し引いた速度は 0 になる', () => {
    const view = new CameraView();
    const focusVelocity = v3(1.2e3, -3.4e2, 7.6e2);
    const frame = view.sync(
      perspectiveViewpoint(), CLIP_FOV_DEG, CLIP_DISTANCE, VIEWPORT, 'map', false, focusVelocity,
    );
    assert.ok(frame.floatingOrigin.VtoThreeV3(focusVelocity).length() === 0, '速度基準が注視点の速度と違う');
  });

  test('camera-view: 同じ入力を再び sync すると、投影も尺度もカメラ行列も一致する', () => {
    const view = new CameraView();
    const probe = v3(2.0e6, 5.0e5, 1.0e6);

    const first = view.sync(perspectiveViewpoint(), CLIP_FOV_DEG, CLIP_DISTANCE, VIEWPORT, 'combat', false, v3());
    const firstProjected = first.project(probe);
    const firstScale = first.scale(probe);
    const firstRadial = first.radialScale(probe);
    const firstMatrix = first.camera.matrixWorld.elements.slice();
    const firstProjection = (first.camera as THREE.PerspectiveCamera).projectionMatrix.elements.slice();

    const second = view.sync(perspectiveViewpoint(), CLIP_FOV_DEG, CLIP_DISTANCE, VIEWPORT, 'combat', false, v3());
    assert.deepEqual(second.project(probe), firstProjected, '投影が再現しない');
    assert.equal(second.scale(probe), firstScale, '尺度が再現しない');
    assert.equal(second.radialScale(probe), firstRadial, '直線距離の尺度が再現しない');
    assert.deepEqual([...second.camera.matrixWorld.elements], firstMatrix, 'カメラ行列が再現しない');
    assert.deepEqual(
      [...(second.camera as THREE.PerspectiveCamera).projectionMatrix.elements], firstProjection,
      '投影行列が再現しない',
    );
  });

  test('camera-view: 注視点はどのビューポートでも画面の中心へ写る', () => {
    const view = new CameraView();
    const wide: Viewport = { width: 1920, height: 1080, pixelRatio: 2 };
    const narrow: Viewport = { width: 640, height: 960, pixelRatio: 1 };

    for (const viewport of [wide, narrow]) {
      const viewpoint = { ...perspectiveViewpoint(), aspect: viewport.width / viewport.height };
      const frame = view.sync(viewpoint, CLIP_FOV_DEG, CLIP_DISTANCE, viewport, 'map', false, v3());
      const center = frame.project(LOOK);
      assert.ok(Math.abs(center.x - viewport.width / 2) < 1e-6, `中心からずれた x=${center.x}`);
      assert.ok(Math.abs(center.y - viewport.height / 2) < 1e-6, `中心からずれた y=${center.y}`);
      assert.equal(center.front, true, '注視点が前方と判定されない');
    }
  });

  test('camera-view: 視点の投影方式が、描画に使う THREE カメラを決める', () => {
    const view = new CameraView();
    const perspective = view.sync(
      perspectiveViewpoint(), CLIP_FOV_DEG, CLIP_DISTANCE, VIEWPORT, 'combat', false, v3(),
    );
    assert.ok(perspective.camera instanceof THREE.PerspectiveCamera, '透視視点で透視カメラが選ばれない');

    const orthographic = view.sync(
      orthographicViewpoint(), CLIP_FOV_DEG, CLIP_DISTANCE, VIEWPORT, 'map', false, v3(),
    );
    assert.ok(orthographic.camera instanceof THREE.OrthographicCamera, '平行視点で平行カメラが選ばれない');
    // 平行投影の尺度は視点からの距離に依らない。
    assert.equal(
      orthographic.radialScale(v3(0, 0, 0)), orthographic.radialScale(v3(3.0e7, 0, 0)),
      '平行投影の尺度が距離で変わっている',
    );
  });
}
