// dynamics.ts の回帰テスト。stepDynamicsRK4 は OrbitEntity.step が使う唯一の 1 ステップ実装。
import * as assert from 'node:assert/strict';
import { test } from './harness';
import {
  MU_EARTH, R_EARTH, j2Accel, keplerPeriod, orbitState, stateFromElements, stepOrbitRK4,
} from '../../src/physics/orbital';
import { Ephemeris, MU_MOON, MU_SUN, R_MOON, R_SUN } from '../../src/physics/ephemeris';
import { Attractor } from '../../src/physics/attractor';
import { stepDynamicsRK4 } from '../../src/physics/dynamics';
import { Vec3, add, len, sub, v3 } from '../../src/physics/vec3';

function circularState() {
  const r0 = R_EARTH + 420e3;
  const vc = Math.sqrt(MU_EARTH / r0);
  return orbitState(0, v3(r0, 0, 0), v3(0, vc, 0));
}

// フェーズ B 以前の合成: −μ_E r/|r|³(中心重力)+ 太陽・月の潮汐摂動 + J2。
// stepOrbitRK4 は中心重力を持たなくなったので、比較対象として本体から消えた式をここへ写経する。
function legacyThirdBody(r: Vec3, bodyPos: Vec3, mu: number): Vec3 {
  const rho = sub(bodyPos, r);
  const d3 = Math.pow(len(rho), 3);
  const b3 = Math.pow(len(bodyPos), 3);
  return v3(
    (mu * rho.x) / d3 - (mu * bodyPos.x) / b3,
    (mu * rho.y) / d3 - (mu * bodyPos.y) / b3,
    (mu * rho.z) / d3 - (mu * bodyPos.z) / b3,
  );
}
function legacyCentralGravity(r: Vec3): Vec3 {
  const d = len(r);
  const k = -MU_EARTH / (d * d * d);
  return v3(r.x * k, r.y * k, r.z * k);
}
function legacyAccel(r: Vec3, sunPos: Vec3, moonPos: Vec3): Vec3 {
  const central = legacyCentralGravity(r);
  const sun = legacyThirdBody(r, sunPos, MU_SUN);
  const moon = legacyThirdBody(r, moonPos, MU_MOON);
  const j2 = j2Accel(r);
  return add(add(add(central, sun), moon), j2);
}

export function register(): void {
  test('dynamics: stepDynamicsRK4(bcInv=0, thrust=null) matches a hand-written legacy central-gravity + third-body + J2 composition to machine precision', () => {
    const s0 = circularState();
    const dt = 10;
    const sunPos = v3(1.5e11, 0, 0);
    const moonPos = v3(3.8e8, 0, 0);
    const bodies: readonly Attractor[] = [
      { id: 'earth', mu: MU_EARTH, radius: R_EARTH, r: v3(0, 0, 0), v: v3(0, 0, 0) },
      { id: 'moon', mu: MU_MOON, radius: R_MOON, r: moonPos, v: v3(0, 0, 0) },
      { id: 'sun', mu: MU_SUN, radius: R_SUN, r: sunPos, v: v3(0, 0, 0) },
    ];

    const viaNew = stepDynamicsRK4(s0, dt, bodies, 0, null);
    const viaLegacy = stepOrbitRK4(s0, dt, (rx, ry, rz) => legacyAccel(v3(rx, ry, rz), sunPos, moonPos));

    const posErr = len(sub(viaNew.r, viaLegacy.r)) / len(viaLegacy.r);
    const velErr = len(sub(viaNew.v, viaLegacy.v)) / len(viaLegacy.v);
    assert.ok(posErr < 1e-9, `position should match to machine precision: relative error ${posErr}`);
    assert.ok(velErr < 1e-9, `velocity should match to machine precision: relative error ${velErr}`);
  });

  test('dynamics: stepDynamicsRK4 adds thrust on top of gravity', () => {
    const s0 = circularState();
    const dt = 10;
    const bodies = new Ephemeris(0, 0).attractorsAt(0);
    const thrust = v3(0, 0, 5); // 大きめの加速度で差が明確に出るようにする

    const withThrust = stepDynamicsRK4(s0, dt, bodies, 0, thrust);
    const withoutThrust = stepDynamicsRK4(s0, dt, bodies, 0, null);

    assert.ok(len(sub(withThrust.v, withoutThrust.v)) > 1, 'thrust should visibly change the velocity');
  });

  test('dynamics: stepDynamicsRK4 with bcInv>0 decelerates more than bcInv=0 at LEO altitude', () => {
    const s0 = circularState();
    const dt = 10;
    const bodies = new Ephemeris(0, 0).attractorsAt(0);

    const noDrag = stepDynamicsRK4(s0, dt, bodies, 0, null);
    const withDrag = stepDynamicsRK4(s0, dt, bodies, 0.01, null);

    assert.ok(len(withDrag.v) < len(noDrag.v), 'drag should reduce orbital speed relative to the drag-free step');
  });

  test('dynamics: a circular lunar orbit (surface +100km) returns to about the same moon-relative position after one revolution (measured, pinned)', () => {
    const ephemeris = new Ephemeris(0, 0);
    const bodies0 = ephemeris.attractorsAt(0);
    const moon0 = bodies0.find((b) => b.id === 'moon')!;
    const a = R_MOON + 100e3;
    const period = keplerPeriod(a, MU_MOON); // ~7,066s
    const rel0 = stateFromElements(0, a, 0, (10 * Math.PI) / 180, 0, 0, 0, MU_MOON);
    let s = orbitState(0, add(rel0.r, moon0.r), add(rel0.v, moon0.v));

    const dt = 5;
    const steps = Math.round(period / dt);
    for (let i = 0; i < steps; i++) {
      const bodies = ephemeris.attractorsAt(s.t + dt / 2);
      s = stepDynamicsRK4(s, dt, bodies, 0, null);
    }

    const relFinal = sub(s.r, ephemeris.moonPosAt(s.t));
    const drift = len(sub(relFinal, rel0.r));
    // 地球(・太陽)の潮汐差ぶんの摂動がかかるので、月の二体問題の解には正確には戻らない。
    assert.ok(drift < 50e3, `moon-relative drift after 1 revolution: ${drift} m (expected within tens of km)`);
  });
}
