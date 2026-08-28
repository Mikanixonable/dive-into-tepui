// kepler-orbit.ts の回帰テスト。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { assertOmegaMatchesBasis } from './test-helpers';
import { OrbitalElements, keplerPeriod, timeSincePeriapsis, trueAnomalyFromMean } from '../../src/physics/elements';
import { CelestialBody } from '../../src/physics/celestial-body';
import { ECLIPTIC_BASIS, KeplerOrbit, keplerOrbitNormal, keplerOrbitRotation, keplerOrbitState } from '../../src/physics/kepler-orbit';
import { kinematicState } from '../../src/physics/kinematic-state';
import { MU_EARTH, R_EARTH } from '../../src/physics/solar-system';
import { qRotate } from '../../src/physics/attitude';
import { dot, len, scale, sub, v3 } from '../../src/math/vec3';

const EARTH: CelestialBody = { id: 'earth', mu: MU_EARTH, radius: R_EARTH, state: kinematicState(0, v3(0, 0, 0), v3(0, 0, 0)), accel: v3(), degree2: null, atmosphere: null, isStar: false };

// 永年変化率をすべて 0 にした固定楕円(比較用)。
const STATIC_ORBIT: KeplerOrbit = {
  basisToEci: ECLIPTIC_BASIS,
  a: R_EARTH + 500e3,
  aRate: 0,
  e: 0.05,
  eRate: 0,
  inc: (28 * Math.PI) / 180,
  incRate: 0,
  raan0: 0.4,
  raanRate: 0,
  lonPeri0: 0.9,
  lonPeriRate: 0,
  l0: 1.2,
  lRate: (2 * Math.PI) / keplerPeriod(R_EARTH + 500e3, MU_EARTH),
};

// 地球の公転規模(1年周期)に、地球相当の世紀あたり永年変化率(ȧ/i̇/ė)を載せた軌道。
const AU = 1.495978707e11;
const EARTH_A = AU;
const PLANET_LIKE_ORBIT: KeplerOrbit = {
  basisToEci: ECLIPTIC_BASIS,
  a: EARTH_A,
  aRate: (0.00000562 * AU) / (100 * 365.25 * 86400),
  e: 0.01671123,
  eRate: -4.392e-5 / (100 * 365.25 * 86400),
  inc: 0,
  incRate: (-0.01294668 * Math.PI) / 180 / (100 * 365.25 * 86400),
  raan0: 0,
  raanRate: 0,
  lonPeri0: (102.93768 * Math.PI) / 180,
  lonPeriRate: ((0.32327364 * Math.PI) / 180) / (100 * 365.25 * 86400),
  l0: 1.2,
  lRate: (2 * Math.PI) / keplerPeriod(EARTH_A, MU_EARTH),
};

// 月の昇交点逆行・近点順行に相当する、大きな raanRate/lonPeriRate を持つ軌道
// (歳差ぶんの寄与を無視すると解析速度が中心差分から大きくずれる、を検出する)。
const NODE_PRECESSING_ORBIT: KeplerOrbit = {
  ...STATIC_ORBIT,
  raanRate: -(2 * Math.PI) / (18.612958 * 365.25 * 86400),
  lonPeriRate: (2 * Math.PI) / (8.85 * 365.25 * 86400),
};

// dt は軌道の公転周期に対して十分小さく取る(中心差分の打切り誤差は dt² で効く)。
function checkVelocityMatchesCentralDiff(orbit: KeplerOrbit, t: number, dt: number): void {
  const s = keplerOrbitState(orbit, t, 0.3);
  const sPlus = keplerOrbitState(orbit, t + dt, 0.3);
  const sMinus = keplerOrbitState(orbit, t - dt, 0.3);
  const vFd = scale(sub(sPlus.r, sMinus.r), 1 / (2 * dt));
  const relErr = len(sub(vFd, s.v)) / len(s.v);
  assert.ok(relErr < 1e-6, `速度と位置の中心差分の不一致 (t=${t}): ${relErr}`);
}

