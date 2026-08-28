// srp.ts の回帰テスト。大気抵抗が消える高軌道では、これが物体に働く唯一の非重力摂動になる。
import * as assert from 'node:assert/strict';
import { test } from './harness';
import { CelestialBody } from '../../src/physics/celestial-body';
import { SOLAR_PRESSURE_1AU, srpAccel } from '../../src/physics/srp';
import { AU } from '../../src/physics/planet-orbit';
import { MU_SUN, R_SUN } from '../../src/physics/solar-system';
import { kinematicState } from '../../src/physics/kinematic-state';
import { cross, dot, len, norm, sub, v3 } from '../../src/math/vec3';

const ZERO = v3(0, 0, 0);

// 地心から見て +X 方向 1 AU に太陽を置く。
function sunAt(distance: number): CelestialBody {
  return { id: 'sun', mu: MU_SUN, radius: R_SUN, state: kinematicState(0, v3(distance, 0, 0), ZERO), accel: ZERO, degree2: null, atmosphere: null, isStar: true };
}

export function register(): void {
  test('srp: srpCoeff = 0 gives exactly zero acceleration', () => {
    assert.deepEqual(srpAccel(v3(7e6, 0, 0), sunAt(AU), 0, 1), ZERO);
  });

  test('srp: a fully shadowed object gets exactly zero acceleration', () => {
    assert.deepEqual(srpAccel(v3(7e6, 0, 0), sunAt(AU), 1e-2, 0), ZERO);
  });

  test('srp: the acceleration points from the sun toward the object', () => {
    const sun = sunAt(AU);
    const r = v3(-7e6, 2e6, 1e6); // 太陽と反対側
    const a = srpAccel(r, sun, 1e-2, 1);
    const away = norm(sub(r, sun.state.r));
    assert.ok(dot(norm(a), away) > 0, 'the acceleration should push away from the sun');
    assert.ok(len(cross(norm(a), away)) < 1e-12, 'the acceleration should be parallel to the sun-to-object line');
  });

  test('srp: at 1 AU with a unit coefficient the magnitude equals the reference solar pressure', () => {
    // 逆2乗則の基準点そのものの検証。ここがずれると全ての距離でずれる。
    const sun = sunAt(0);
    const mag = len(srpAccel(v3(AU, 0, 0), sun, 1, 1));
    assert.ok(Math.abs(mag - SOLAR_PRESSURE_1AU) / SOLAR_PRESSURE_1AU < 1e-12, `magnitude at 1 AU: ${mag}`);
  });

  test('srp: doubling the sun distance quarters the acceleration', () => {
    const sun = sunAt(0);
    const near = len(srpAccel(v3(AU, 0, 0), sun, 1e-2, 1));
    const far = len(srpAccel(v3(2 * AU, 0, 0), sun, 1e-2, 1));
    assert.ok(Math.abs(near / far - 4) < 1e-9, `ratio should be 4: ${near / far}`);
  });

  test('srp: the shadow factor scales the acceleration linearly', () => {
    const sun = sunAt(AU);
    const r = v3(-7e6, 0, 0);
    const full = len(srpAccel(r, sun, 1e-2, 1));
    const half = len(srpAccel(r, sun, 1e-2, 0.5));
    assert.ok(Math.abs(half / full - 0.5) < 1e-12, `penumbra should scale linearly: ${half / full}`);
  });

  test('srp: a ship-scale coefficient gives about 7e-8 m/s^2 near Earth', () => {
    // 高度 420km の大気抵抗 2.6e-7 m/s^2 の約 1/4。地球近傍では小さいが、大気抵抗が
    // ゼロになるラグランジュ点領域ではこの値のまま唯一の非重力摂動として残る。
    const mag = len(srpAccel(v3(-6.8e6, 0, 0), sunAt(AU), 1.56e-2, 1));
    assert.ok(Math.abs(mag - 7.1e-8) / 7.1e-8 < 0.05, `ship-scale SRP magnitude: ${mag} m/s^2`);
  });
}
