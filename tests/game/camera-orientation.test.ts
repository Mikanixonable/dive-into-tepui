// CameraOrientation が担保する不変量のテスト。期待値の正本は「切替で視点が跳ばないこと」
// 「仰角が真上・真下を越えないこと」という仕様(SPEC/CAMERA.md「視点の操作」「基準フレーム」)で、
// コードの現状ではない。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { CameraOrientation } from '../../src/game/viewer/camera-orientation';
import { POLAR_PITCH_LIMIT, rotationFromEuler } from '../../src/math/polar-euler';
import { LOCAL_FORWARD, LOCAL_UP, Quat, qFromAxisAngle, qMul, qRotate } from '../../src/math/quat';
import { dot, len, norm, sub, v3 } from '../../src/math/vec3';

const POLAR = norm(v3(0.2, 0.9, -0.1));

// 実効回転が同じ向きを表すか。局所基底の写り先で比べる(q と -q を同一視するため)。
function sameOrientation(a: Quat, b: Quat, tol = 1e-8): boolean {
  return len(sub(qRotate(a, LOCAL_FORWARD), qRotate(b, LOCAL_FORWARD))) < tol
    && len(sub(qRotate(a, LOCAL_UP), qRotate(b, LOCAL_UP))) < tol;
}

// 極軸 POLAR を天頂としたときの、視線の仰角 [rad]。
function pitchOf(rotation: Quat): number {
  return Math.asin(Math.max(-1, Math.min(1, dot(qRotate(rotation, LOCAL_FORWARD), POLAR))));
}

function orientation(mode: 'euler' | 'quaternion' = 'euler'): CameraOrientation {
  const q = rotationFromEuler({ yaw: 0.6, pitch: 0.3, roll: -0.2 }, POLAR);
  return new CameraOrientation(q, mode, false);
}

export function register(): void {
  test('camera-orientation: 回し方を切り替えても向きは変わらない', () => {
    const o = orientation('euler');
    const before = o.effective();
    o.setRotationMode('quaternion');
    assert.ok(sameOrientation(o.effective(), before));
    o.setRotationMode('euler');
    assert.ok(sameOrientation(o.effective(), before));
  });

  test('camera-orientation: 入力が無ければオイラー操作は向きを変えない', () => {
    const o = orientation();
    const before = o.effective();
    o.turn(0, 0, 0, POLAR);
    assert.ok(sameOrientation(o.effective(), before));
  });

  test('camera-orientation: オイラー操作の仰角は真上を越えない', () => {
    const o = orientation();
    // 真上へ押し続けても極軸の手前で止まり、裏返らない。
    for (let i = 0; i < 10; i++) o.turn(0, 1.0, 0, POLAR);
    const pitch = pitchOf(o.effective());
    assert.ok(pitch > 0 && pitch <= POLAR_PITCH_LIMIT + 1e-9, `pitch=${pitch}`);
    for (let i = 0; i < 20; i++) o.turn(0, -1.0, 0, POLAR);
    const down = pitchOf(o.effective());
    assert.ok(down < 0 && down >= -POLAR_PITCH_LIMIT - 1e-9, `pitch=${down}`);
  });

  test('camera-orientation: 姿勢追従の開始と解除で視点は跳ばない', () => {
    const o = orientation();
    const before = o.effective();
    const attitude = qFromAxisAngle(norm(v3(1, 2, 3)), 0.9);
    o.beginAttitudeFollow(attitude);
    assert.equal(o.followingAttitude, true);
    assert.ok(sameOrientation(o.effective(), before), '追従開始で跳んだ');
    o.endAttitudeFollow();
    assert.equal(o.followingAttitude, false);
    assert.ok(sameOrientation(o.effective(), before), '追従解除で跳んだ');
  });

  test('camera-orientation: 追従中は対象の姿勢ぶんだけ実効回転が回る', () => {
    const o = orientation();
    const before = o.effective();
    o.beginAttitudeFollow(qFromAxisAngle(v3(0, 1, 0), Math.PI / 2));
    o.refreshAttitude(qFromAxisAngle(v3(0, 1, 0), Math.PI));
    // 姿勢が 90° 進んだぶんだけ、実効回転も同じ軸まわりに回る。
    const advanced = qMul(qFromAxisAngle(v3(0, 1, 0), Math.PI / 2), before);
    assert.ok(sameOrientation(o.effective(), advanced));
  });

  test('camera-orientation: 姿勢が引けないフレームは直前の姿勢を保つ', () => {
    const o = orientation();
    const attitude = qFromAxisAngle(v3(0, 0, 1), 0.4);
    o.beginAttitudeFollow(attitude);
    const before = o.effective();
    o.refreshAttitude(null);
    assert.ok(sameOrientation(o.effective(), before));
  });

  test('camera-orientation: 実効回転を書き戻すと、そのまま読み返せる', () => {
    const o = orientation();
    o.beginAttitudeFollow(qFromAxisAngle(norm(v3(1, 1, 0)), 1.3));
    const target = rotationFromEuler({ yaw: -1.4, pitch: 0.8, roll: 2.0 }, POLAR);
    o.setEffective(target);
    assert.ok(sameOrientation(o.effective(), target));
  });

  test('camera-orientation: 姿勢追従中もオイラー経路を使う', () => {
    const o = orientation('euler');
    assert.equal(o.usesEuler, true);
    o.beginAttitudeFollow(qFromAxisAngle(v3(0, 1, 0), 1.0));
    assert.equal(o.usesEuler, true);
    const before = o.effective();
    o.turn(0.2, 0, 0, LOCAL_UP);
    assert.ok(!sameOrientation(o.effective(), before));
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
    o.turnByDrag(0, 0, 0, 0, 0);
    assert.ok(sameOrientation(o.effective(), before));
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
    o.beginAttitudeFollow(qFromAxisAngle(norm(v3(1, 0, 1)), 0.8));
    const before = o.effective();
    o.turnByDrag(0.2, 0, 0, 0, 0);
    const turned = o.effective();
    assert.ok(!sameOrientation(turned, before));
    assert.equal(o.followingAttitude, true);
    // 同じ姿勢を引き直しても、回した向きはそのまま読み返せる。
    o.refreshAttitude(qFromAxisAngle(norm(v3(1, 0, 1)), 0.8));
    assert.ok(sameOrientation(o.effective(), turned));
  });
}
