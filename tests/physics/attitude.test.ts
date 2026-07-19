// attitude.ts の回帰テスト: 無トルク時の回転運動エネルギー保存(エネルギー射影の検証)、
// および四元数ノルムの維持。理論上エネルギーは厳密保存されるべき量なので、
// 許容誤差は数値誤差起因の小さい値として設定する。
import * as assert from 'node:assert/strict';
import { test } from './harness';
import { Attitude, qFromAxisAngle, stepAttitude } from '../../src/physics/attitude';
import { v3 } from '../../src/physics/vec3';

function kineticEnergy(att: Attitude): number {
  const { inertia: I, w } = att;
  return 0.5 * (I.x * w.x * w.x + I.y * w.y * w.y + I.z * w.z * w.z);
}

function quatNorm(att: Attitude): number {
  const { x, y, z, w } = att.q;
  return Math.sqrt(x * x + y * y + z * z + w * w);
}

export function register(): void {
  test('attitude: torque-free tumbling conserves kinetic energy over long integration', () => {
    // 非対称慣性主軸(中間軸不安定性 = ジャニベコフ効果が起きる条件)で
    // トルクなし・長時間(1000秒、25ms刻み相当を大きく超える)積分する。
    const att: Attitude = {
      q: { x: 0, y: 0, z: 0, w: 1 },
      w: v3(0.05, 3.0, 0.05), // 中間軸(y)周りにわずかな擾乱を加えた不安定回転
      inertia: v3(1, 2, 3), // 非対称主慣性モーメント
    };
    const e0 = kineticEnergy(att);
    const dt = 0.05;
    const steps = 20000; // 1000秒
    for (let i = 0; i < steps; i++) {
      stepAttitude(att, v3(0, 0, 0), dt);
    }
    const e1 = kineticEnergy(att);
    const relErr = Math.abs(e1 - e0) / e0;
    // エネルギー射影により厳密保存されるはず。数値丸め誤差のみを許容。
    assert.ok(relErr < 1e-9, `kinetic energy drift after ${steps} steps: ${relErr}`);
  });

  test('attitude: quaternion norm stays unit over long integration', () => {
    const att: Attitude = {
      q: { x: 0, y: 0, z: 0, w: 1 },
      w: v3(0.2, 1.5, -0.3),
      inertia: v3(1, 2, 3),
    };
    const dt = 0.05;
    for (let i = 0; i < 20000; i++) {
      stepAttitude(att, v3(0, 0, 0), dt);
    }
    assert.ok(Math.abs(quatNorm(att) - 1) < 1e-9, `quat norm: ${quatNorm(att)}`);
  });

  test('attitude: constant torque about a principal axis increases spin monotonically along that axis', () => {
    const att: Attitude = {
      q: { x: 0, y: 0, z: 0, w: 1 },
      w: v3(0, 0, 0),
      inertia: v3(1, 1, 1), // 対称(球対称)にして単純化
    };
    for (let i = 0; i < 100; i++) {
      stepAttitude(att, v3(0, 0, 1), 0.05);
    }
    // I=1, torque=1 -> wz(t) = t = 5s
    assert.ok(Math.abs(att.w.z - 5) < 1e-3, `wz after 5s of unit torque on unit inertia: ${att.w.z}`);
    assert.ok(Math.abs(att.w.x) < 1e-9 && Math.abs(att.w.y) < 1e-9);
  });

  test('attitude: qFromAxisAngle round trip via stepAttitude matches direct rotation for a single small step', () => {
    // ゼロ角速度 + 瞬間的な角速度付与ではなく、単純に「一定角速度で一定時間回した」姿勢が
    // 対応する軸角回転とほぼ一致することを確認(小さいステップでの整合性チェック)。
    const att: Attitude = {
      q: { x: 0, y: 0, z: 0, w: 1 },
      w: v3(0, 1, 0), // Y軸まわり 1 rad/s
      inertia: v3(1, 1, 1),
    };
    const dt = 0.1;
    stepAttitude(att, v3(0, 0, 0), dt);
    const expected = qFromAxisAngle(v3(0, 1, 0), 1 * dt);
    assert.ok(Math.abs(att.q.y - expected.y) < 1e-6, `q.y: ${att.q.y} vs ${expected.y}`);
    assert.ok(Math.abs(att.q.w - expected.w) < 1e-6, `q.w: ${att.q.w} vs ${expected.w}`);
  });
}
