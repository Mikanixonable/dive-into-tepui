// elements.ts の回帰テスト。ケプラー要素⇄状態ベクトルの往復精度は理論上「機械精度」であるべき
// 値(解析的往復)。
import * as assert from 'node:assert/strict';
import { test } from './harness';
import {
  OrbitalElements,
  eccentricAnomalyFromMean,
  keplerPeriod,
  nodeAnomalies,
  positionOnOrbit,
  semiMajorFromPeriod,
  stateFromOrbitalElements,
  timeSincePeriapsis,
  tofBetween,
  trueAnomalyAt,
  velocityOnOrbit,
} from '../../src/physics/elements';
import { Attractor, orbitalElementsOf } from '../../src/physics/attractor';
import { kinematicState } from '../../src/physics/kinematic-state';
import { MU_EARTH, R_EARTH } from '../../src/physics/solar-system';
import { MU_MOON } from '../../src/physics/solar-system';
import { dot, len, norm, sub, v3 } from '../../src/physics/vec3';

const EARTH: Attractor = { id: 'earth', mu: MU_EARTH, radius: R_EARTH, state: kinematicState(0, v3(0, 0, 0), v3(0, 0, 0)), degree2: null };

export function register(): void {
  test('elements: stateFromOrbitalElements <-> orbitalElementsFromState round trip (machine precision)', () => {
    const a = R_EARTH + 500e3;
    const e = 0.05;
    const inc = (51.6 * Math.PI) / 180;
    const raan = 0.7;
    const argp = 1.1;
    const nu = 2.3;
    const s = stateFromOrbitalElements(0, a, e, inc, raan, argp, nu, MU_EARTH);
    const el = orbitalElementsOf(s, EARTH);
    assert.ok(el, 'orbitalElementsFromState should not be null for a bound elliptical orbit');
    const elx = el as OrbitalElements;
    assert.ok(Math.abs(elx.a - a) / a < 1e-9, `a round trip: ${elx.a} vs ${a}`);
    assert.ok(Math.abs(elx.e - e) < 1e-9, `e round trip: ${elx.e} vs ${e}`);
    assert.ok(
      Math.abs(elx.incDeg - (inc * 180) / Math.PI) < 1e-7,
      `inc round trip: ${elx.incDeg}`,
    );
  });

  test('elements: keplerPeriod <-> semiMajorFromPeriod round trip (Earth mu)', () => {
    const a = R_EARTH + 420e3;
    const period = keplerPeriod(a, MU_EARTH);
    const a2 = semiMajorFromPeriod(period, MU_EARTH);
    assert.ok(Math.abs(a2 - a) / a < 1e-9, `a round trip: ${a2} vs ${a}`);
  });

  test('elements: keplerPeriod <-> semiMajorFromPeriod round trip (Moon mu)', () => {
    const a = 2000e3;
    const period = keplerPeriod(a, MU_MOON);
    const a2 = semiMajorFromPeriod(period, MU_MOON);
    assert.ok(Math.abs(a2 - a) / a < 1e-9, `a round trip: ${a2} vs ${a}`);
  });

  test('elements: trueAnomalyAt / positionOnOrbit / velocityOnOrbit round trip', () => {
    const a = R_EARTH + 800e3;
    const e = 0.02;
    const inc = (28 * Math.PI) / 180;
    const s0 = stateFromOrbitalElements(0, a, e, inc, 0.3, 0.5, 0.9, MU_EARTH);
    const el = orbitalElementsOf(s0, EARTH) as OrbitalElements;
    const nu = trueAnomalyAt(el, s0.r);
    assert.ok(Math.abs(nu - 0.9) < 1e-7, `trueAnomalyAt recovers nu: ${nu}`);
    const r2 = positionOnOrbit(el, nu);
    const v2 = velocityOnOrbit(el, nu);
    assert.ok(len(sub(r2, s0.r)) / len(s0.r) < 1e-9, 'positionOnOrbit matches original r');
    assert.ok(len(sub(v2, s0.v)) / len(s0.v) < 1e-9, 'velocityOnOrbit matches original v');
  });

  test('elements: nodeAnomalies picks the textbook ascending direction (n = planeNormal x hHat)', () => {
    // i=45°/Ω=0°/ω=0° の軌道。基準面法線を ECI の極(Y軸)に取ると、昇交点は +X 方向で、
    // そこでの速度は +Y 成分を持つ(南半球から北半球へ抜ける = 昇交点)はず。
    const a = R_EARTH + 500e3;
    const s0 = stateFromOrbitalElements(0, a, 0.05, (45 * Math.PI) / 180, 0, 0, 0, MU_EARTH);
    const el = orbitalElementsOf(s0, EARTH) as OrbitalElements;
    const nodes = nodeAnomalies(el, v3(0, 1, 0));
    assert.ok(nodes, 'nodeAnomalies should resolve for an inclined orbit against the pole');
    const ascPos = norm(positionOnOrbit(el, nodes!.asc));
    assert.ok(len(sub(ascPos, v3(1, 0, 0))) < 1e-9, `ascending node points +X: ${JSON.stringify(ascPos)}`);
    const ascVel = velocityOnOrbit(el, nodes!.asc);
    assert.ok(ascVel.y > 0, `velocity at ascending node points toward +Y: ${ascVel.y}`);
  });

  test('elements: nodeAnomalies ascending/descending nodes are antipodal', () => {
    const a = R_EARTH + 700e3;
    const s0 = stateFromOrbitalElements(0, a, 0.1, (60 * Math.PI) / 180, 0.4, 0.2, 0, MU_EARTH);
    const el = orbitalElementsOf(s0, EARTH) as OrbitalElements;
    const nodes = nodeAnomalies(el, v3(0, 1, 0));
    assert.ok(nodes);
    const ascDir = norm(positionOnOrbit(el, nodes!.asc));
    const descDir = norm(positionOnOrbit(el, nodes!.desc));
    assert.ok(dot(ascDir, descDir) < -1 + 1e-9, `nodes point in opposite directions: dot=${dot(ascDir, descDir)}`);
  });

  test('elements: nodeAnomalies returns null when the orbit plane matches the reference plane', () => {
    const a = R_EARTH + 500e3;
    const s0 = stateFromOrbitalElements(0, a, 0.05, (30 * Math.PI) / 180, 0.6, 0.3, 0, MU_EARTH);
    const el = orbitalElementsOf(s0, EARTH) as OrbitalElements;
    assert.equal(nodeAnomalies(el, el.hHat), null, 'coincident planes have no well-defined line of nodes');
  });

  test('elements: nodeAnomalies is finite for a near-circular orbit', () => {
    const a = R_EARTH + 500e3;
    const s0 = stateFromOrbitalElements(0, a, 0, (45 * Math.PI) / 180, 0.2, 0, 0, MU_EARTH);
    const el = orbitalElementsOf(s0, EARTH) as OrbitalElements;
    const nodes = nodeAnomalies(el, v3(0, 1, 0));
    assert.ok(nodes, 'nodeAnomalies should resolve for a circular orbit');
    assert.ok(isFinite(nodes!.asc) && isFinite(nodes!.desc), `finite anomalies: ${JSON.stringify(nodes)}`);
  });

  test('elements: tofBetween(nu, nu) == 0 and tofBetween is period-periodic', () => {
    const a = R_EARTH + 500e3;
    const s0 = stateFromOrbitalElements(0, a, 0.01, 0.9, 0, 0, 0, MU_EARTH);
    const el = orbitalElementsOf(s0, EARTH) as OrbitalElements;
    assert.equal(tofBetween(el, 1.2, 1.2), 0);
    const tHalf = tofBetween(el, 0, Math.PI);
    // 半周の飛行時間はほぼ半周期(離心率が小さいため近似的に対称)
    assert.ok(
      Math.abs(tHalf - el.period / 2) / el.period < 1e-3,
      `half-period tof ~= period/2: ${tHalf} vs ${el.period / 2}`,
    );
  });

  test('elements: timeSincePeriapsis(nu=0) == 0', () => {
    const a = R_EARTH + 500e3;
    const s0 = stateFromOrbitalElements(0, a, 0.1, 0.5, 0, 0, 0, MU_EARTH);
    const el = orbitalElementsOf(s0, EARTH) as OrbitalElements;
    assert.equal(timeSincePeriapsis(el, 0), 0);
  });

  test('elements: timeSincePeriapsis on a hyperbolic orbit (e >= 1)', () => {
    // 近地点高度 500km、離心率 1.5 の双曲線軌道。
    const rp = R_EARTH + 500e3;
    const e = 1.5;
    const a = rp / (1 - e); // 双曲線なので a < 0
    const s0 = stateFromOrbitalElements(0, a, e, 0.3, 0, 0, 0, MU_EARTH); // nu=0 = 近点
    const el = orbitalElementsOf(s0, EARTH) as OrbitalElements;
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

  test('elements: eccentricAnomalyFromMean <-> M round trip at high eccentricity (Halley e=0.967)', () => {
    const e = 0.967;
    for (let i = 0; i < 200; i++) {
      const m = -Math.PI + (2 * Math.PI * i) / 200;
      const E = eccentricAnomalyFromMean(m, e);
      const mBack = E - e * Math.sin(E);
      const err = Math.atan2(Math.sin(mBack - m), Math.cos(mBack - m));
      assert.ok(Math.abs(err) < 1e-10, `M round trip at m=${m}: err=${err}`);
    }
  });

  test('elements: eccentricAnomalyFromMean <-> M round trip at high eccentricity (Encke e=0.848)', () => {
    const e = 0.848;
    for (let i = 0; i < 200; i++) {
      const m = -Math.PI + (2 * Math.PI * i) / 200;
      const E = eccentricAnomalyFromMean(m, e);
      const mBack = E - e * Math.sin(E);
      const err = Math.atan2(Math.sin(mBack - m), Math.cos(mBack - m));
      assert.ok(Math.abs(err) < 1e-10, `M round trip at m=${m}: err=${err}`);
    }
  });

  test('elements: eccentricAnomalyFromMean round trip at low eccentricity unchanged', () => {
    for (const e of [0.0167, 0.2]) {
      for (let i = 0; i < 50; i++) {
        const m = -Math.PI + (2 * Math.PI * i) / 50;
        const E = eccentricAnomalyFromMean(m, e);
        const mBack = E - e * Math.sin(E);
        const err = Math.atan2(Math.sin(mBack - m), Math.cos(mBack - m));
        assert.ok(Math.abs(err) < 1e-12, `low-e round trip at e=${e}, m=${m}: err=${err}`);
      }
    }
  });

  test('elements: eccentricAnomalyFromMean converges near periapsis at extreme eccentricity (e=0.99, M~0)', () => {
    const e = 0.99;
    for (const m of [0, 1e-6, -1e-6, 1e-3]) {
      const E = eccentricAnomalyFromMean(m, e);
      assert.ok(Number.isFinite(E), `E should be finite at m=${m}, e=${e}: ${E}`);
      const mBack = E - e * Math.sin(E);
      const err = Math.atan2(Math.sin(mBack - m), Math.cos(mBack - m));
      assert.ok(Math.abs(err) < 1e-10, `round trip near periapsis at m=${m}: err=${err}`);
    }
  });
}
