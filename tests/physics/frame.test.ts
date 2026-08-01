// frame.ts の回帰テスト: 慣性系⇄回転系の OrbitState/Vec3 順逆変換
// （恒等・往復・既知回転角・速度の有限差分検証・bake+un-bake 合成）。
import * as assert from 'node:assert/strict';
import { test } from './harness';
import { Ephemeris, SUN_ROTATING_POLE, sunAzimuth } from '../../src/physics/ephemeris';
import { toFramePos, toFrameState, toInertialPos, toInertialQuat, toInertialState } from '../../src/physics/frame';
import { qRotate } from '../../src/physics/attitude';
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
  const eph = new Ephemeris(0, 0.4); // 太陽・月とも初期位相を固定して決定的にする
  // bake 時刻は state 自身のエポック(t)なので、時刻はここで与える。
  const stateAt = (t: number): OrbitState => orbitState(t, v3(6.8e6, 5e5, 3e6), v3(-1200, 300, 7400));

  test('frame: inertial は順逆とも恒等（state）', () => {
    const t = 12345;
    const s = stateAt(t);
    assert.ok(closeState(toInertialState('inertial', t, toFrameState('inertial', s, eph), eph), s));
  });

  test('frame: sunRotating の往復は元に戻る（state・同一時刻）', () => {
    const t = YEAR / 4; // sunAz != 0
    const s = stateAt(t);
    const back = toInertialState('sunRotating', t, toFrameState('sunRotating', s, eph), eph);
    assert.ok(closeState(back, s), `round trip: ${JSON.stringify(back)} vs ${JSON.stringify(s)}`);
  });

  test('frame: sunRotating の位置は −sunAz(t) の回転（state・pos が一致）', () => {
    const t = YEAR / 3;
    const s = stateAt(t);
    const expected = rotateAxis(s.r, SUN_ROTATING_POLE, -sunAzimuth(t, 0));
    assert.ok(close(toFrameState('sunRotating', s, eph).r, expected));
    const p = toFramePos('sunRotating', t, s.r, eph);
    assert.ok(close(v3(p.x, p.y, p.z), expected));
  });

  test('frame: pos 変換の往復は元に戻る（sunRotating・同一時刻）', () => {
    const t = YEAR / 6;
    const s = stateAt(t);
    const back = toInertialPos('sunRotating', t, toFramePos('sunRotating', t, s.r, eph), eph);
    assert.ok(close(back, s.r));
  });

  test('frame: 回転系速度は回転系位置の時間微分に一致（有限差分, ω×r 項の検証）', () => {
    const t0 = YEAR / 4;
    const s = stateAt(t0);
    const dt = 1;
    // 慣性系で等速直線運動する点の、回転系位置を中心差分して速度を近似する
    const rRelAt = (t: number): Vec3 =>
      toFrameState('sunRotating', orbitState(t, addScaled(s.r, s.v, t - t0), s.v), eph).r;
    const vFd = scale(sub(rRelAt(t0 + dt), rRelAt(t0 - dt)), 1 / (2 * dt));
    const vAnalytic = toFrameState('sunRotating', s, eph).v;
    // ω×r 項(~1.4 m/s)を落とすと数 m/s ずれる。有限差分自体は 1e-3 m/s より高精度。
    assert.ok(len(sub(vFd, vAnalytic)) < 1e-2, `v mismatch: ${JSON.stringify(vFd)} vs ${JSON.stringify(vAnalytic)}`);
  });

  test('frame: inertial の un-bake クォータニオンは恒等', () => {
    const q = toInertialQuat('inertial', 12345, eph);
    assert.deepEqual(q, { x: 0, y: 0, z: 0, w: 1 });
  });

  test('frame: un-bake クォータニオン回転は toInertialPos と一致（メッシュ剛体 un-bake ≡ ピッキング）', () => {
    // 描画: 頂点は toFramePos で bake → メッシュ全体を toInertialQuat で剛体回転。
    // ピッキング: toInertialPos が位置単位で un-bake。両者が一致しないと描画とクリック判定がずれる。
    const tSample = YEAR / 5;
    const tNow = YEAR / 4;
    const s = stateAt(tSample);
    const baked = toFramePos('sunRotating', tSample, s.r, eph);
    const viaQuat = qRotate(toInertialQuat('sunRotating', tNow, eph), v3(baked.x, baked.y, baked.z));
    const viaPos = toInertialPos('sunRotating', tNow, baked, eph);
    assert.ok(close(viaQuat, viaPos), `quat: ${JSON.stringify(viaQuat)} vs pos: ${JSON.stringify(viaPos)}`);
  });

  test('frame: bake(t) + un-bake(T) の位置合成は 回転 sunAz(T)−sunAz(t)（旧挙動の正味変換）', () => {
    const tSample = YEAR / 5;
    const tNow = YEAR / 4;
    const s = stateAt(tSample);
    const net = toInertialState('sunRotating', tNow, toFrameState('sunRotating', s, eph), eph);
    const expected = rotateAxis(s.r, SUN_ROTATING_POLE, sunAzimuth(tNow, 0) - sunAzimuth(tSample, 0));
    assert.ok(close(net.r, expected), `net: ${JSON.stringify(net.r)} vs ${JSON.stringify(expected)}`);
    // un-bake 後のエポックは描画時刻 tNow(bake 時刻ではない)。
    assert.equal(net.t, tNow);
  });

  test('frame: moonRotating の往復は元に戻る（state・同一時刻）', () => {
    const t = 1.3e6;
    const s = stateAt(t);
    const back = toInertialState('moonRotating', t, toFrameState('moonRotating', s, eph), eph);
    assert.ok(closeState(back, s), `round trip: ${JSON.stringify(back)} vs ${JSON.stringify(s)}`);
  });

  test('frame: moonRotating では月が +X 軸上に静止する', () => {
    // 月回転系の基底は x̂ = 月方向。距離だけが離心率で伸縮し、方向は動かない。
    for (const t of [0, 3e5, 2.4e6, 1e8]) {
      const p = toFramePos('moonRotating', t, eph.moonPosAt(t), eph);
      const dist = len(v3(p.x, p.y, p.z));
      assert.ok(close(v3(p.x, p.y, p.z), v3(dist, 0, 0), 1e-9), `月の位置 (t=${t}): ${JSON.stringify(p)}`);
    }
  });

  test('frame: moonRotating の速度は回転系位置の時間微分に一致（有限差分, ω×r 項の検証）', () => {
    const t0 = 2.4e6;
    const s = stateAt(t0);
    const dt = 1;
    const rRelAt = (t: number): Vec3 =>
      toFrameState('moonRotating', orbitState(t, addScaled(s.r, s.v, t - t0), s.v), eph).r;
    const vFd = scale(sub(rRelAt(t0 + dt), rRelAt(t0 - dt)), 1 / (2 * dt));
    const vAnalytic = toFrameState('moonRotating', s, eph).v;
    assert.ok(len(sub(vFd, vAnalytic)) < 1e-2, `v mismatch: ${JSON.stringify(vFd)} vs ${JSON.stringify(vAnalytic)}`);
  });
}
