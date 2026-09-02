// CameraOrientation が担保する不変量のテスト。期待値の正本は「二表現が同じ向きを指すこと」
// 「切替で視点が跳ばないこと」という仕様(SPEC/CONTROLS.md「基準フレーム」)で、コードの
// 現状ではない。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { CameraOrientation } from '../../src/game/camera/camera-orientation';
import { LOCAL_FORWARD, LOCAL_UP, rotationFromEuler } from '../../src/math/orientation';
import { Quat, qFromAxisAngle, qRotate } from '../../src/math/quat';
import { len, norm, sub, v3 } from '../../src/math/vec3';

const POLAR = norm(v3(0.2, 0.9, -0.1));

// 実効回転が同じ向きを表すか。局所基底の写り先で比べる(q と -q を同一視するため)。
function sameOrientation(a: Quat, b: Quat, tol = 1e-8): boolean {
  return len(sub(qRotate(a, LOCAL_FORWARD), qRotate(b, LOCAL_FORWARD))) < tol
    && len(sub(qRotate(a, LOCAL_UP), qRotate(b, LOCAL_UP))) < tol;
}

function orientation(mode: 'euler' | 'quaternion' = 'euler'): CameraOrientation {
  const q = rotationFromEuler({ yaw: 0.6, pitch: 0.3, roll: -0.2 }, POLAR);
  return new CameraOrientation(q, POLAR, mode, false, null);
}

export function register(): void {
  test('camera-orientation: 回し方を切り替えても向きは変わらない', () => {
    const o = orientation('euler');
    const before = o.effective();
    o.setMode('quaternion', POLAR);
    assert.ok(sameOrientation(o.effective(), before));
    o.setMode('euler', POLAR);
    assert.ok(sameOrientation(o.effective(), before));
  });

  test('camera-orientation: 極軸を引き直しても向きは変わらない', () => {
    const o = orientation();
    const before = o.effective();
    o.rebase(v3(0, 1, 0));
    assert.ok(sameOrientation(o.effective(), before));
    o.restoreFromEuler(v3(0, 1, 0));
    assert.ok(sameOrientation(o.effective(), before));
  });

  test('camera-orientation: 姿勢追従の開始と解除で視点は跳ばない', () => {
    const o = orientation();
    const before = o.effective();
    const attitude = qFromAxisAngle(norm(v3(1, 2, 3)), 0.9);
    o.beginAttitudeFollow(attitude, POLAR);
    assert.equal(o.followingAttitude, true);
    assert.ok(sameOrientation(o.effective(), before), '追従開始で跳んだ');
    o.endAttitudeFollow(POLAR);
    assert.equal(o.followingAttitude, false);
    assert.ok(sameOrientation(o.effective(), before), '追従解除で跳んだ');
  });

  test('camera-orientation: 追従中は対象の姿勢ぶんだけ実効回転が回る', () => {
    const o = orientation();
    const relative = o.stored;
    const attitude = qFromAxisAngle(v3(0, 1, 0), Math.PI / 2);
    o.beginAttitudeFollow(attitude, POLAR);
    // 生の値は対象姿勢からの相対値になり、実効回転だけが元の向きを保つ。
    assert.ok(!sameOrientation(o.stored, relative), '生の値が相対値へ読み替えられていない');
    o.refreshAttitude(qFromAxisAngle(v3(0, 1, 0), Math.PI));
    const turned = o.effective();
    assert.ok(!sameOrientation(turned, o.stored), '対象の姿勢が実効回転へ合成されていない');
  });

  test('camera-orientation: 姿勢が引けないフレームは直前の姿勢を保つ', () => {
    const o = orientation();
    const attitude = qFromAxisAngle(v3(0, 0, 1), 0.4);
    o.beginAttitudeFollow(attitude, POLAR);
    const before = o.effective();
    o.refreshAttitude(null);
    assert.ok(sameOrientation(o.effective(), before));
  });

  test('camera-orientation: 実効回転を書き戻すと、そのまま読み返せる', () => {
    const o = orientation();
    o.beginAttitudeFollow(qFromAxisAngle(norm(v3(1, 1, 0)), 1.3), POLAR);
    const target = rotationFromEuler({ yaw: -1.4, pitch: 0.8, roll: 2.0 }, POLAR);
    o.store(target);
    assert.ok(sameOrientation(o.effective(), target));
  });

  test('camera-orientation: 追従へ戻すとき、追従していなければ基準の姿勢を持ち越さない', () => {
    const o = orientation();
    o.beginAttitudeFollow(qFromAxisAngle(v3(0, 1, 0), 1.0), POLAR);
    o.endAttitudeFollow(POLAR);
    const absolute = o.effective();
    // 追従していない状態から追従へ戻すと、姿勢は次の refreshAttitude まで掛からない。
    o.restoreFollow(true);
    assert.ok(sameOrientation(o.effective(), absolute));
  });

  test('camera-orientation: 姿勢追従中はオイラー経路を使わない', () => {
    const o = orientation('euler');
    assert.equal(o.usesEuler, true);
    o.beginAttitudeFollow(qFromAxisAngle(v3(0, 1, 0), 1.0), POLAR);
    assert.equal(o.usesEuler, false);
  });

  test('camera-orientation: オイラー入力の往復は元の向きへ戻る', () => {
    const o = orientation('euler');
    const before = o.effective();
    o.turn(0.3, -0.2, 0.1, POLAR);
    o.turn(-0.3, 0.2, -0.1, POLAR);
    assert.ok(sameOrientation(o.effective(), before));
  });

  test('camera-orientation: 入力が無ければドラッグは向きを変えない', () => {
    const o = orientation('quaternion');
    const before = o.effective();
    assert.ok(sameOrientation(o.turnByDrag(0, 0, 0, 0, 0), before));
  });

  test('camera-orientation: 逆向きのドラッグは元の向きへ戻す', () => {
    // 同じ軸まわりの回転になるよう、往路と復路を1操作ずつに分ける。
    for (const [dr, du, roll, ky, kp] of [
      [0.1, 0, 0, 0, 0], [0, 0.1, 0, 0, 0], [0, 0, 0.1, 0, 0], [0, 0, 0, 0.1, 0], [0, 0, 0, 0, 0.1],
    ]) {
      const o = orientation('quaternion');
      const before = o.effective();
      o.turnByDrag(dr!, du!, roll!, ky!, kp!);
      o.turnByDrag(-dr!, -du!, -roll!, -ky!, -kp!);
      assert.ok(sameOrientation(o.effective(), before), `dr=${dr} du=${du} roll=${roll} ky=${ky} kp=${kp}`);
    }
  });

  test('camera-orientation: ロールは視線軸まわりなので、前方向を動かさない', () => {
    const o = orientation('quaternion');
    const before = qRotate(o.effective(), LOCAL_FORWARD);
    o.turnByDrag(0, 0, 0.5, 0, 0);
    assert.ok(len(sub(qRotate(o.effective(), LOCAL_FORWARD), before)) < 1e-9);
  });

  test('camera-orientation: 追従中のドラッグは、対象の姿勢を保ったまま視点だけ回す', () => {
    const o = orientation('quaternion');
    const attitude = qFromAxisAngle(norm(v3(1, 0, 1)), 0.8);
    o.beginAttitudeFollow(attitude, POLAR);
    const before = o.effective();
    const turned = o.turnByDrag(0.2, 0, 0, 0, 0);
    // 実効回転は回り、書き戻した生の値から読み返しても同じ向きになる。
    assert.ok(!sameOrientation(turned, before));
    assert.ok(sameOrientation(o.effective(), turned));
  });
}
