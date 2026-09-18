// 視点の直列化が、遊ぶ人の選んだ状態をそのまま戻すことを検査する。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { bodyAnchorSource } from '../../src/physics/attractor';
import { LOCAL_FORWARD, LOCAL_UP, qFromAxisAngle, qInvert, qMul, qRotate, type Quat } from '../../src/math/quat';
import { len, norm, sub, v3, type SerializedVec3 } from '../../src/math/vec3';
import { RunEventLog } from '../../src/game/run-events';
import { Viewer, type SerializedViewer } from '../../src/game/viewer/viewer';
import { solarSystemParts } from '../physics/test-helpers';
import type { CameraFrameSample } from '../../src/game/viewer/focus-camera-selection';
import type { SerializedPredictPanelSelection } from '../../src/game/viewer/predict-panel-selection';
import type { CelestialSystem } from '../../src/game/celestial/celestial-system';
import type { EntityRoster } from '../../src/game/dynamic/entity-roster';

// 操作対象がいる進行。戦闘ビューへ入れる。
const control = { current: { plan: { nodes: [] } } };
const emptyRoster: EntityRoster = { all: () => [], collectionRevision: 0, simTime: 0 };

// 新しいゲームの視点を、celestialSystem の天体で組む。
function newViewer(celestialSystem: CelestialSystem): Viewer {
  return Viewer.create(control, new RunEventLog(), celestialSystem);
}

// 直列化した視点 serialized を、顔ぶれが空の進行の上に復元する。
function restoredViewer(serialized: SerializedViewer, celestialSystem: CelestialSystem): Viewer {
  return Viewer.deserialize(serialized, emptyRoster, control, new RunEventLog(), celestialSystem);
}

// 表示時刻 0 に、姿勢 attitude の機体を注視しているフレームの材料。姿勢を引けなければ null。
function sample(attitude: Quat | null): CameraFrameSample {
  return {
    displayTime: 0,
    frameAnchors: bodyAnchorSource([], 0),
    attitude,
    referenceUp: v3(0, 1, 0),
    lostFocus: null,
  };
}

// 2つの方向 actual・expected が、expected の大きさに対する丸め誤差の範囲で一致するか。
function assertCloseVec(actual: SerializedVec3, expected: SerializedVec3): void {
  const error = len(sub(v3(actual.x, actual.y, actual.z), v3(expected.x, expected.y, expected.z)));
  assert.ok(error <= 1e-9 * Math.max(1, len(v3(expected.x, expected.y, expected.z))), `${error}`);
}

// 視点の直列化した形 actual が expected と同じ選択を表すか。カメラの向きは基底から組み直すので、
// 丸め誤差の範囲で比べる。
function assertSameViewer(actual: SerializedViewer, expected: SerializedViewer): void {
  const withoutOrientation = ({ camera, ...rest }: SerializedViewer): unknown => ({
    ...rest,
    combat: { ...camera.combat, offset: null, up: null },
    map: { ...camera.map, offset: null, up: null },
  });
  assert.deepEqual(withoutOrientation(actual), withoutOrientation(expected));
  for (const view of ['combat', 'map'] as const) {
    assertCloseVec(actual.camera[view].offset, expected.camera[view].offset);
    assertCloseVec(actual.camera[view].up, expected.camera[view].up);
  }
}

// 2つの回転が同じ向きを表すか。符号の違う四元数も同じ回転なので、回した基底で比べる。
function assertSameRotation(actual: Quat, expected: Quat): void {
  for (const axis of [LOCAL_FORWARD, LOCAL_UP]) {
    assert.ok(len(sub(qRotate(actual, axis), qRotate(expected, axis))) < 1e-9);
  }
}

