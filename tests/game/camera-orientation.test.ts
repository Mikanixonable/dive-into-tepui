// CameraOrientation が担保する不変量のテスト。期待値の正本は「二表現が同じ向きを指すこと」
// 「切替で視点が跳ばないこと」という仕様(SPEC/CONTROLS.md「基準フレーム」)で、コードの
// 現状ではない。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { CameraOrientation } from '../../src/game/camera/camera-orientation';
import { rotationFromEuler } from '../../src/math/polar-euler';
import { LOCAL_FORWARD, LOCAL_UP, Quat, qFromAxisAngle, qRotate } from '../../src/math/quat';
import { cross, dot, len, norm, scale, sub, v3 } from '../../src/math/vec3';

const POLAR = norm(v3(0.2, 0.9, -0.1));
const DRAG = 1e-5; // 1次の応答だけを見るための微小ドラッグ量 [rad]

// 実効回転が同じ向きを表すか。局所基底の写り先で比べる(q と -q を同一視するため)。
function sameOrientation(a: Quat, b: Quat, tol = 1e-8): boolean {
  return len(sub(qRotate(a, LOCAL_FORWARD), qRotate(b, LOCAL_FORWARD))) < tol
    && len(sub(qRotate(a, LOCAL_UP), qRotate(b, LOCAL_UP))) < tol;
}

function orientation(mode: 'euler' | 'quaternion' = 'euler'): CameraOrientation {
  const q = rotationFromEuler({ yaw: 0.6, pitch: 0.3, roll: -0.2 }, POLAR);
  return new CameraOrientation(q, POLAR, mode, null);
}

// 微小ドラッグに対するカメラ方向の変位を、画面の右軸・上軸の成分で返す。
// dragX/dragY は画面右・画面下を正とする画面上の変位。
function dragResponse(o: CameraOrientation, dragX: number, dragY: number, euler: boolean): [number, number] {
  const before = o.effective();
  const forward = qRotate(before, LOCAL_FORWARD);
  const up = qRotate(before, LOCAL_UP);
  const right = norm(cross(scale(forward, -1), up));
  if (euler) o.turn(dragX * DRAG, dragY * DRAG, 0, POLAR);
  else o.turnByDrag(dragX * DRAG, -dragY * DRAG, 0, 0, 0);
  const moved = sub(qRotate(o.effective(), LOCAL_FORWARD), forward);
  return [dot(moved, right) / DRAG, dot(moved, up) / DRAG];
}

// 2つの応答が同じ向きを指すか。大きさは問わない(不変条件は方向だけを要求する)。
function sameDirection(a: [number, number], b: [number, number], tol = 1e-4): boolean {
  const na = Math.hypot(...a);
  const nb = Math.hypot(...b);
  if (na < 1e-9 || nb < 1e-9) return false;
  return Math.abs((a[0] * b[1] - a[1] * b[0]) / (na * nb)) < tol && (a[0] * b[0] + a[1] * b[1]) > 0;
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
    assert.ok(!sameOrientation(o.stored, o.effective()), '追従中の生の値が相対値になっていない');
    assert.ok(sameOrientation(o.effective(), before), '追従開始で跳んだ');
    o.endAttitudeFollow(POLAR);
    assert.ok(sameOrientation(o.stored, o.effective()), '解除後の生の値が絶対値に戻っていない');
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

  // 追従の選択は保たれているのに姿勢がまだ引けていない状態(ロード直後)を、姿勢を持たない
  // まま生の値を絶対値として扱うことで表す。ここで視点が跳ぶとセーブ→リロードで一度だけ飛ぶ。
  test('camera-orientation: 姿勢が引けるまでは生の値がそのまま実効回転になる', () => {
    const o = orientation();
    o.clearAttitude();
    const absolute = o.effective();
    assert.ok(sameOrientation(absolute, o.stored), '姿勢が無いのに合成が掛かっている');
    // 初めて姿勢が引けた瞬間に生の値を相対値へ読み替えるので、実効回転は変わらない。
    o.refreshAttitude(qFromAxisAngle(v3(0, 1, 0), 1.0));
    assert.ok(sameOrientation(o.effective(), absolute), '姿勢の初回解決で跳んだ');
  });

  test('camera-orientation: オイラー入力の往復は元の向きへ戻る', () => {
    // ドラッグはロールの向きに合わせて分解されるので、ロールと同時に積むと往路と復路で分解が
    // 変わる。同じ分解になるよう、ロールだけ分けて往復させる(クォータニオン側と同じ制限)。
    for (const [dragX, dragY, roll] of [[0.3, 0, 0], [0, -0.2, 0], [0.3, -0.2, 0], [0, 0, 0.1]]) {
      const o = orientation('euler');
      const before = o.effective();
      o.turn(dragX!, dragY!, roll!, POLAR);
      o.turn(-dragX!, -dragY!, -roll!, POLAR);
      assert.ok(sameOrientation(o.effective(), before), `dragX=${dragX} dragY=${dragY} roll=${roll}`);
    }
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

  // 「ドラッグした向きへカメラが動く」は両方の回し方に共通の不変条件で、オイラー角のほうは
  // ロールと仰角で軸が傾くぶんを分解して打ち消さないと満たせない。
  test('camera-orientation: ドラッグの向きとカメラの動く向きが、回し方によらず一致する', () => {
    for (const pitch of [0, 0.3, 0.9, 1.4]) {
      for (const roll of [0, Math.PI / 4, Math.PI / 2, Math.PI]) {
        for (const [dragX, dragY] of [[1, 0], [0, 1], [1, 1], [-2, 1]]) {
          const q = rotationFromEuler({ yaw: 0.6, pitch, roll }, POLAR);
          const byEuler = dragResponse(new CameraOrientation(q, POLAR, 'euler', null), dragX, dragY, true);
          const byQuat = dragResponse(new CameraOrientation(q, POLAR, 'quaternion', null), dragX, dragY, false);
          assert.ok(sameDirection(byEuler, byQuat),
            `pitch=${pitch} roll=${roll} drag=(${dragX},${dragY}) euler=${byEuler} quaternion=${byQuat}`);
        }
      }
    }
  });

}
