// body-orientation.ts の回帰テスト。自転軸を軌道面法線と取り違えると月の J2 摂動の向きが
// 6.7° ずれるが、加速度の大きさは変わらないので値の検査だけでは捕まらない。
import * as assert from 'node:assert/strict';
import { test } from './harness';
import { cassiniSpinAxis, principalLongAxis } from '../../src/physics/body-orientation';
import { ECL_POLE_ECI } from '../../src/physics/ecliptic';
import { Ephemeris } from '../../src/physics/ephemeris';
import { MOON_OBLIQUITY } from '../../src/physics/solar-system';
import { Vec3, cross, dot, len, norm, sub, v3 } from '../../src/physics/vec3';

const MOON_ORBIT_INC = (5.145 * Math.PI) / 180;
const R2D = 180 / Math.PI;

function angleBetween(a: Vec3, b: Vec3): number {
  return Math.acos(Math.min(1, Math.max(-1, dot(norm(a), norm(b)))));
}

export function register(): void {
  test('body-orientation: cassiniSpinAxis tilts the pole by the obliquity, away from the orbit normal', () => {
    const eclPole = v3(0, 0, 1);
    const orbitNormal = norm(v3(Math.sin(MOON_ORBIT_INC), 0, Math.cos(MOON_ORBIT_INC)));
    const spin = cassiniSpinAxis(eclPole, orbitNormal, MOON_OBLIQUITY);

    assert.ok(Math.abs(len(spin) - 1) < 1e-12, 'the spin axis should be a unit vector');
    const fromEcl = angleBetween(spin, eclPole);
    assert.ok(Math.abs(fromEcl - MOON_OBLIQUITY) < 1e-9, `obliquity from the ecliptic pole: ${fromEcl * R2D} deg`);

    // 黄道極を挟んで軌道面法線の反対側にあるので、両者の離角は傾斜角と赤道傾斜の和になる。
    const fromNormal = angleBetween(spin, orbitNormal);
    const expected = MOON_ORBIT_INC + MOON_OBLIQUITY;
    assert.ok(Math.abs(fromNormal - expected) < 1e-9, `spin-to-orbit-normal angle: ${fromNormal * R2D} deg (expected ${expected * R2D})`);
  });

  test('body-orientation: the spin axis, the orbit normal and the ecliptic pole stay coplanar', () => {
    const eclPole = v3(0, 0, 1);
    const orbitNormal = norm(v3(Math.sin(MOON_ORBIT_INC), 0.3 * Math.sin(MOON_ORBIT_INC), Math.cos(MOON_ORBIT_INC)));
    const spin = cassiniSpinAxis(eclPole, orbitNormal, MOON_OBLIQUITY);
    const tripleProduct = dot(spin, cross(eclPole, orbitNormal));
    assert.ok(Math.abs(tripleProduct) < 1e-12, `the three axes should be coplanar: triple product ${tripleProduct}`);
  });

  test('body-orientation: principalLongAxis returns a unit vector perpendicular to the pole', () => {
    const pole = norm(v3(0.1, 0.9, -0.2));
    const longAxis = principalLongAxis(pole, v3(1, 0.5, 0.3));
    assert.ok(Math.abs(len(longAxis) - 1) < 1e-12, 'the long axis should be a unit vector');
    assert.ok(Math.abs(dot(longAxis, pole)) < 1e-12, 'the long axis should be perpendicular to the pole');
  });

  test('ephemeris: the moon keeps a 1.543deg equatorial tilt to the ecliptic across a node period', () => {
    const ephemeris = new Ephemeris({ moon: 0.7 });
    const nodePeriod = 18.612958 * 365.25 * 86400;
    for (let i = 0; i <= 12; i++) {
      const t = (i / 12) * nodePeriod;
      const moon = ephemeris.attractorsAt(t).find((b) => b.id === 'moon')!;
      const tilt = angleBetween(moon.degree2!.pole, ECL_POLE_ECI) * R2D;
      assert.ok(Math.abs(tilt - 1.543) < 0.01, `lunar obliquity at t=${t}: ${tilt} deg`);
    }
  });

  test('ephemeris: the moon spin axis sits 6.688deg from its own orbit normal, opposite the ecliptic pole', () => {
    // 自転軸を軌道面法線で代用していれば、この離角は 0 になる。
    const ephemeris = new Ephemeris({ moon: 0.2 });
    for (const t of [0, 5e7, 2e8]) {
      const moon = ephemeris.attractorsAt(t).find((b) => b.id === 'moon')!;
      const normal = ephemeris.orbitNormalAt('moon', t);
      const sep = angleBetween(moon.degree2!.pole, normal) * R2D;
      assert.ok(Math.abs(sep - 6.688) < 0.02, `spin-axis to orbit-normal separation at t=${t}: ${sep} deg`);
    }
  });

  test('ephemeris: the moon long axis follows the mean longitude, not the instantaneous earth direction', () => {
    // 同期回転は一様なので本初子午線は平均黄経を追う。真方向で代用すると中心差ぶん
    // (離心率 0.0549 に対して最大 6.3°)ずれ、C22 の位相が狂う。
    const ephemeris = new Ephemeris({ moon: 0 });
    let maxSep = 0;
    for (let i = 0; i <= 40; i++) {
      const t = (i / 40) * 27.321661 * 86400;
      const moon = ephemeris.attractorsAt(t).find((b) => b.id === 'moon')!;
      const longAxis = moon.degree2!.tesseral!.longAxis;
      assert.ok(Math.abs(dot(longAxis, moon.degree2!.pole)) < 1e-12, 'the long axis should stay perpendicular to the pole');

      // 実位置方向との離角。0 に張り付いていたら真方向で組んでしまっている。
      const toMoon = norm(sub(moon.state.r, v3(0, 0, 0)));
      const sep = Math.min(angleBetween(longAxis, toMoon), angleBetween(longAxis, sub(v3(0, 0, 0), toMoon))) * R2D;
      maxSep = Math.max(maxSep, sep);
    }
    // 離角は中心差(最大 6.29°)に周期摂動項(出差 1.274° ほか)と、自転軸まわりへ射影する
    // ぶんの面外成分が重なる。理論上の上界が閉じた形にならないので実測値を緩く固定する。
    assert.ok(maxSep > 3, `the long axis should visibly lead/lag the true direction: max separation ${maxSep} deg`);
    assert.ok(maxSep < 13, `the separation should stay within the equation of center plus periodic terms: ${maxSep} deg`);
  });
}
