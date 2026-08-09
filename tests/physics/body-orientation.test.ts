// body-orientation.ts の回帰テスト。自転軸を軌道面法線と取り違えると月の J2 摂動の向きが
// 6.7° ずれるが、加速度の大きさは変わらないので値の検査だけでは捕まらない。
import * as assert from 'node:assert/strict';
import { test } from './harness';
import { cassiniSpinAxis, meridianDirection, orthogonalizedTo } from '../../src/physics/body-orientation';
import { ECL_POLE_ECI, raDecToEci } from '../../src/physics/ecliptic';
import { Ephemeris, EPOCH_T_OFFSET } from '../../src/physics/ephemeris';
import { AttractorId } from '../../src/physics/attractor';
import { bodyDef, MOON_OBLIQUITY, SOLAR_SYSTEM } from '../../src/physics/solar-system';
import { Vec3, cross, dot, len, norm, scale, sub, v3 } from '../../src/physics/vec3';

const MOON_ORBIT_INC = (5.145 * Math.PI) / 180;
const R2D = 180 / Math.PI;

// 自転軸を持つ天体(地球は ECI の極軸そのもの、月はカッシーニ状態、残りは IAU の一次式)。
const POLE_BODIES: readonly AttractorId[] = ['earth', 'moon', 'mercury', 'venus', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune'];

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

  test('body-orientation: orthogonalizedTo returns a unit vector perpendicular to the pole', () => {
    const pole = norm(v3(0.1, 0.9, -0.2));
    const longAxis = orthogonalizedTo(pole, v3(1, 0.5, 0.3));
    assert.ok(Math.abs(len(longAxis) - 1) < 1e-12, 'the long axis should be a unit vector');
    assert.ok(Math.abs(dot(longAxis, pole)) < 1e-12, 'the long axis should be perpendicular to the pole');
  });

  test('ephemeris: the moon keeps a 1.543deg equatorial tilt to the ecliptic across a node period', () => {
    const ephemeris = new Ephemeris(SOLAR_SYSTEM, 'earth', EPOCH_T_OFFSET, { moon: 0.7 });
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
    const ephemeris = new Ephemeris(SOLAR_SYSTEM, 'earth', EPOCH_T_OFFSET, { moon: 0.2 });
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
    const ephemeris = new Ephemeris(SOLAR_SYSTEM, 'earth', EPOCH_T_OFFSET, { moon: 0 });
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

  test('ecliptic: raDecToEci maps the pole and the vernal equinox onto the ECI axes', () => {
    const north = raDecToEci(123, 90);
    assert.ok(len(sub(north, v3(0, 1, 0))) < 1e-12, 'dec=90 should be the ECI north pole');
    const vernal = raDecToEci(0, 0);
    assert.ok(len(sub(vernal, v3(1, 0, 0))) < 1e-12, 'ra=dec=0 should be the vernal equinox');

    // 成分ごとの検算: ECI = (cosδcosα, sinδ, −cosδsinα)。
    const ra = 137.5, dec = -21.25;
    const cd = Math.cos((dec * Math.PI) / 180);
    const expected = v3(cd * Math.cos((ra * Math.PI) / 180), Math.sin((dec * Math.PI) / 180), -cd * Math.sin((ra * Math.PI) / 180));
    assert.ok(len(sub(raDecToEci(ra, dec), expected)) < 1e-12, 'component-wise disagreement');

    // 黄道北極の赤経・赤緯から組んだ方向は、黄道基底から組んだ ECL_POLE_ECI と一致する。
    const eclPole = raDecToEci(270, 90 - 23.439291);
    assert.ok(len(sub(eclPole, ECL_POLE_ECI)) < 1e-9, 'the ecliptic pole should agree with the ecliptic basis');
  });

  test('ephemeris: every registered pole is a unit vector', () => {
    const ephemeris = new Ephemeris(SOLAR_SYSTEM, 'earth', EPOCH_T_OFFSET, {});
    for (const id of POLE_BODIES) {
      const orientation = ephemeris.poleAt(id, 3.2e7);
      assert.ok(orientation !== null, `${id} should have a pole`);
      assert.ok(Math.abs(len(orientation!.axis) - 1) < 1e-12, `${id} pole length: ${len(orientation!.axis)}`);
    }
  });

  test('ephemeris: the IAU poles reproduce the published axial tilts', () => {
    // 赤道傾斜角は自転(角速度)方向と軌道面法線の離角。自転位相 W の変化率が負の天体は
    // 角速度が pole の逆を向くので、天王星は 82.2° ではなく 97.8° になる。
    const ephemeris = new Ephemeris(SOLAR_SYSTEM, 'earth', EPOCH_T_OFFSET, {});
    for (const [id, expected] of [['saturn', 26.73], ['uranus', 97.77], ['mars', 23.92]] as const) {
      const { axis } = ephemeris.poleAt(id, 0)!;
      const pole = (bodyDef(SOLAR_SYSTEM, id) as { pole?: { kind: string; wRateDegPerDay?: number } }).pole;
      const spinDir = pole?.kind === 'iau' && (pole.wRateDegPerDay ?? 0) < 0 ? scale(axis, -1) : axis;
      const tilt = angleBetween(spinDir, ephemeris.orbitNormalAt(id, 0)) * R2D;
      assert.ok(Math.abs(tilt - expected) < 0.2, `${id} axial tilt: ${tilt} deg (expected ${expected})`);
    }
  });

  test('ephemeris: the ring-bearing poles reproduce the published ring-plane tilts', () => {
    // 環の面は赤道面なので、その法線は自転軸そのもの。黄道極からの離角は土星 28.05°
    // (IAU の α0=40.589°/δ0=83.537° から出る値。軌道面法線基準の赤道傾斜角 26.73° とは別)、
    // 天王星は横倒しで 82.28°(面は向きを持たないので、逆行自転の 97.72° と同じ傾き)。
    const ephemeris = new Ephemeris(SOLAR_SYSTEM, 'earth', EPOCH_T_OFFSET, {});
    for (const [id, expected] of [['saturn', 28.05], ['uranus', 82.28]] as const) {
      const tilt = angleBetween(ephemeris.poleAt(id, 0)!.axis, ECL_POLE_ECI) * R2D;
      assert.ok(Math.abs(tilt - expected) < 0.2, `${id} ring-plane tilt: ${tilt} deg (expected ${expected})`);
    }
  });

  test('ephemeris: the moon pole agrees with the cassini axis carried by its gravity field', () => {
    const ephemeris = new Ephemeris(SOLAR_SYSTEM, 'earth', EPOCH_T_OFFSET, { moon: 0.4 });
    for (const t of [0, 5e6, 2e8]) {
      const gravityPole = ephemeris.attractorsAt(t).find((b) => b.id === 'moon')!.degree2!.pole;
      assert.ok(len(sub(ephemeris.poleAt('moon', t)!.axis, gravityPole)) < 1e-12, `moon pole disagreement at t=${t}`);
    }
  });

  test('ephemeris: the moon prime meridian keeps facing the earth', () => {
    // 潮汐固定。秤動(中心差 6.3° + 出差ほかの周期摂動 + 面外成分)のぶんだけ離れる。上界が
    // 閉じた形にならないので実測値を緩く固定する — 固定が壊れれば1公転で 180° まで開く。
    const ephemeris = new Ephemeris(SOLAR_SYSTEM, 'earth', EPOCH_T_OFFSET, { moon: 0.3 });
    let maxSep = 0;
    for (let i = 0; i <= 40; i++) {
      const t = (i / 40) * 27.321661 * 86400;
      const { axis, spinAngle } = ephemeris.poleAt('moon', t)!;
      const toEarth = norm(scale(ephemeris.positionOf('moon', t), -1));
      maxSep = Math.max(maxSep, angleBetween(meridianDirection(axis, spinAngle), toEarth) * R2D);
    }
    assert.ok(maxSep < 13, `the near side should keep facing the earth: max separation ${maxSep} deg`);
  });
}
