// orbital.ts の回帰テスト。
// - ケプラー要素⇄状態ベクトルの往復精度は理論上「機械精度」であるべき値(解析的往復)。
// - stepOrbitRK4 の1周後誤差、j2Accel の RAAN 回帰率は「現状の実装の実測値」を基準値として
//   固定する(理論値との突き合わせではなく、既存挙動を壊さないための回帰テスト)。
import * as assert from 'node:assert/strict';
import { test } from './harness';
import {
  Elements,
  MU_EARTH,
  R_EARTH,
  elementsFromState,
  hermiteInterpolate,
  j2Accel,
  orbitState,
  positionOnOrbit,
  stateFromElements,
  stepOrbitRK4,
  timeSincePeriapsis,
  tofBetween,
  trueAnomalyAt,
  velocityOnOrbit,
} from '../../src/physics/orbital';
import { len, sub, v3 } from '../../src/physics/vec3';

export function register(): void {
  test('orbital: stateFromElements <-> elementsFromState round trip (machine precision)', () => {
    const a = R_EARTH + 500e3;
    const e = 0.05;
    const inc = (51.6 * Math.PI) / 180;
    const raan = 0.7;
    const argp = 1.1;
    const nu = 2.3;
    const s = stateFromElements(0, a, e, inc, raan, argp, nu);
    const el = elementsFromState(s.r, s.v);
    assert.ok(el, 'elementsFromState should not be null for a bound elliptical orbit');
    const elx = el as Elements;
    assert.ok(Math.abs(elx.a - a) / a < 1e-9, `a round trip: ${elx.a} vs ${a}`);
    assert.ok(Math.abs(elx.e - e) < 1e-9, `e round trip: ${elx.e} vs ${e}`);
    assert.ok(
      Math.abs(elx.incDeg - (inc * 180) / Math.PI) < 1e-7,
      `inc round trip: ${elx.incDeg}`,
    );
  });

  test('orbital: trueAnomalyAt / positionOnOrbit / velocityOnOrbit round trip', () => {
    const a = R_EARTH + 800e3;
    const e = 0.02;
    const inc = (28 * Math.PI) / 180;
    const s0 = stateFromElements(0, a, e, inc, 0.3, 0.5, 0.9);
    const el = elementsFromState(s0.r, s0.v) as Elements;
    const nu = trueAnomalyAt(el, s0.r);
    assert.ok(Math.abs(nu - 0.9) < 1e-7, `trueAnomalyAt recovers nu: ${nu}`);
    const r2 = positionOnOrbit(el, nu);
    const v2 = velocityOnOrbit(el, nu);
    assert.ok(len(sub(r2, s0.r)) / len(s0.r) < 1e-9, 'positionOnOrbit matches original r');
    assert.ok(len(sub(v2, s0.v)) / len(s0.v) < 1e-9, 'velocityOnOrbit matches original v');
  });

  test('orbital: tofBetween(nu, nu) == 0 and tofBetween is period-periodic', () => {
    const a = R_EARTH + 500e3;
    const s0 = stateFromElements(0, a, 0.01, 0.9, 0, 0, 0);
    const el = elementsFromState(s0.r, s0.v) as Elements;
    assert.equal(tofBetween(el, 1.2, 1.2), 0);
    const tHalf = tofBetween(el, 0, Math.PI);
    // 半周の飛行時間はほぼ半周期(離心率が小さいため近似的に対称)
    assert.ok(
      Math.abs(tHalf - el.period / 2) / el.period < 1e-3,
      `half-period tof ~= period/2: ${tHalf} vs ${el.period / 2}`,
    );
  });

  test('orbital: timeSincePeriapsis(nu=0) == 0', () => {
    const a = R_EARTH + 500e3;
    const s0 = stateFromElements(0, a, 0.1, 0.5, 0, 0, 0);
    const el = elementsFromState(s0.r, s0.v) as Elements;
    assert.equal(timeSincePeriapsis(el, 0), 0);
  });

  test('orbital: timeSincePeriapsis on a hyperbolic orbit (e >= 1)', () => {
    // 近地点高度 500km、離心率 1.5 の双曲線軌道。
    const rp = R_EARTH + 500e3;
    const e = 1.5;
    const a = rp / (1 - e); // 双曲線なので a < 0
    const s0 = stateFromElements(0, a, e, 0.3, 0, 0, 0); // nu=0 = 近点
    const el = elementsFromState(s0.r, s0.v) as Elements;
    assert.ok(el.e >= 1, `orbit should be hyperbolic: e=${el.e}`);
    assert.ok(el.a < 0, `hyperbolic a should be negative: a=${el.a}`);

    // 近点通過時刻はゼロ
    assert.equal(timeSincePeriapsis(el, 0), 0);

    // nu > 0 で正、nu < 0 で負、かつ符号対称
    const tPlus = timeSincePeriapsis(el, 0.5);
    const tMinus = timeSincePeriapsis(el, -0.5);
    assert.ok(tPlus > 0, `t(nu>0) should be positive: ${tPlus}`);
    assert.ok(tMinus < 0, `t(nu<0) should be negative: ${tMinus}`);
    assert.ok(Math.abs(tPlus + tMinus) < 1e-6, `t(-nu) should equal -t(nu): ${tPlus} vs ${tMinus}`);
    assert.ok(Number.isFinite(tPlus) && Number.isFinite(tMinus), 'result should be finite, not NaN (regression for the pre-fix NaN bug)');

    // 単調増加
    const nus = [-1.5, -1.0, -0.5, 0, 0.5, 1.0, 1.5];
    const ts = nus.map((nu) => timeSincePeriapsis(el, nu));
    for (let i = 1; i < ts.length; i++) {
      assert.ok(ts[i] > ts[i - 1], `timeSincePeriapsis should be monotonically increasing: ${ts}`);
    }

    // 漸近線を越える nu(真近点角が漸近線角度 acos(-1/e) を超える)では到達時刻が存在せず NaN
    const nuAsymptote = Math.acos(-1 / el.e);
    const nuBeyond = nuAsymptote + 0.1;
    assert.ok(Number.isNaN(timeSincePeriapsis(el, nuBeyond)), 'beyond the asymptote, no finite arrival time exists (NaN)');
  });

  test('orbital: stepOrbitRK4 circular orbit — 1 period position/energy error (measured, pinned)', () => {
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
      s = stepOrbitRK4(s, dt);
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

  test('orbital: hermiteInterpolate reproduces the endpoints and beats linear interpolation', () => {
    // 420km 円軌道を RK4 で 300 秒(周期の約 1/18)進め、その両端から中間時刻を補間する。
    const r0 = R_EARTH + 420e3;
    const vCirc = Math.sqrt(MU_EARTH / r0);
    const a = orbitState(0, v3(r0, 0, 0), v3(0, 0, vCirc));
    const span = 300;
    let b = a;
    for (let i = 0; i < span; i++) b = stepOrbitRK4(b, 1);

    // 両端では入力そのもの(エルミートの定義どおり位置・速度とも一致する)
    const at0 = hermiteInterpolate(a, b, a.t);
    const at1 = hermiteInterpolate(a, b, b.t);
    assert.ok(len(sub(at0.r, a.r)) < 1e-6 && len(sub(at0.v, a.v)) < 1e-9, 'endpoint t=a.t');
    assert.ok(len(sub(at1.r, b.r)) < 1e-6 && len(sub(at1.v, b.v)) < 1e-9, 'endpoint t=b.t');

    // 中間時刻: 真値(同じ RK4 で積分した状態)との誤差が線形補間より桁違いに小さい
    let truth = a;
    for (let i = 0; i < span / 2; i++) truth = stepOrbitRK4(truth, 1);
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

  test('orbital: hermiteInterpolate rejects out-of-range t unless extrapolation is allowed', () => {
    const a = orbitState(100, v3(R_EARTH + 420e3, 0, 0), v3(0, 0, 7660));
    const b = orbitState(200, v3(R_EARTH + 420e3, 0, 766e3), v3(-880, 0, 7610));

    assert.throws(() => hermiteInterpolate(a, b, 250), /区間/, 'past the end');
    assert.throws(() => hermiteInterpolate(a, b, 50), /区間/, 'before the start');
    // 同時刻の2点は(外挿を許しても)補間できない
    assert.throws(() => hermiteInterpolate(a, orbitState(a.t, b.r, b.v), a.t, true), /同時刻/);

    const out = hermiteInterpolate(a, b, 250, true);
    assert.equal(out.t, 250);
    assert.ok(Number.isFinite(len(out.r)) && Number.isFinite(len(out.v)), 'extrapolation stays finite');
  });

  test('orbital: j2Accel RAAN regression rate at 420km/51.6deg ~= -5deg/day (measured)', () => {
    // J2 のみを追加加速度として与え、円軌道を長時間積分して RAAN のドリフト率を測る。
    // 標準的な太陽同期軌道の式(dRAAN/dt ~ -5deg/day at 51.6°/420km LEO)との一致は
    // CLAUDE.md に既述の設計目安。許容誤差は緩め(±10%)。
    const alt = 420e3;
    const incDeg = 51.6;
    const inc = (incDeg * Math.PI) / 180;
    const a = R_EARTH + alt;
    let s = stateFromElements(0, a, 0, inc, 0, 0, 0);

    const dt = 10;
    const totalDays = 5;
    const totalSeconds = totalDays * 86400;
    const steps = Math.round(totalSeconds / dt);
    for (let i = 0; i < steps; i++) {
      s = stepOrbitRK4(s, dt, (rx, ry, rz) => j2Accel(v3(rx, ry, rz)));
    }

    const el = elementsFromState(s.r, s.v) as Elements;
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
