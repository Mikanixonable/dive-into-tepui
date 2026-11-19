// 被弾の揺れ(SPEC CAMERA.md「6. 被弾の揺れ」)の回帰テスト。kick で立った揺れが
// 0.3 秒で収まること、向きが毎回振られること、視点への掛け方が位置を動かさないことを確かめる。
import * as assert from 'node:assert/strict';
import { HitShake, shakenViewpoint } from '../../src/game/camera/hit-shake';
import { v3, len, sub } from '../../src/math/vec3';
import { test } from '../harness';

export function register(): void {
  test('hit shake: offset decays to null after 0.3 s and starts strongest', () => {
    const shake = new HitShake();
    shake.rand = () => 0.25;
    shake.kick();
    const first = shake.offset(0.016);
    assert.ok(first !== null);
    const firstMag = Math.abs(first.yaw) + Math.abs(first.pitch) + Math.abs(first.roll);
    const later = shake.offset(0.1);
    assert.ok(later !== null);
    const laterMag = Math.abs(later.yaw) + Math.abs(later.pitch) + Math.abs(later.roll);
    assert.ok(laterMag < firstMag, '揺れが収束へ向かっていない');
    assert.equal(shake.offset(0.3), null);
    assert.equal(shake.offset(0.016), null);
  });

  test('hit shake: kick picks a new direction each time', () => {
    const shake = new HitShake();
    let v = 0;
    shake.rand = () => (v += 0.37) % 1;
    shake.kick();
    const a = shake.offset(0.016);
    shake.kick();
    const b = shake.offset(0.016);
    assert.notDeepEqual(a, b);
  });

  test('hit shake: shaken viewpoint keeps position and look distance', () => {
    const view = {
      position: v3(1, 2, 3), lookTarget: v3(1, 2, 103), up: v3(0, 1, 0),
      fovDeg: 55, aspect: 1.5,
    };
    const shaken = shakenViewpoint(view, { yaw: 0.01, pitch: -0.005, roll: 0.008 }, 1);
    assert.deepEqual(shaken.position, view.position);
    assert.ok(
      Math.abs(len(sub(shaken.lookTarget, shaken.position)) - 100) < 1e-9,
      '注視点までの距離が変わった',
    );
    // amp 0 なら元と同じ向き。
    const same = shakenViewpoint(view, { yaw: 1, pitch: 1, roll: 1 }, 0);
    assert.ok(len(sub(same.lookTarget, view.lookTarget)) < 1e-9);
  });
}
