// カメラ視点の保存復元・命令列・進行追従を、表示の導出から独立に検査する。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { bodyAnchorSource } from '../../src/physics/attractor';
import { LOCAL_FORWARD, qFromAxisAngle, qFromBasis, qMul, qRotate } from '../../src/math/quat';
import { len, sub, v3 } from '../../src/math/vec3';
import { CommandQueue } from '../../src/game/command-queue';
import { cameraCommands } from '../../src/game/viewer/camera-commands';
import { CameraSelection, type SerializedCameraSelection } from '../../src/game/viewer/camera-selection';
import type {
  CameraFrameSample, SerializedFocusCameraSelection,
} from '../../src/game/viewer/focus-camera-selection';
import { solarSystemParts } from '../physics/test-helpers';

function serializedCamera(
  overrides: Partial<SerializedFocusCameraSelection> = {},
): SerializedFocusCameraSelection {
  return {
    offset: { x: 1.2e7, y: 2.3e7, z: -3.4e7 },
    pan: { x: 1234, y: -5678, z: 9012 },
    up: { x: 0, y: 1, z: 0 },
    rotatingWith: null,
    focus: { kind: 'object', id: 'moon' },
    rotationMode: 'quaternion',
    fovDeg: 63,
    referencePlane: 'moonOrbit',
    projectionMode: 'orthographic',
    orthographicHalfHeight: 8.9e6,
    staleFollowFrames: 0,
    focusReplaced: false,
    ...overrides,
  };
}

function selection(serialized: SerializedCameraSelection): CameraSelection {
  return CameraSelection.deserialize(serialized, solarSystemParts().system, { record: () => {} });
}

function sample(lostFocus: CameraFrameSample['lostFocus'] = null): CameraFrameSample {
  return {
    displayTime: 120,
    frameAnchors: bodyAnchorSource([], 120),
    attitude: null,
    referenceUp: v3(0, 1, 0),
    lostFocus,
  };
}

export function register(): void {
  test('camera-selection: 復元したマップの pan・追従・既存保存項目を変えずに書き戻す', () => {
    const map = serializedCamera({ rotatingWith: { kind: 'revolution', id: 'moon' } });
    const camera = selection({ combat: serializedCamera(), map });
    const restored = camera.map.serialize();

    assert.deepEqual(restored.pan, map.pan);
    assert.deepEqual(restored.rotatingWith, map.rotatingWith);
    assert.deepEqual(restored.focus, map.focus);
    assert.equal(restored.rotationMode, map.rotationMode);
    assert.equal(restored.fovDeg, map.fovDeg);
    assert.equal(restored.referencePlane, map.referencePlane);
    assert.equal(restored.projectionMode, map.projectionMode);
    assert.equal(restored.orthographicHalfHeight, map.orthographicHalfHeight);
  });

  test('camera-selection: DOM相当の注視命令は列を適用するまで pan と注視を変えない', () => {
    const camera = selection({ combat: serializedCamera(), map: serializedCamera() });
    const queue = new CommandQueue();
    const commands = cameraCommands(queue, camera);
    const beforeFocus = camera.map.focus;
    const beforePan = camera.map.pan;

    commands.map.setFocus({ kind: 'object', id: 'earth' });
    assert.equal(camera.map.focus, beforeFocus);
    assert.deepEqual(camera.map.pan, beforePan);

    queue.applyAll();
    assert.deepEqual(camera.map.focus, { kind: 'object', id: 'earth' });
    assert.deepEqual(camera.map.pan, { x: 0, y: 0, z: 0 });
  });

  test('camera-selection: 注視喪失は同じ内容の別値ではなく FocusTarget の同一性で判定する', () => {
    const camera = selection({ combat: serializedCamera(), map: serializedCamera() });
    const focus = camera.map.focus;
    assert.equal(focus.kind, 'object');

    camera.map.followProgress(sample({ kind: 'object', id: focus.kind === 'object' ? focus.id : '' }));
    assert.equal(camera.map.focus, focus);

    camera.map.followProgress(sample(focus));
    assert.notEqual(camera.map.focus, focus);
    assert.deepEqual(camera.map.focus, { kind: 'object', id: 'earth' });
  });

  test('camera-selection: ロード後に姿勢基準を受け取っても、保存された対象姿勢からの相対の向きは変わらない', () => {
    const combat = serializedCamera({
      rotatingWith: { kind: 'attitude' },
      projectionMode: 'perspective',
    });
    const camera = selection({ combat, map: serializedCamera() });
    const before = camera.combat.serialize();
    const attitude = qFromAxisAngle(v3(0, 1, 0), 1.1);
    camera.combat.followProgress({ ...sample(), attitude });
    const after = camera.combat.serialize();

    // 実効の向きは、対象の姿勢に保存した相対の向きを合成したもの。
    const relative = qFromBasis(v3(combat.offset.x, combat.offset.y, combat.offset.z), v3(0, 1, 0));
    const expectedForward = qRotate(qMul(attitude, relative), LOCAL_FORWARD);
    assert.ok(len(sub(qRotate(camera.combat.rotation, LOCAL_FORWARD), expectedForward)) < 1e-9);

    const offsetError = len(sub(
      v3(after.offset.x, after.offset.y, after.offset.z),
      v3(before.offset.x, before.offset.y, before.offset.z),
    ));
    const upError = len(sub(
      v3(after.up.x, after.up.y, after.up.z),
      v3(before.up.x, before.up.y, before.up.z),
    ));
    assert.ok(offsetError < 1e-7 * len(v3(before.offset.x, before.offset.y, before.offset.z)));
    assert.ok(upError < 1e-9);
  });
}
