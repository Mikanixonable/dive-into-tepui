// dynamics.ts の回帰テスト。stepDynamics は DynamicTrajectory.step が使う唯一の 1 ステップ実装。
import * as assert from 'node:assert/strict';
import { test } from './harness';
import { kinematicState } from '../../src/physics/kinematic-state';
import { MU_EARTH, R_EARTH, R_EARTH_EQ } from '../../src/physics/solar-system';
import { OrbitalElements, keplerPeriod, stateFromOrbitalElements } from '../../src/physics/elements';
import { Ephemeris } from '../../src/physics/ephemeris';
import { C22_MOON, J2_EARTH, J2_MOON, MU_MOON, MU_SUN, R_MOON, R_MOON_GRAVITY, R_SUN } from '../../src/physics/solar-system';
import { Attractor, Degree2Gravity, orbitalElementsOf } from '../../src/physics/attractor';
import { degree2Accel, stepDynamics, stepRK4 } from '../../src/physics/dynamics';
import { Vec3, add, cross, dot, len, norm, scale, sub, v3 } from '../../src/physics/vec3';
import { qFromAxisAngle, qRotate } from '../../src/physics/attitude';

const EARTH_POLE = v3(0, 1, 0);
const EARTH_DEGREE2: Degree2Gravity = { j2: J2_EARTH, refRadius: R_EARTH_EQ, pole: EARTH_POLE, tesseral: null };
const EARTH: Attractor = {
  id: 'earth', mu: MU_EARTH, radius: R_EARTH, state: kinematicState(0, v3(0, 0, 0), v3(0, 0, 0)), degree2: EARTH_DEGREE2,
};

function circularState() {
  const r0 = R_EARTH + 420e3;
  const vc = Math.sqrt(MU_EARTH / r0);
  return kinematicState(0, v3(r0, 0, 0), v3(0, vc, 0));
}

function rot(v: Vec3, axis: Vec3, angle: number): Vec3 {
  return qRotate(qFromAxisAngle(axis, angle), v);
}

// 2次重力場のポテンシャル。degree2Accel はこの勾配であるべきなので、数値微分の基準に使う。
function degree2Potential(r: Vec3, mu: number, g: Degree2Gravity): number {
  const r2 = dot(r, r);
  const inv5 = 1 / (r2 * r2 * Math.sqrt(r2));
  const muR2 = mu * g.refRadius * g.refRadius;
  const z = dot(r, g.pole);
  let u = -0.5 * g.j2 * muR2 * (3 * z * z - r2) * inv5;
  if (g.tesseral !== null) {
    const x = dot(r, g.tesseral.longAxis);
    const y = dot(r, cross(g.pole, g.tesseral.longAxis));
    u += 3 * g.tesseral.c22 * muR2 * (x * x - y * y) * inv5;
  }
  return u;
}

function numericalGradient(f: (p: Vec3) => number, r: Vec3, h: number): Vec3 {
  const d = (axis: Vec3) => (f(add(r, scale(axis, h))) - f(sub(r, scale(axis, h)))) / (2 * h);
  return v3(d(v3(1, 0, 0)), d(v3(0, 1, 0)), d(v3(0, 0, 1)));
}

// 極軸を Y に固定していた地球専用の J2 式。任意の極方向を取る degree2Accel が、この
// 特殊形と一致することを検証するための独立した基準として写経する。
function yAxisJ2Accel(r: Vec3): Vec3 {
  const r2 = r.x * r.x + r.y * r.y + r.z * r.z;
  const rl = Math.sqrt(r2);
  const k = (-1.5 * J2_EARTH * MU_EARTH * R_EARTH_EQ * R_EARTH_EQ) / (r2 * r2 * rl);
  const f = (5 * r.y * r.y) / r2;
  return v3(k * r.x * (1 - f), k * r.y * (3 - f), k * r.z * (1 - f));
}

