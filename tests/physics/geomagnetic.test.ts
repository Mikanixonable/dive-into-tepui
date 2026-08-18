// geomagnetic.ts の回帰テスト。双極子近似の大きさが地表の実測値の範囲に入ることと、
// 磁気トルカが原理的に出せない方向を出さないことを確かめる。
import * as assert from 'node:assert/strict';
import { test } from './harness';
import {
  GEOMAGNETIC_EQUATOR_FIELD,
  GEOMAGNETIC_POLE,
  GEOMAGNETIC_TILT,
  geomagneticField,
  magneticTorque,
} from '../../src/physics/geomagnetic';
import { R_EARTH } from '../../src/physics/solar-system';
import { dot, len, norm, scale, v3 } from '../../src/physics/vec3';

export function register(): void {
  test('geomagnetic: the surface field at the equator lies in the measured 25-65 uT band', () => {
    const b = len(geomagneticField(v3(R_EARTH, 0, 0)));
    assert.ok(b > 25e-6 && b < 65e-6, `equatorial surface field: ${b * 1e6} uT`);
  });

  test('geomagnetic: the surface field over the magnetic pole is twice the equatorial one', () => {
    const b = len(geomagneticField(scale(GEOMAGNETIC_POLE, R_EARTH)));
    assert.ok(b > 25e-6 && b < 65e-6, `polar surface field: ${b * 1e6} uT`);
    assert.ok(Math.abs(b / GEOMAGNETIC_EQUATOR_FIELD - 2) < 1e-9, `pole/equator ratio: ${b / GEOMAGNETIC_EQUATOR_FIELD}`);
  });

  test('geomagnetic: the field points into the ground at the northern magnetic pole', () => {
    const b = geomagneticField(scale(GEOMAGNETIC_POLE, R_EARTH));
    assert.ok(dot(b, GEOMAGNETIC_POLE) < 0, 'the field should point downward at the north magnetic pole');
  });

  test('geomagnetic: the field falls off with the cube of the distance', () => {
    const near = len(geomagneticField(v3(R_EARTH, 0, 0)));
    const far = len(geomagneticField(v3(2 * R_EARTH, 0, 0)));
    assert.ok(Math.abs(near / far - 8) < 1e-9, `ratio should be 8: ${near / far}`);
  });

  test('geomagnetic: near the moon the field is hundreds of thousands of times weaker than at the surface', () => {
    // 3.84e8 m はおよそ 60 地球半径。距離の3乗で 2e5 倍以上弱まり、磁気トルカは実質使えない。
    const b = len(geomagneticField(v3(3.84e8, 0, 0)));
    assert.ok(b < 1e-9, `lunar-distance field: ${b} T`);
  });

  test('geomagnetic: the dipole axis is tilted 11 degrees from the rotation axis', () => {
    const tilt = Math.acos(dot(norm(GEOMAGNETIC_POLE), v3(0, 1, 0)));
    assert.ok(Math.abs(tilt - GEOMAGNETIC_TILT) < 1e-12, `tilt: ${(tilt * 180) / Math.PI} deg`);
    assert.ok(Math.abs(GEOMAGNETIC_TILT - (11 * Math.PI) / 180) < 1e-12);
  });

  test('geomagnetic: the tilt makes the field over the geographic pole leave the radial direction', () => {
    // 傾きが 0 なら地理極の真上で磁場は動径方向に平行になる。11 度の傾きはその平行を崩す。
    const b = norm(geomagneticField(v3(0, R_EARTH, 0)));
    const offRadial = Math.acos(Math.abs(dot(b, v3(0, 1, 0))));
    assert.ok(offRadial > 0.05, `the field over the geographic pole should tilt off the radial: ${offRadial} rad`);
  });

  test('geomagnetic: the torque of a known moment and field points the way m x B does', () => {
    // +Z のモーメントを +X の磁場に置くと、m × B は +Y を向く。外積の順序と符号はここで決まる。
    const tq = magneticTorque(v3(0, 0, 1), v3(1, 0, 0));
    assert.ok(Math.abs(tq.x) < 1e-15 && Math.abs(tq.z) < 1e-15, `torque should lie along +Y: ${tq.x}, ${tq.z}`);
    assert.ok(Math.abs(tq.y - 1) < 1e-15, `torque should be +1 about Y: ${tq.y}`);
  });

  test('geomagnetic: the magnetic torque is perpendicular to the field', () => {
    const b = geomagneticField(v3(4e6, 5e6, -1e6));
    const tq = magneticTorque(v3(60, -20, 35), b);
    assert.ok(Math.abs(dot(norm(tq), norm(b))) < 1e-12, 'torque should be perpendicular to B');
  });

  test('geomagnetic: a moment parallel to the field produces no torque', () => {
    const b = geomagneticField(v3(4e6, 5e6, -1e6));
    const moment = scale(b, 1e9);
    const tq = len(magneticTorque(moment, b));
    assert.ok(tq < 1e-12 * len(moment) * len(b), `a moment along B can produce no torque: ${tq}`);
  });
}
