// CameraRig が注視差し替えと一時的な解決失敗を区別する回帰テスト。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { Q_IDENTITY } from '../../src/math/quat';
import { v3 } from '../../src/math/vec3';
import { bodyAnchorSource } from '../../src/physics/attractor';
import { frameDir } from '../../src/physics/frame';
import { CameraRig, type CameraRigSource } from '../../src/game/camera/camera-rig';
import type { CameraFrameSample } from '../../src/game/viewer/focus-camera-selection';
import type { FocusTarget } from '../../src/game/viewer/focus-target';
import { solarSystemParts } from '../physics/test-helpers';

export function register(): void {
  test('camera-rig: 同じidの別 FocusTarget への差し替えは喪失猶予を参照同一性で戻す', () => {
    const celestialBodies = solarSystemParts().system;
    const rig = new CameraRig(celestialBodies);
    let focus: FocusTarget = { kind: 'object', id: 'missing-object' };
    const source: CameraRigSource = {
      get focus() { return focus; },
      focusLossPolicy: 'fallToOrigin',
      distance: 1000,
      pan: frameDir(0, 0, 0),
      cameraFrame: celestialBodies.frames.inertialFrame,
      rotation: Q_IDENTITY,
      projection: 'perspective',
      orthographicHalfHeight: 1,
      fov: 50,
    };
    const sample: CameraFrameSample = {
      displayTime: 0,
      frameAnchors: bodyAnchorSource([], 0),
      attitude: null,
      referenceUp: v3(0, 1, 0),
      lostFocus: null,
    };
    const viewport = { width: 1280, height: 720, pixelRatio: 1 };

    rig.update(source, sample, [], viewport);
    rig.update(source, sample, [], viewport);
    assert.equal(rig.lostFocus, focus);

    focus = { kind: 'object', id: 'missing-object' };
    rig.update(source, sample, [], viewport);
    assert.equal(rig.lostFocus, null);
  });
}