// フェーズ B 以前の合成: −μ_E r/|r|³(中心重力)+ 太陽・月の潮汐摂動 + J2。
// stepRK4 は中心重力を持たなくなったので、比較対象として本体から消えた式をここへ写経する。
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
  const j2 = yAxisJ2Accel(r);
  return add(add(add(central, sun), moon), j2);
}

export function register(): void {
  test('dynamics: stepDynamics(bcInv=0, thrust=null) matches a hand-written legacy central-gravity + third-body + J2 composition to machine precision', () => {
    const s0 = circularState();
    const dt = 10;
    const sunPos = v3(1.5e11, 0, 0);
    const moonPos = v3(3.8e8, 0, 0);
    const attractors: readonly Attractor[] = [
      EARTH,
      { id: 'moon', mu: MU_MOON, radius: R_MOON, state: kinematicState(0, moonPos, v3(0, 0, 0)), degree2: null },
      { id: 'sun', mu: MU_SUN, radius: R_SUN, state: kinematicState(0, sunPos, v3(0, 0, 0)), degree2: null },
    ];

    const viaNew = stepDynamics(s0, dt, attractors, 0, 0, 0, null);
    const viaLegacy = stepRK4(s0, dt, (rx, ry, rz) => legacyAccel(v3(rx, ry, rz), sunPos, moonPos));

    const posErr = len(sub(viaNew.r, viaLegacy.r)) / len(viaLegacy.r);
    const velErr = len(sub(viaNew.v, viaLegacy.v)) / len(viaLegacy.v);
    assert.ok(posErr < 1e-9, `position should match to machine precision: relative error ${posErr}`);
    assert.ok(velErr < 1e-9, `velocity should match to machine precision: relative error ${velErr}`);
  });

  test('dynamics: stepDynamics adds thrust on top of gravity', () => {
    const s0 = circularState();
    const dt = 10;
    const attractors = new Ephemeris({ moon: 0 }).attractorsAt(0);
    const thrust = v3(0, 0, 5); // 大きめの加速度で差が明確に出るようにする

    const withThrust = stepDynamics(s0, dt, attractors, 0, 0, 0, thrust);
    const withoutThrust = stepDynamics(s0, dt, attractors, 0, 0, 0, null);

    assert.ok(len(sub(withThrust.v, withoutThrust.v)) > 1, 'thrust should visibly change the velocity');
  });

  test('dynamics: stepDynamics with bcInv>0 decelerates more than bcInv=0 at LEO altitude', () => {
    const s0 = circularState();
    const dt = 10;
    const attractors = new Ephemeris({ moon: 0 }).attractorsAt(0);

    const noDrag = stepDynamics(s0, dt, attractors, 0, 0, 0, null);
    const withDrag = stepDynamics(s0, dt, attractors, 0.01, 0, 0, null);

    assert.ok(len(withDrag.v) < len(noDrag.v), 'drag should reduce orbital speed relative to the drag-free step');
  });

  test('dynamics: a circular lunar orbit (surface +100km) returns to about the same moon-relative position after one revolution (measured, pinned)', () => {
    const ephemeris = new Ephemeris({ moon: 0 });
    const attractors0 = ephemeris.attractorsAt(0);
    const moon0 = attractors0.find((b) => b.id === 'moon')!;
    const a = R_MOON + 100e3;
    const period = keplerPeriod(a, MU_MOON); // ~7,066s
    const rel0 = stateFromOrbitalElements(0, a, 0, (10 * Math.PI) / 180, 0, 0, 0, MU_MOON);
    let s = kinematicState(0, add(rel0.r, moon0.state.r), add(rel0.v, moon0.state.v));

    const dt = 5;
    const steps = Math.round(period / dt);
    for (let i = 0; i < steps; i++) {
      const attractors = ephemeris.attractorsAt(s.t + dt / 2);
      s = stepDynamics(s, dt, attractors, 0, 0, 0, null);
    }

    const relFinal = sub(s.r, ephemeris.positionOf('moon', s.t));
    const drift = len(sub(relFinal, rel0.r));
    // 地球(・太陽)の潮汐差ぶんの摂動がかかるので、月の二体問題の解には正確には戻らない。
    assert.ok(drift < 50e3, `moon-relative drift after 1 revolution: ${drift} m (expected within tens of km)`);
  });

  test('dynamics: stepRK4 circular orbit — 1 period position/energy error (measured, pinned)', () => {
    // 420km 円軌道、無摂動(中心重力のみ)。理論上は閉軌道に戻るはずだが、
    // 固定ステップ RK4 の打ち切り誤差が蓄積する。現状の実装でどの程度かを
    // 実測して基準値として固定する(将来ステップ幅やアルゴリズムを変えた際の
    // デグレ検知が目的で、理論的な許容誤差ではない)。
    const alt = 420e3;
    const r0 = R_EARTH + alt;
    const vCirc = Math.sqrt(MU_EARTH / r0);
    let s = kinematicState(0, v3(r0, 0, 0), v3(0, 0, vCirc));
    const period = 2 * Math.PI * Math.sqrt((r0 * r0 * r0) / MU_EARTH);
    const e0 = 0.5 * vCirc * vCirc - MU_EARTH / r0;

    const dt = 1; // 1秒刻み
    const steps = Math.round(period / dt);
    for (let i = 0; i < steps; i++) {
      s = stepRK4(s, dt, (rx, ry, rz) => legacyCentralGravity(v3(rx, ry, rz)));
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

  test('dynamics: degree2Accel RAAN regression rate at 420km/51.6deg ~= -5deg/day (measured)', () => {
    // J2 のみを追加加速度として与え、円軌道を長時間積分して RAAN のドリフト率を測る。
    // 標準的な太陽同期軌道の式(dRAAN/dt ~ -5deg/day at 51.6°/420km LEO)との一致は
    // CLAUDE.md に既述の設計目安。許容誤差は緩め(±10%)。
    const alt = 420e3;
    const incDeg = 51.6;
    const inc = (incDeg * Math.PI) / 180;
    const a = R_EARTH + alt;
    let s = stateFromOrbitalElements(0, a, 0, inc, 0, 0, 0, MU_EARTH);

    const dt = 10;
    const totalDays = 5;
    const totalSeconds = totalDays * 86400;
    const steps = Math.round(totalSeconds / dt);
    for (let i = 0; i < steps; i++) {
      s = stepRK4(s, dt, (rx, ry, rz) => {
        const r = v3(rx, ry, rz);
        return add(legacyCentralGravity(r), degree2Accel(r, MU_EARTH, EARTH_DEGREE2));
      });
    }

    const el = orbitalElementsOf(s, EARTH) as OrbitalElements;
    // RAAN(昇交点赤経) = atan2(hHat.x, -hHat.z) 的な導出でも良いが、ここでは
    // pHat/hHat から昇交点方向ベクトルを求め、その方位角(XZ平面, 基準X軸)を使う。
    // 昇交点方向 = Y(極軸) × hHat の正規化(軌道面と赤道面の交線)
    const hHat = el.hHat;
    const nodeVec = { x: hHat.z, y: 0, z: -hHat.x }; // Y × hHat
    // stateFromOrbitalElements の raan 引数と同じ回転規約(rotateAxis(X, Y, raan) は
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

  test('dynamics: degree2Accel with the pole on Y reproduces the Y-axis-only J2 formula to machine precision', () => {
    for (const r of [v3(6.8e6, 1.2e6, -3.1e6), v3(-2.2e6, 6.5e6, 1e5), v3(1e6, -1e6, 7e6)]) {
      const generalized = degree2Accel(r, MU_EARTH, EARTH_DEGREE2);
      const special = yAxisJ2Accel(r);
      const err = len(sub(generalized, special)) / len(special);
      assert.ok(err < 1e-12, `generalized J2 should match the Y-axis form: relative error ${err} at ${JSON.stringify(r)}`);
    }
  });

  test('dynamics: degree2Accel is equivariant under rotating both the position and the body axes', () => {
    // 極を Y に固定していた実装では確かめようのなかった性質。任意方向の極を正しく
    // 扱えていなければ、回した系での加速度は回した加速度に一致しない。
    const g: Degree2Gravity = {
      j2: J2_MOON, refRadius: R_MOON_GRAVITY, pole: norm(v3(0.1, 0.9, 0.2)),
      tesseral: { c22: C22_MOON, longAxis: norm(v3(0.95, -0.1, 0.05)) },
    };
    const r = v3(1.2e6, 0.7e6, -1.1e6);
    const axis = norm(v3(0.3, -0.6, 0.74));
    const angle = 0.937;

    const base = degree2Accel(r, MU_MOON, g);
    const rotated = degree2Accel(rot(r, axis, angle), MU_MOON, {
      ...g,
      pole: rot(g.pole, axis, angle),
      tesseral: { c22: g.tesseral!.c22, longAxis: rot(g.tesseral!.longAxis, axis, angle) },
    });

    const err = len(sub(rotated, rot(base, axis, angle))) / len(base);
    assert.ok(err < 1e-12, `degree2Accel should be equivariant under rotation: relative error ${err}`);
  });

  test('dynamics: degree2Accel agrees with the central difference of the degree-2 potential', () => {
    // C22 には J2 の昇交点歳差率のような閉じた永年変化率が無いので、ポテンシャルを
    // 別実装して数値微分したものを基準に取る。導出ミスと符号ミスの両方を捕まえる。
    const g: Degree2Gravity = {
      j2: J2_MOON, refRadius: R_MOON_GRAVITY, pole: norm(v3(0.05, 0.98, -0.19)),
      tesseral: { c22: C22_MOON, longAxis: norm(v3(0.9, 0.1, 0.42)) },
    };
    for (const r of [v3(1.9e6, 0.4e6, 0.3e6), v3(-0.6e6, 1.1e6, -1.5e6), v3(0.2e6, -1.8e6, 0.9e6)]) {
      const analytic = degree2Accel(r, MU_MOON, g);
      const numeric = numericalGradient((p) => degree2Potential(p, MU_MOON, g), r, 1);
      const err = len(sub(analytic, numeric)) / len(analytic);
      assert.ok(err < 1e-6, `analytic vs numerical gradient: relative error ${err} at ${JSON.stringify(r)}`);
    }
  });

  test('dynamics: the C22 contribution flips sign when the position rotates 90 degrees about the pole', () => {
    // 赤道断面の楕円性は cos2λ の2回対称性を持つので、経度が 90° 変わると符号が反転する。
    const pole = v3(0, 1, 0);
    const longAxis = v3(1, 0, 0);
    const axisymmetric: Degree2Gravity = { j2: J2_MOON, refRadius: R_MOON_GRAVITY, pole, tesseral: null };
    const withC22: Degree2Gravity = { ...axisymmetric, tesseral: { c22: C22_MOON, longAxis } };

    const alongAxis = v3(1.838e6, 0, 0);
    const quarterTurn = v3(0, 0, 1.838e6);
    const c22At = (r: Vec3) => sub(degree2Accel(r, MU_MOON, withC22), degree2Accel(r, MU_MOON, axisymmetric));

    const a = c22At(alongAxis);
    const b = c22At(quarterTurn);
    assert.ok(dot(a, norm(alongAxis)) * dot(b, norm(quarterTurn)) < 0, 'the radial C22 term should reverse over a quarter turn');
    assert.ok(Math.abs(len(a) - len(b)) / len(a) < 1e-9, 'the two quarter-turn positions should feel the same magnitude');
  });

  test('dynamics: a null tesseral leaves exactly the J2-only acceleration', () => {
    const pole = norm(v3(0.2, 0.95, -0.1));
    const j2Only: Degree2Gravity = { j2: J2_MOON, refRadius: R_MOON_GRAVITY, pole, tesseral: null };
    const zeroC22: Degree2Gravity = { ...j2Only, tesseral: { c22: 0, longAxis: norm(v3(1, 0, 0.3)) } };
    const r = v3(1.5e6, -0.8e6, 0.6e6);
    assert.deepEqual(degree2Accel(r, MU_MOON, zeroC22), degree2Accel(r, MU_MOON, j2Only));
  });

  test('dynamics: lunar J2 acceleration at a 100km lunar orbit is about 4.0e-4 m/s^2', () => {
    // 中心重力 1.45 m/s^2 に対する比 2.7e-4。低軌道での地球 J2 の比 1.4e-3 の約 1/5 で、
    // 数日スケールの昇交点歳差として観測できる大きさであることを固定する。
    const g: Degree2Gravity = {
      j2: J2_MOON, refRadius: R_MOON_GRAVITY, pole: v3(0, 1, 0), tesseral: null,
    };
    const r = v3(1.838e6, 0, 0); // 赤道上(極方向成分ゼロ)
    const mag = len(degree2Accel(r, MU_MOON, g));
    assert.ok(Math.abs(mag - 3.96e-4) / 3.96e-4 < 0.05, `lunar J2 magnitude: ${mag} m/s^2 (expected ~3.96e-4)`);
  });

  test('dynamics: stepDynamics applies solar radiation pressure only where the sun actually shines', () => {
    // 純関数 srpAccel が正しくても accel から呼ばれていなければ効かないので、積分側で確かめる。
    // 太陽を +X 1AU に置くと、+X 側の位置は日照、−X 側は地球の影の中に入る。
    const sunPos = v3(1.495978707e11, 0, 0);
    const attractors: readonly Attractor[] = [
      EARTH,
      { id: 'sun', mu: MU_SUN, radius: R_SUN, state: kinematicState(0, sunPos, v3(0, 0, 0)), degree2: null },
    ];
    const dt = 100;
    const srpCoeff = 1e-2;
    const penumbra = 6e4;
    const speed = Math.sqrt(MU_EARTH / 7e6);

    const sunlitStart = kinematicState(0, v3(7e6, 0, 0), v3(0, 0, speed));
    const withSrp = stepDynamics(sunlitStart, dt, attractors, 0, srpCoeff, penumbra, null);
    const withoutSrp = stepDynamics(sunlitStart, dt, attractors, 0, 0, penumbra, null);
    assert.ok(len(sub(withSrp.v, withoutSrp.v)) > 0, 'a sunlit object should feel solar radiation pressure');

    const umbraStart = kinematicState(0, v3(-7e6, 0, 0), v3(0, 0, speed));
    const shadowedWith = stepDynamics(umbraStart, dt, attractors, 0, srpCoeff, penumbra, null);
    const shadowedWithout = stepDynamics(umbraStart, dt, attractors, 0, 0, penumbra, null);
    assert.deepEqual(shadowedWith, shadowedWithout, 'an object in the umbra should feel nothing');
  });

  test('dynamics: the moon carries a degree-2 field and the sun does not', () => {
    const attractors = new Ephemeris({ moon: 0.3 }).attractorsAt(1234);
    const moon = attractors.find((b) => b.id === 'moon')!;
    const sun = attractors.find((b) => b.id === 'sun')!;
    assert.ok(moon.degree2 !== null, 'the moon should resolve a degree-2 field');
    assert.ok(moon.degree2!.tesseral !== null, 'the moon should not be treated as axisymmetric');
    assert.equal(sun.degree2, null, 'the sun should stay a point mass');
    // 基準半径は地形としての表面半径とは別の量なので、取り違えていないことを確かめる。
    assert.equal(moon.degree2!.refRadius, R_MOON_GRAVITY);
    assert.notEqual(moon.degree2!.refRadius, R_MOON);
  });
}