export function register(): void {
  test('viewer-serialization: 選び直した視点は、復元しても同じ選択として畳まれる', () => {
    // SAVE.md「保存される内容」・INVARIANTS.md §6「そのゲームの空間と時間に依拠する選択は、そのゲームのセーブに残る」
    const { system } = solarSystemParts();
    const viewer = newViewer(system);
    viewer.orbitReference.setMode('moon');
    const panel = viewer.predictPanel;
    panel.setFrameCenter('moon');
    panel.setFrameRotation({ kind: 'revolution', id: 'moon' });
    panel.selectCustomDuration(3 * 86400);
    panel.selectCustomPastDuration(2 * 86400);
    panel.setSliderT(0.4);
    panel.setTickLabelMode('relative');
    panel.setShowElementTimes(true);
    panel.setFollowCamera(false);
    panel.setShowTicks(false);
    // 回転追従が成り立たないフレームを1つ挟んでから注視を差し替え、2つの猶予を途中の値にする。
    viewer.camera.combat.followProgress(sample(null));
    viewer.camera.combat.setFocus({ kind: 'object', id: 'moon' });
    viewer.entityDisplay.toggleTrajectoryLine('entity-3');
    viewer.entityDisplay.setProteinDisplay({ representation: 'silhouette', colorMode: 'hydrophobicity' });
    viewer.navTarget.toggle('moon', '月');
    const serialized = viewer.serialize();

    // 既定へ落ちたことを往復が見逃さないよう、確かめる項目はどれも既定と違う値にしてある。
    const initial = newViewer(system).serialize();
    assert.notEqual(serialized.orbitReference, initial.orbitReference);
    for (const key of Object.keys(serialized.predictPanel) as (keyof SerializedPredictPanelSelection)[]) {
      assert.notDeepEqual(serialized.predictPanel[key], initial.predictPanel[key], key);
    }
    assert.notEqual(serialized.camera.combat.staleFollowFrames, initial.camera.combat.staleFollowFrames);
    assert.notEqual(serialized.camera.combat.focusReplaced, initial.camera.combat.focusReplaced);
    assert.notDeepEqual(serialized.entityDisplay.trajectoryLineIds, initial.entityDisplay.trajectoryLineIds);
    assert.notDeepEqual(serialized.entityDisplay.proteinDisplay, initial.entityDisplay.proteinDisplay);

    assertSameViewer(restoredViewer(serialized, system).serialize(), serialized);
  });

  test('viewer-serialization: 記録に無い項目は、新しいゲームの既定で補われる', () => {
    // SAVE.md「形式の版」: 記録に無い項目は、読み込むときに基底値で補われる
    const { system } = solarSystemParts();
    assert.deepEqual(restoredViewer({} as SerializedViewer, system).serialize(), newViewer(system).serialize());
  });

  test('viewer-serialization: 姿勢追従中の戦闘カメラは、保存時と違う姿勢で再開しても機体に対する向きを保つ', () => {
    // INVARIANTS.md §6「遊ぶ人が選んだ状態は保存され、次に来ても同じ状態から始まる」・CAMERA.md §3 機体の姿勢への追従
    const { system } = solarSystemParts();
    const viewer = newViewer(system);
    const attitudeInCombat = qFromAxisAngle(v3(0, 1, 0), 0.7);
    viewer.followCameraProgress([], { combat: sample(attitudeInCombat), map: sample(null) });
    const relativeToShip = qMul(qInvert(attitudeInCombat), viewer.camera.combat.rotation);

    // マップビューにいるあいだに機体が回り、そのまま保存する。戦闘カメラはその回転を見ていない。
    viewer.view.toggle();
    const attitudeAtSave = qFromAxisAngle(norm(v3(1, 0, 1)), 2.1);
    viewer.followCameraProgress([], { combat: sample(attitudeAtSave), map: sample(null) });
    const resumed = restoredViewer(viewer.serialize(), system);
    resumed.view.toggle();
    resumed.followCameraProgress([], { combat: sample(attitudeAtSave), map: sample(null) });

    assert.equal(resumed.view.current, 'combat');
    assertSameRotation(qMul(qInvert(attitudeAtSave), resumed.camera.combat.rotation), relativeToShip);
  });
}
