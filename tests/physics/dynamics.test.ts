// dynamics.ts の回帰テスト。stepDynamicsRK4 は OrbitEntity.step が使う唯一の 1 ステップ実装。
import * as assert from 'node:assert/strict';
import { test } from './harness';
import { MU_EARTH, R_EARTH, orbitState } from '../../src/physics/orbital-state';
import { Elements, elementsFromState, keplerPeriod, stateFromElements } from '../../src/physics/elements';
import { Ephemeris, MU_MOON, MU_SUN, R_MOON, R_SUN } from '../../src/physics/ephemeris';
import { Attractor } from '../../src/physics/attractor';
import { j2Accel, stepDynamicsRK4, stepOrbitRK4 } from '../../src/physics/dynamics';
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

  test('dynamics: stepOrbitRK4 circular orbit — 1 period position/energy error (measured, pinned)', () => {
    // 420km 円軌道、無摂動(中心重力のみ)。理論上は閉軌道に戻るはずだが、
    // 固定ステップ RK4 の打ち切り誤差が蓄積する。現状の実装でどの程度かを
    // 実測して基準値として固定する(将来ステップ幅やアルゴリズムを変えた際の
    // デグレ検知が目的で、理論的な許容誤差ではない)。
    const alt = 420e3;
    const r0 = R_EARTH + alt;
    const vCirc = Math.sqrt(MU_EARTH / r0);
    let s = orbitState(0, v3(r0, 0, 0), v3(0, 0, vCirc));
    const period = 2 * Math.PI * Math.sqrt((r0 * r0 * r0) / MU_EARTH);
    const e0 = 0.5 * vCirc * vCirc - MU_EARTH / r0;

    const dt = 1; // 1秒刻み
    const steps = Math.round(period / dt);
    for (let i = 0; i < steps; i++) {
      s = stepOrbitRK4(s, dt, (rx, ry, rz) => legacyCentralGravity(v3(rx, ry, rz)));
    }

    const rMag = len(s.r);
    const posErr = len(sub(s.r, v3(r0, 0, 0))) / r0;
    const speed = len(s.v);
    const e1 = 0.5 * speed * speed - MU_EARTH / rMag;
    const energyErr = Math.abs(e1 - e0) / Math.abs(e0);

    // 実測基準値: 1秒刻み RK4, 420km円軌道1周(約5553秒、約5553ステップ)。
    // 実測 posErr ~= 5.0e-4, energyErr は実測して以下に反映。緩めのマージンで固定
    // (数値環境差を吸収する回帰テストであり、理論的な精度保証ではない)。
    assert.ok(posErr < 1e-3, `measured position error after 1 period: ${posErr}`);
    assert.ok(energyErr < 1e-3, `measured energy error after 1 period: ${energyErr}`);
    // state はエポックも持つ: 1 ステップ = dt だけ時刻も進む。
    assert.ok(Math.abs(s.t - steps * dt) < 1e-9, `epoch should advance with the integration: ${s.t}`);
  });

  test('dynamics: j2Accel RAAN regression rate at 420km/51.6deg ~= -5deg/day (measured)', () => {
    // J2 のみを追加加速度として与え、円軌道を長時間積分して RAAN のドリフト率を測る。
    // 標準的な太陽同期軌道の式(dRAAN/dt ~ -5deg/day at 51.6°/420km LEO)との一致は
    // CLAUDE.md に既述の設計目安。許容誤差は緩め(±10%)。
    const alt = 420e3;
    const incDeg = 51.6;
    const inc = (incDeg * Math.PI) / 180;
    const a = R_EARTH + alt;
    let s = stateFromElements(0, a, 0, inc, 0, 0, 0, MU_EARTH);

    const dt = 10;
    const totalDays = 5;
    const totalSeconds = totalDays * 86400;
    const steps = Math.round(totalSeconds / dt);
    for (let i = 0; i < steps; i++) {
      s = stepOrbitRK4(s, dt, (rx, ry, rz) => {
        const r = v3(rx, ry, rz);
        return add(legacyCentralGravity(r), j2Accel(r));
      });
    }

    const el = elementsFromState(s.r, s.v, MU_EARTH) as Elements;
    // RAAN(昇交点赤経) = atan2(hHat.x, -hHat.z) 的な導出でも良いが、ここでは
    // pHat/hHat から昇交点方向ベクトルを求め、その方位角(XZ平面, 基準X軸)を使う。
    // 昇交点方向 = Y(極軸) × hHat の正規化(軌道面と赤道面の交線)
    const hHat = el.hHat;
    const nodeVec = { x: hHat.z, y: 0, z: -hHat.x }; // Y × hHat
    // stateFromElements の raan 引数と同じ回転規約(rotateAxis(X, Y, raan) は
    // X を -Z 方向へ回す)に合わせ、角度は atan2(-z, x) で測る。
    const raan = Math.atan2(-nodeVec.z, nodeVec.x);
    let raanDeg = (raan * 180) / Math.PI;
    // 初期 RAAN は 0 なので、[-180,180] に正規化されたドリフト量として扱う
    if (raanDeg > 180) raanDeg -= 360;
    if (raanDeg < -180) raanDeg += 360;

    const ratePerDay = raanDeg / totalDays;
    const expected = -5;
    const tolFrac = 0.1;
    assert.ok(
      Math.abs(ratePerDay - expected) < Math.abs(expected) * tolFrac,
      `RAAN regression rate: ${ratePerDay} deg/day (expected ~${expected} +-${tolFrac * 100}%)`,
    );
  });
}