export function register(): void {
  test('kepler-orbit: eccentricAnomalyFromMean/trueAnomalyFromMean は timeSincePeriapsis の逆写像になる(機械精度)', () => {
    const a = R_EARTH + 500e3;
    for (const e of [0, 0.0549, 0.3]) {
      const el: OrbitalElements = {
        a, e, p: a * (1 - e * e), incDeg: 0, period: keplerPeriod(a, MU_EARTH),
        pHat: v3(1, 0, 0), qHat: v3(0, 1, 0), hHat: v3(0, 0, 1), center: EARTH,
      };
      const n = (2 * Math.PI) / el.period;
      for (const nu0 of [-2.5, -1, 0, 0.7, 2.9]) {
        const M = timeSincePeriapsis(el, nu0) * n;
        const nu = trueAnomalyFromMean(M, e);
        const diff = Math.atan2(Math.sin(nu - nu0), Math.cos(nu - nu0));
        assert.ok(Math.abs(diff) < 1e-9, `e=${e}, nu0=${nu0}: ${diff}`);
      }
    }
  });

  test('kepler-orbit: keplerOrbitState の速度は位置の中心差分に一致する(固定楕円・相対1e-6)', () => {
    for (const t of [0, 1e5, 1e7]) checkVelocityMatchesCentralDiff(STATIC_ORBIT, t, 1);
  });

  test('kepler-orbit: keplerOrbitState の速度は位置の中心差分に一致する(惑星規模の永年変化・相対1e-6)', () => {
    for (const t of [0, 1e8, 1e9]) checkVelocityMatchesCentralDiff(PLANET_LIKE_ORBIT, t, 600);
  });

  test('kepler-orbit: keplerOrbitState の速度は位置の中心差分に一致する(昇交点・近点が歳差する軌道・相対1e-6)', () => {
    // 歳差(omega×r)の寄与を解析速度から落とすと、この軌道では相対誤差が 1e-3 級まで開く。
    for (const t of [0, 1e6, 1e8]) checkVelocityMatchesCentralDiff(NODE_PRECESSING_ORBIT, t, 1);
  });

  test('kepler-orbit: keplerOrbitRotation の角速度は基底の時間微分に一致する(有限差分)', () => {
    for (const t of [0, 1e6, 1e8]) {
      assertOmegaMatchesBasis((s) => keplerOrbitRotation(NODE_PRECESSING_ORBIT, s, 0.3), t, 2);
    }
  });

  test('kepler-orbit: keplerOrbitRotation の角速度は基底の時間微分に一致する(惑星規模の永年変化を含む)', () => {
    for (const t of [0, 1e8, 1e9]) {
      assertOmegaMatchesBasis((s) => keplerOrbitRotation(PLANET_LIKE_ORBIT, s, 0.3), t, 600);
    }
  });

  test('kepler-orbit: keplerOrbitRotation の x̂ は keplerOrbitState の位置方向に一致する', () => {
    for (const t of [0, 1e6, 1e8]) {
      const s = keplerOrbitState(NODE_PRECESSING_ORBIT, t, 0.3);
      const { q } = keplerOrbitRotation(NODE_PRECESSING_ORBIT, t, 0.3);
      const xHat = qRotate(q, v3(1, 0, 0));
      const rHat = scale(s.r, 1 / len(s.r));
      assert.ok(len(sub(xHat, rHat)) < 1e-9, `x̂ の像が位置方向と一致しない (t=${t})`);
    }
  });

  test('kepler-orbit: keplerOrbitNormal は keplerOrbitState の位置ベクトルと直交する', () => {
    for (const t of [0, 1e6, 1e8]) {
      const s = keplerOrbitState(NODE_PRECESSING_ORBIT, t, 0.3);
      const normal = keplerOrbitNormal(NODE_PRECESSING_ORBIT, t, 0.3);
      const c = dot(scale(s.r, 1 / len(s.r)), normal);
      assert.ok(Math.abs(c) < 1e-9, `位置ベクトルが軌道面法線と直交しない (t=${t}): ${c}`);
    }
  });
}
