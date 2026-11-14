// orbit-local-frame.ts(周回の局所系)と attitude.ts の stepAttitudeInFrame の回帰テスト。
// 周回する状態を解析的に進め、無トルクの姿勢が局所系に対して保たれることと、局所系の角速度が
// h/r² に一致することを確かめる。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { type Attitude, relativeSpin, stepAttitudeInFrame, type RotatingFrame } from '../../src/physics/attitude';
import { orbitLocalFrame } from '../../src/physics/orbit-local-frame';
import { kinematicState, type KinematicState } from '../../src/physics/kinematic-state';
import { fixedMotion } from './test-helpers';
import { MU_EARTH, R_EARTH } from '../../src/game/celestial/solar-system/earth-system';
import { qInvert, qMul, qFromAxisAngle, qRotate } from '../../src/math/quat';
import { len, v3, type Vec3 } from '../../src/math/vec3';
import type { CelestialMotion } from '../../src/physics/celestial-motion';

const R = R_EARTH + 400e3;
const N = Math.sqrt(MU_EARTH / (R * R * R));
const EARTH: CelestialMotion = fixedMotion({
  id: 'earth', mu: MU_EARTH, radius: R_EARTH,
  state: kinematicState<'eci'>(0, v3(0, 0, 0), v3(0, 0, 0)), accel: v3(0, 0, 0), degree2: null, atmosphere: null,
});

// 円軌道上で、時刻 t の状態。
function circularStateAt(t: number): KinematicState {
  const th = N * t;
  const r = v3(R * Math.cos(th), R * Math.sin(th), 0);
  const v = v3(-R * N * Math.sin(th), R * N * Math.cos(th), 0);
  return kinematicState<'eci'>(t, r, v);
}

function quatDot(a: { x: number; y: number; z: number; w: number }, b: { x: number; y: number; z: number; w: number }): number {
  return Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w);
}

function vecDiff(a: Vec3, b: Vec3): number {
  return len(v3(a.x - b.x, a.y - b.y, a.z - b.z));
}

export function register(): void {
  test('orbit local frame: 円軌道の局所系は h/r² の角速度を持つ', () => {
    const frame = orbitLocalFrame(circularStateAt(0), [EARTH], 0);
    assert.notEqual(frame, null);
    assert.ok(Math.abs(len(frame!.omega) - N) < 1e-12 * N, '角速度の大きさは平均運動に一致する');
  });

  test('orbit local frame: 天体の周りでなければ null を返す', () => {
    // 地球から遠方へ、脱出速度を超える状態。
    const escape = kinematicState<'eci'>(0, v3(R, 0, 0), v3(0, 2 * Math.sqrt(MU_EARTH / R), 0));
    assert.equal(orbitLocalFrame(escape, [EARTH], 0), null);
  });

  test('stepAttitudeInFrame: 無トルク・相対角速度 0 の姿勢は周回に合わせて回り、局所系に対して保たれる', () => {
    const inertia = v3(1, 1, 1);
    const frame0 = orbitLocalFrame(circularStateAt(0), [EARTH], 0) as RotatingFrame;
    // 局所系から少し傾けた姿勢。相対角速度は 0 で、絶対角速度は局所系の回転だけになる。
    const q0 = qMul(frame0.q, qFromAxisAngle(v3(1, 0, 0), 0.3));
    let att: Attitude = { q: q0, w: v3(0, 0, 0), inertia };
    att = { ...att, w: relativeSpinToAbsolute(att, frame0) };
    const relQ0 = qMul(qInvert(frame0.q), att.q);

    let frame = frame0;
    const dt = 600; // 1 歩で約 0.1 周。warp の大きな歩に相当する。
    for (let step = 1; step <= 90; step++) {
      const next = orbitLocalFrame(circularStateAt(step * dt), [EARTH], 0) as RotatingFrame;
      att = stepAttitudeInFrame(att, v3(0, 0, 0), dt, frame, next);
      frame = next;
    }
    // 局所系に対する相対姿勢と相対角速度が、積分の前後で変わらない。
    const relQ = qMul(qInvert(frame.q), att.q);
    assert.ok(quatDot(relQ, relQ0) > 1 - 1e-9, '相対姿勢は保たれる');
    assert.ok(len(relativeSpin(att, frame)) < 1e-9, '相対角速度は 0 のまま');
    // 絶対の角速度は局所系の角速度を追う。
    assert.ok(vecDiff(att.w, relativeSpinToAbsolute(att, frame)) < 1e-9);
  });
}

// 相対角速度 0 のとき、機体座標系の絶対角速度になるベクトル(局所系の角速度を機体座標へ写したもの)。
function relativeSpinToAbsolute(att: Attitude, frame: RotatingFrame): Vec3 {
  return qRotate(qInvert(att.q), frame.omega);
}
