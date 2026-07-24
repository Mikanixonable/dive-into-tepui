// frame.ts の回帰テスト: 慣性系⇄回転系の OrbitState/Vec3 順逆変換
// （恒等・往復・既知回転角・速度の有限差分検証・bake+un-bake 合成）。
import * as assert from 'node:assert/strict';
import { test } from './harness';
import { Ephemeris, SUN_ROTATING_POLE } from '../../src/physics/ephemeris';
import { toFramePos, toFrameState, toInertialPos, toInertialState } from '../../src/physics/frame';
import { OrbitState, orbitState } from '../../src/physics/orbital';
import { Vec3, addScaled, len, rotateAxis, scale, sub, v3 } from '../../src/physics/vec3';

const YEAR = 365.25636 * 86400;

function close(a: Vec3, b: Vec3, tol = 1e-6): boolean {
  return len(sub(a, b)) <= tol * Math.max(1, len(b));
}
function closeState(a: OrbitState, b: OrbitState, tol = 1e-6): boolean {
  return close(a.r, b.r, tol) && close(a.v, b.v, tol);
}

export function register(): void {
  const eph = new Ephemeris(0); // sunPhase0=0 で決定的
  const state = (): OrbitState => orbitState(v3(6.8e6, 5e5, 3e6), v3(-1200, 300, 7400));

  test('frame: inertial は順逆とも恒等（state）', () => {
    const s = state();
    const t = 12345;
    assert.ok(closeState(toInertialState('inertial', t, toFrameState('inertial', t, s, eph), eph), s));
  });

  test('frame: sunRotating の往復は元に戻る（state・同一時刻）', () => {
    const s = state();
    const t = YEAR / 4; // sunAz != 0
    const back = toInertialState('sunRotating', t, toFrameState('sunRotating', t, s, eph), eph);
    assert.ok(closeState(back, s), `round trip: ${JSON.stringify(back)} vs ${JSON.stringify(s)}`);
  });

  test('frame: sunRotating の位置は −sunAz(t) の回転（state・pos が一致）', () => {
    const s = state();
    const t = YEAR / 3;
    const expected = rotateAxis(s.r, SUN_ROTATING_POLE, -eph.sunAzimuthAt(t));
    assert.ok(close(toFrameState('sunRotating', t, s, eph).r, expected));
    const p = toFramePos('sunRotating', t, s.r, eph);
    assert.ok(close(v3(p.x, p.y, p.z), expected));
  });

  test('frame: pos 変換の往復は元に戻る（sunRotating・同一時刻）', () => {
    const s = state();
    const t = YEAR / 6;
    const back = toInertialPos('sunRotating', t, toFramePos('sunRotating', t, s.r, eph), eph);
    assert.ok(close(back, s.r));
  });

  test('frame: 回転系速度は回転系位置の時間微分に一致（有限差分, ω×r 項の検証）', () => {
    const s = state();
    const t0 = YEAR / 4;
    const dt = 1;
    // 慣性系で等速直線運動する点の、回転系位置を中心差分して速度を近似する
    const rRelAt = (t: number): Vec3 =>
      toFrameState('sunRotating', t, orbitState(addScaled(s.r, s.v, t - t0), s.v), eph).r;
    const vFd = scale(sub(rRelAt(t0 + dt), rRelAt(t0 - dt)), 1 / (2 * dt));
    const vAnalytic = toFrameState('sunRotating', t0, s, eph).v;
    // ω×r 項(~1.4 m/s)を落とすと数 m/s ずれる。有限差分自体は 1e-3 m/s より高精度。
    assert.ok(len(sub(vFd, vAnalytic)) < 1e-2, `v mismatch: ${JSON.stringify(vFd)} vs ${JSON.stringify(vAnalytic)}`);
  });

  test('frame: bake(t) + un-bake(T) の位置合成は 回転 sunAz(T)−sunAz(t)（旧挙動の正味変換）', () => {
    const s = state();
    const tSample = YEAR / 5;
    const tNow = YEAR / 4;
    const net = toInertialState('sunRotating', tNow, toFrameState('sunRotating', tSample, s, eph), eph);
    const expected = rotateAxis(s.r, SUN_ROTATING_POLE, eph.sunAzimuthAt(tNow) - eph.sunAzimuthAt(tSample));
    assert.ok(close(net.r, expected), `net: ${JSON.stringify(net.r)} vs ${JSON.stringify(expected)}`);
  });
}
