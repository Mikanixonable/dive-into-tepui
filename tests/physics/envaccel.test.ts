// envaccel.ts の回帰テスト。stepEnvRK4 は OrbitEntity.step が使う唯一の 1 ステップ実装で、
// bcInv=0/thrust=null が「stepOrbitRK4 に envAccel を渡す」合成と一致することを確認する。
import * as assert from 'node:assert/strict';
import { test } from './harness';
import { MU_EARTH, R_EARTH, orbitState, stepOrbitRK4 } from '../../src/physics/orbital';
import { envAccel, stepEnvRK4 } from '../../src/physics/envaccel';
import { len, sub, v3 } from '../../src/physics/vec3';

function circularState() {
  const r0 = R_EARTH + 420e3;
  const vc = Math.sqrt(MU_EARTH / r0);
  return orbitState(0, v3(r0, 0, 0), v3(0, vc, 0));
}

export function register(): void {
  test('envaccel: stepEnvRK4(bcInv=0, thrust=null) matches stepOrbitRK4 composed with envAccel manually', () => {
    const s0 = circularState();
    const sunPos = v3(1.5e11, 0, 0);
    const moonPos = v3(3.8e8, 0, 0);
    const dt = 10;

    const viaHelper = stepEnvRK4(s0, dt, sunPos, moonPos, 0, null);
    const viaManualComposition = stepOrbitRK4(s0, dt, (rx, ry, rz, vx, vy, vz) =>
      envAccel(v3(rx, ry, rz), v3(vx, vy, vz), sunPos, moonPos, 0));

    assert.equal(len(sub(viaHelper.r, viaManualComposition.r)), 0, 'position should match exactly (same code path)');
    assert.equal(len(sub(viaHelper.v, viaManualComposition.v)), 0, 'velocity should match exactly (same code path)');
  });

  test('envaccel: stepEnvRK4 adds thrust on top of the environment acceleration', () => {
    const s0 = circularState();
    const sunPos = v3(1.5e11, 0, 0);
    const moonPos = v3(3.8e8, 0, 0);
    const dt = 10;
    const thrust = v3(0, 0, 5); // 大きめの加速度で差が明確に出るようにする

    const withThrust = stepEnvRK4(s0, dt, sunPos, moonPos, 0, thrust);
    const withoutThrust = stepEnvRK4(s0, dt, sunPos, moonPos, 0, null);

    assert.ok(len(sub(withThrust.v, withoutThrust.v)) > 1, 'thrust should visibly change the velocity');
  });

  test('envaccel: stepEnvRK4 with bcInv>0 decelerates more than bcInv=0 at LEO altitude', () => {
    const s0 = circularState();
    const sunPos = v3(1.5e11, 0, 0);
    const moonPos = v3(3.8e8, 0, 0);
    const dt = 10;

    const noDrag = stepEnvRK4(s0, dt, sunPos, moonPos, 0, null);
    const withDrag = stepEnvRK4(s0, dt, sunPos, moonPos, 0.01, null);

    assert.ok(len(withDrag.v) < len(noDrag.v), 'drag should reduce orbital speed relative to the drag-free step');
  });
}
