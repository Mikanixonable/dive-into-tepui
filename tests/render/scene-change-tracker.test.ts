// 変化量の推定の回し方(番号の進み方・カメラの鍵・宣言の写し)を検査する。
import * as assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { test } from '../harness';
import { Q_IDENTITY } from '../../src/math/quat';
import { v3 } from '../../src/math/vec3';
import { SceneChangeTracker } from '../../src/render/pipeline/scene-change-tracker';
import type { SceneChangeSample } from '../../src/render/pipeline/scene-change';
import type { PlanetLightSource } from '../../src/render/pipeline/lighting/planet-light-source';
import type { BodyShadow } from '../../src/render/pipeline/shadow/body-shadow';
import type { SunLight } from '../../src/render/pipeline/sun-light';

function sample(cameraKey: string, x = 0): SceneChangeSample {
  return {
    cameraKey,
    reference: { position: v3(), orientation: Q_IDENTITY },
    camera: { position: v3(x, 0, 10), orientation: Q_IDENTITY },
    projection: { kind: 'orthographic', halfHeight: 100, aspect: 2 },
    lights: [],
    sunlit: 1,
  };
}

export function register(): void {
  test('scene-change-tracker: 鍵が同じ連続番号は推定し、鍵が替わると切る', () => {
    const tracker = new SceneChangeTracker();
    tracker.set({ cameraKey: 'a', referencePosition: new THREE.Vector3(), referenceOrientation: new THREE.Quaternion() });
    tracker.setWeights({ lightDirection: 0, sunlit: 0, cameraSlide: 1 });
    assert.equal(tracker.changeAt(0, 0, sample('a')), 0);
    assert.ok(tracker.changeAt(1, 0, sample('a', 2)) > 0);
    assert.equal(tracker.changeAt(2, 0, sample('b')), Infinity);
    assert.equal(tracker.lastTerms, null);
  });

  test('scene-change-tracker: 同じ番号の描き直しでは前の様子を進めない', () => {
    const tracker = new SceneChangeTracker();
    tracker.set({ cameraKey: 'a', referencePosition: new THREE.Vector3(), referenceOrientation: new THREE.Quaternion() });
    tracker.setWeights({ lightDirection: 0, sunlit: 0, cameraSlide: 1 });
    tracker.changeAt(5, 0, sample('a'));
    const first = tracker.changeAt(5, 0, sample('a', 2));
    assert.equal(tracker.changeAt(5, 0, sample('a', 50)), first);
    assert.ok(Math.abs(tracker.changeAt(6, 0, sample('a', 4)) - 0.02) < 1e-15);
  });

  test('scene-change-tracker: 番号が飛ぶと指標を切り、外の無限大もそのまま通す', () => {
    const tracker = new SceneChangeTracker();
    tracker.set({ cameraKey: 'a', referencePosition: new THREE.Vector3(), referenceOrientation: new THREE.Quaternion() });
    tracker.changeAt(1, 0, sample('a'));
    assert.equal(tracker.changeAt(3, 0, sample('a', 10)), 0);
    assert.equal(tracker.lastTerms, null);
    assert.equal(tracker.changeAt(4, Infinity, sample('a')), Infinity);
    assert.equal(tracker.lastTerms, null);
  });

  test('scene-change-tracker: set は宣言の位置と姿勢を成分で写す', () => {
    const tracker = new SceneChangeTracker();
    const position = new THREE.Vector3(1, 2, 3);
    const orientation = new THREE.Quaternion(0, 0.2, 0, 1);
    tracker.set({ cameraKey: 'a', referencePosition: position, referenceOrientation: orientation });
    position.set(10, 20, 30);
    orientation.set(1, 0, 0, 0);
    const camera = new THREE.PerspectiveCamera();
    const sun = {
      position: { value: new THREE.Vector3(0, 10, 0) }, intensityValue: 1, radiusValue: 1,
    } as unknown as SunLight;
    const planets = { declaredLights: [] } as unknown as PlanetLightSource;
    const shadow = { declaredBodies: [] } as unknown as BodyShadow;
    const sampled = tracker.sampleOf(camera, sun, planets, shadow);
    assert.deepEqual(sampled.reference.position, v3(1, 2, 3));
    assert.deepEqual(sampled.reference.orientation, { x: 0, y: 0.2, z: 0, w: 1 });
  });
}
