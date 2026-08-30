// kinematic-state.ts の回帰テスト(hermiteInterpolate / orbitAxes / fromOrbitAxes)。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import {
  fromOrbitAxes,
  hermiteInterpolate,
  kinematicState,
  orbitAxes,
} from '../../src/physics/kinematic-state';
import { MU_EARTH, R_EARTH } from '../../src/game/celestial/solar-system/constants';
import { stateFromOrbitalElements } from '../../src/physics/elements';
import { stepRK4 } from '../../src/physics/dynamics';
import { Vec3, dot, len, norm, sub, v3 } from '../../src/math/vec3';

// stepRK4 は中心重力を持たないので、hermiteInterpolate の精度を測るテスト用に
// この加速度コールバックを自前で渡す。
function earthGravity(r: Vec3): Vec3 {
  const d = len(r);
  const k = -MU_EARTH / (d * d * d);
  return v3(r.x * k, r.y * k, r.z * k);
}

export function register(): void {
  test('kinematic-state: hermiteInterpolate reproduces the endpoints and beats linear interpolation', () => {
    // 420km 円軌道を RK4 で 300 秒(周期の約 1/18)進め、その両端から中間時刻を補間する。
    const r0 = R_EARTH + 420e3;
    const vCirc = Math.sqrt(MU_EARTH / r0);
    const a = kinematicState<'eci'>(0, v3(r0, 0, 0), v3(0, 0, vCirc));
    const span = 300;
    let b = a;
    for (let i = 0; i < span; i++) b = stepRK4(b, 1, (_t, rx, ry, rz) => earthGravity(v3(rx, ry, rz)));

    // 両端では入力そのもの(エルミートの定義どおり位置・速度とも一致する)
    const at0 = hermiteInterpolate(a, b, a.t);
    const at1 = hermiteInterpolate(a, b, b.t);
    assert.ok(len(sub(at0.r, a.r)) < 1e-6 && len(sub(at0.v, a.v)) < 1e-9, 'endpoint t=a.t');
    assert.ok(len(sub(at1.r, b.r)) < 1e-6 && len(sub(at1.v, b.v)) < 1e-9, 'endpoint t=b.t');

    // 中間時刻: 真値(同じ RK4 で積分した状態)との誤差が線形補間より桁違いに小さい
    let truth = a;
    for (let i = 0; i < span / 2; i++) truth = stepRK4(truth, 1, (_t, rx, ry, rz) => earthGravity(v3(rx, ry, rz)));
    const herm = hermiteInterpolate(a, b, truth.t);
    const linear = v3(
      (a.r.x + b.r.x) / 2, (a.r.y + b.r.y) / 2, (a.r.z + b.r.z) / 2,
    );
    const hermErr = len(sub(herm.r, truth.r));
    const linErr = len(sub(linear, truth.r));
    assert.ok(hermErr < linErr / 100, `hermite ${hermErr} m vs linear ${linErr} m`);

    // 逆順(a.t > b.t)でも同じ多項式
    const rev = hermiteInterpolate(b, a, truth.t);
    assert.ok(len(sub(rev.r, herm.r)) < 1e-6, 'argument order should not matter');
  });

  test('kinematic-state: hermiteInterpolate rejects out-of-range t', () => {
    const a = kinematicState<'eci'>(100, v3(R_EARTH + 420e3, 0, 0), v3(0, 0, 7660));
    const b = kinematicState<'eci'>(200, v3(R_EARTH + 420e3, 0, 766e3), v3(-880, 0, 7610));

    assert.throws(() => hermiteInterpolate(a, b, 250), /区間/, 'past the end');
    assert.throws(() => hermiteInterpolate(a, b, 50), /区間/, 'before the start');
    // 同時刻の2点は補間できない
    assert.throws(() => hermiteInterpolate(a, kinematicState<'eci'>(a.t, b.r, b.v), a.t), /同時刻/);
  });

  test('kinematic-state: orbitAxes returns an orthonormal basis', () => {
    const a = R_EARTH + 700e3;
    const s = stateFromOrbitalElements(0, a, 0.15, (43 * Math.PI) / 180, 0.4, 0.9, 1.3, MU_EARTH);
    const { pro, nrm, radOut } = orbitAxes(s);
    const tol = 1e-9;
    assert.ok(Math.abs(len(pro) - 1) < tol, `|pro| should be 1: ${len(pro)}`);
    assert.ok(Math.abs(len(nrm) - 1) < tol, `|nrm| should be 1: ${len(nrm)}`);
    assert.ok(Math.abs(len(radOut) - 1) < tol, `|radOut| should be 1: ${len(radOut)}`);
    assert.ok(Math.abs(dot(pro, nrm)) < tol, `pro should be orthogonal to nrm: ${dot(pro, nrm)}`);
    assert.ok(Math.abs(dot(nrm, radOut)) < tol, `nrm should be orthogonal to radOut: ${dot(nrm, radOut)}`);
    assert.ok(Math.abs(dot(radOut, pro)) < tol, `radOut should be orthogonal to pro: ${dot(radOut, pro)}`);
  });

  test('kinematic-state: orbitAxes.radOut matches r-hat on a circular orbit (r perp v)', () => {
    const a = R_EARTH + 420e3;
    const s = stateFromOrbitalElements(0, a, 0, (51.6 * Math.PI) / 180, 0.2, 0, 0.7, MU_EARTH);
    const rHat = norm(s.r);
    const { radOut } = orbitAxes(s);
    assert.ok(
      len(sub(radOut, rHat)) < 1e-9,
      `radOut should coincide with r-hat on a circular orbit: ${len(sub(radOut, rHat))}`,
    );
  });

  test('kinematic-state: orbitAxes.radOut diverges from r-hat on an eccentric orbit but stays orthonormal', () => {
    // e=0.3, nu=1.0(近点でも遠点でもない): dot(r,v) = r*k*e*sin(nu) が非ゼロになり、
    // radOut(進行方向に直交な面内ベクトル)が r-hat から傾く条件になる。
    const a = R_EARTH + 700e3;
    const s = stateFromOrbitalElements(0, a, 0.3, (30 * Math.PI) / 180, 0, 0, 1.0, MU_EARTH);
    const { pro, nrm, radOut } = orbitAxes(s);
    const rHat = norm(s.r);
    const divergence = len(sub(radOut, rHat));
    assert.ok(
      divergence > 1e-3,
      `radOut should diverge from r-hat on an eccentric orbit: ${divergence}`,
    );

    const tol = 1e-9;
    assert.ok(
      Math.abs(len(pro) - 1) < tol && Math.abs(len(nrm) - 1) < tol && Math.abs(len(radOut) - 1) < tol,
      'axes should remain unit length even off r-hat',
    );
    assert.ok(
      Math.abs(dot(pro, nrm)) < tol && Math.abs(dot(nrm, radOut)) < tol && Math.abs(dot(radOut, pro)) < tol,
      'axes should remain mutually orthogonal even off r-hat',
    );
  });

  test('kinematic-state: fromOrbitAxes maps the unit axis vectors to pro/nrm/radOut', () => {
    const a = R_EARTH + 700e3;
    const s = stateFromOrbitalElements(0, a, 0.15, (43 * Math.PI) / 180, 0.4, 0.9, 1.3, MU_EARTH);
    const { pro, nrm, radOut } = orbitAxes(s);
    const tol = 1e-9;
    assert.ok(len(sub(fromOrbitAxes(s, v3(1, 0, 0)), pro)) < tol, 'x=1 should map to pro');
    assert.ok(len(sub(fromOrbitAxes(s, v3(0, 1, 0)), nrm)) < tol, 'y=1 should map to nrm');
    assert.ok(len(sub(fromOrbitAxes(s, v3(0, 0, 1)), radOut)) < tol, 'z=1 should map to radOut');
  });

  test('kinematic-state: fromOrbitAxes preserves vector length (orthonormal change of basis)', () => {
    const a = R_EARTH + 700e3;
    const s = stateFromOrbitalElements(0, a, 0.15, (43 * Math.PI) / 180, 0.4, 0.9, 1.3, MU_EARTH);
    const x = v3(0.3, -0.5, 0.8);
    const mapped = fromOrbitAxes(s, x);
    assert.ok(
      Math.abs(len(mapped) - len(x)) < 1e-9,
      `length should be preserved by an orthonormal basis: ${len(mapped)} vs ${len(x)}`,
    );
  });
}
