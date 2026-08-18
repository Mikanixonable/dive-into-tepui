// gravity-gradient.ts の回帰テスト。慣性主軸の分布だけで決まるトルクなので、
// 対称な機体でちょうど消えること、安定平衡から外すと戻る向きに出ることを主に確かめる。
import * as assert from 'node:assert/strict';
import { test } from './harness';
import { gravityGradientTorque } from '../../src/physics/gravity-gradient';
import { qFromAxisAngle } from '../../src/physics/attitude';
import { MU_EARTH } from '../../src/physics/solar-system';
import { len, v3 } from '../../src/physics/vec3';

const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };
const LEO_R = 6.8e6; // 高度約 420km

// 長軸を機体 +X に持つ細長い機体(最小慣性主軸が X)。
const SLENDER = v3(20, 320, 320);

export function register(): void {
  test('gravity-gradient: a spherically symmetric inertia gives exactly zero torque', () => {
    const tq = gravityGradientTorque(v3(LEO_R, 2e6, 3e6), MU_EARTH, v3(500, 500, 500), IDENTITY);
    assert.ok(len(tq) < 1e-18, `torque should vanish for I = kE: ${len(tq)}`);
  });

  test('gravity-gradient: a principal axis aligned with the radial direction gives zero torque', () => {
    for (const nadir of [v3(LEO_R, 0, 0), v3(0, LEO_R, 0), v3(0, 0, LEO_R)]) {
      const tq = gravityGradientTorque(nadir, MU_EARTH, SLENDER, IDENTITY);
      assert.ok(len(tq) < 1e-15, `torque should vanish along a principal axis: ${len(tq)}`);
    }
  });

  test('gravity-gradient: tilting off the stable equilibrium gives a restoring torque', () => {
    // 最小慣性主軸(+X)を天底からわずかに外すと、戻す向き(+Z まわり)のトルクが出る。
    const theta = 0.02;
    const nadir = v3(LEO_R * Math.cos(theta), LEO_R * Math.sin(theta), 0);
    const tq = gravityGradientTorque(nadir, MU_EARTH, SLENDER, IDENTITY);
    assert.ok(tq.z > 0, `restoring torque should be positive about +Z: ${tq.z}`);
    // 逆側へ外せば符号も逆になる。
    const back = gravityGradientTorque(v3(LEO_R * Math.cos(theta), -LEO_R * Math.sin(theta), 0), MU_EARTH, SLENDER, IDENTITY);
    assert.ok(back.z < 0, `restoring torque should flip sign: ${back.z}`);
  });

  test('gravity-gradient: the maximum inertia axis at nadir is an unstable equilibrium', () => {
    // 最大慣性主軸(+Y)を天底へ向けた姿勢からずらすと、離れる向きのトルクが出る。
    const theta = 0.02;
    const nadir = v3(-LEO_R * Math.sin(theta), LEO_R * Math.cos(theta), 0);
    const tq = gravityGradientTorque(nadir, MU_EARTH, SLENDER, IDENTITY);
    assert.ok(tq.z < 0, `torque should push further away from the max-inertia equilibrium: ${tq.z}`);
  });

  test('gravity-gradient: the attitude quaternion rotates the nadir direction into the body frame', () => {
    // 天底を Z まわりに theta 回した姿勢は、機体を -theta 回したのと同じトルクを与える。
    const theta = 0.02;
    const tilted = gravityGradientTorque(
      v3(LEO_R, 0, 0), MU_EARTH, SLENDER, qFromAxisAngle(v3(0, 0, 1), -theta),
    );
    const rotated = gravityGradientTorque(
      v3(LEO_R * Math.cos(theta), LEO_R * Math.sin(theta), 0), MU_EARTH, SLENDER, IDENTITY,
    );
    assert.ok(Math.abs(tilted.z - rotated.z) < 1e-12, `${tilted.z} vs ${rotated.z}`);
  });

  test('gravity-gradient: the torque falls off with the cube of the distance', () => {
    const theta = 0.3;
    const dir = v3(Math.cos(theta), Math.sin(theta), 0);
    const near = len(gravityGradientTorque(v3(dir.x * LEO_R, dir.y * LEO_R, 0), MU_EARTH, SLENDER, IDENTITY));
    const far = len(gravityGradientTorque(v3(dir.x * 2 * LEO_R, dir.y * 2 * LEO_R, 0), MU_EARTH, SLENDER, IDENTITY));
    assert.ok(Math.abs(near / far - 8) < 1e-9, `ratio should be 8: ${near / far}`);
  });

  test('gravity-gradient: a slender satellite in LEO feels a torque of order 1e-4 N*m', () => {
    // 実機の重力傾斜トルクは 1e-5 〜 1e-3 N·m の範囲に収まる。
    const theta = Math.PI / 4; // 復元トルクが最大になる姿勢
    const nadir = v3(LEO_R * Math.cos(theta), LEO_R * Math.sin(theta), 0);
    const mag = len(gravityGradientTorque(nadir, MU_EARTH, SLENDER, IDENTITY));
    assert.ok(mag > 1e-5 && mag < 1e-3, `LEO gravity-gradient torque magnitude: ${mag} N*m`);
  });
}
