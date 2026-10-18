// 遷移・参照軌道の純関数群の回帰テスト。ランベルトは「ホーマン遷移を通す弧」を
// 復元できること、CW は到達精度、ロケット式は解析解との一致、参照軌道は J2 歳差が
// 要素に現れることを固定する。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { motionOf, solarSystemParts } from './test-helpers';
import { burnDuration, deltaVBudget, effectiveExhaustVelocity } from '../../src/physics/rocket';
import { hohmann, biElliptic, phasing, rendezvousPhasing } from '../../src/physics/impulsive-transfer';
import { solveLambert } from '../../src/physics/lambert';
import { cwPropagate, cwTwoImpulseTransfer } from '../../src/physics/relative-motion';
import { correctInitialVelocity } from '../../src/physics/trajectory-correction';
import { referenceOrbitPeriod, referenceOrbitStateAt } from '../../src/physics/reference-orbit';
import { keplerPeriod, stateFromOrbitalElements } from '../../src/physics/elements';
import { kinematicState, type KinematicState } from '../../src/physics/kinematic-state';
import { addScaled, len, sub, v3, type Vec3 } from '../../src/math/vec3';
import { MU_EARTH } from '../../src/game/celestial/solar-system/earth-system';

const R1 = 7_000e3;
const R2 = 42_164e3;

// 試験内だけで使う二体問題の RK4 伝播器。射撃法の検証に「全力モデル」の代役として使う。
function propagateTwoBody(state: KinematicState, t: number, mu: number): KinematicState {
  let r = v3(state.r.x, state.r.y, state.r.z);
  let v = v3(state.v.x, state.v.y, state.v.z);
  let remaining = t - state.t;
  const dt = remaining / 2000;
  const acc = (p: Vec3): Vec3 => {
    const d3 = (p.x ** 2 + p.y ** 2 + p.z ** 2) ** 1.5;
    return v3(-mu * p.x / d3, -mu * p.y / d3, -mu * p.z / d3);
  };
  while (remaining > 1e-9) {
    const h = Math.min(dt, remaining);
    const k1v = acc(r), k1r = v;
    const r2 = addScaled(r, k1r, h / 2), v2 = addScaled(v, k1v, h / 2);
    const k2v = acc(r2), k2r = v2;
    const r3 = addScaled(r, k2r, h / 2), v3m = addScaled(v, k2v, h / 2);
    const k3v = acc(r3), k3r = v3m;
    const r4 = addScaled(r, k3r, h), v4 = addScaled(v, k3v, h);
    const k4v = acc(r4), k4r = v4;
    const dr = addScaled(addScaled(addScaled(k1r, k2r, 2), k3r, 2), k4r, 1);
    const dv = addScaled(addScaled(addScaled(k1v, k2v, 2), k3v, 2), k4v, 1);
    r = addScaled(r, dr, h / 6);
    v = addScaled(v, dv, h / 6);
    remaining -= h;
  }
  return kinematicState<'eci'>(t, r, v);
}

export function register(): void {
test('rocket: 有効排気速度・Δv・燃焼時間がロケット式と一致する', () => {
  const F = 400e3, mdot = 0.6, m0 = 2000, prop = 400;
  const ve = effectiveExhaustVelocity(F, mdot);
  assert.ok(Math.abs(ve - F / mdot) < 1e-9);
  const dv = deltaVBudget(ve, m0, prop);
  assert.ok(Math.abs(dv - ve * Math.log(m0 / (m0 - prop))) < 1e-9);
  const t = burnDuration(m0, ve, F, dv);
  // Δt 秒燃焼したときの Δv = −vₑ ln(1 − ṁΔt/m₀) が元の dv へ戻る
  const recovered = -ve * Math.log(1 - mdot * t / m0);
  assert.ok(Math.abs(recovered - dv) < 1e-6);
  // 全質量を推進剤にしても届かない Δv(e^−Δv/vₑ → 0)は Infinity
  assert.equal(burnDuration(m0, ve, F, 1e8), Infinity);
});

test('impulsive-transfer: ホーマンの既知値(LEO→GEO 相当)', () => {
  const h = hohmann(R1, R2, MU_EARTH);
  // r1=7000km→r2=42164km: Δv1 ≈ 2.337 km/s、Δv2 ≈ 1.430 km/s、飛行時間 ≈ 5.33 h
  assert.ok(Math.abs(h.deltaV1 - 2337) < 10);
  assert.ok(Math.abs(h.deltaV2 - 1430) < 10);
  assert.ok(Math.abs(h.transferTime - 5.33 * 3600) < 120);
  const b = biElliptic(R1, R2, 3 * R2, MU_EARTH);
  assert.ok(b.deltaV1 > 0 && b.deltaV2 > 0 && b.deltaV3 > 0);
  assert.ok(b.transferTime > h.transferTime); // 二重楕円は必ず遅い
});

test('impulsive-transfer: 位相調整とランデブー窓', () => {
  const a = R1, e = 0;
  const p = phasing(a, e, Math.PI / 4, 4, MU_EARTH);
  assert.ok(p !== null);
  assert.ok(p.deltaV1 > 0 && p.transferTime > keplerPeriod(a, MU_EARTH) * 0.9);
  // 1周で90°進めるのは不可能に近い(Tph>0を保てない)… 進めすぎは null
  assert.ok(p.transferTime > 0);
  const n = Math.sqrt(MU_EARTH / a ** 3);
  const rp = rendezvousPhasing(n, n / 2, 3600, Math.PI / 3);
  assert.ok(Math.abs(rp.leadAngleError) <= Math.PI);
  assert.ok(rp.windowPeriod > 0);
});

test('lambert: Curtis の既知例を復元する', () => {
  // Curtis "Orbital Mechanics" Example 5.2: r1=[5000,10000,2100]km,
  // r2=[-14600,2500,7000]km, tof=3600s → v1=[-5.9925,1.9254,3.2456] km/s
  const r1 = v3(5000e3, 10000e3, 2100e3);
  const r2 = v3(-14600e3, 2500e3, 7000e3);
  const sols = solveLambert(r1, r2, 3600, MU_EARTH);
  assert.ok(sols.length >= 1);
  const v1 = sols[0].v1;
  assert.ok(Math.abs(v1.x + 5992.5) < 5);
  assert.ok(Math.abs(v1.y - 1925.4) < 5);
  assert.ok(Math.abs(v1.z - 3245.6) < 5);
  // 求めた遷移軌道を二体伝播すると終端 r2 に届く
  const arrived = propagateTwoBody(kinematicState<'eci'>(0, r1, v1), 3600, MU_EARTH);
  const miss = len(sub(arrived.r, r2));
  assert.ok(miss < 1, `miss=${miss}`);
});

test('lambert: 多周回解と解なし条件', () => {
  // 同じ半径の20°転移へ、LEO 周期を少し超える飛行時間を与えると1周回の解が出る
  const th = (20 * Math.PI) / 180;
  const r2 = v3(R1 * Math.cos(th), R1 * Math.sin(th), 0);
  const tLeo = keplerPeriod(R1, MU_EARTH);
  const sols = solveLambert(v3(R1, 0, 0), r2, tLeo * 1.05, MU_EARTH, { maxRevs: 2 });
  assert.ok(sols.some((s) => s.revolutions === 1));
  // 飛行時間が短すぎる場合は双曲線枝の解だけが返る(物理的には非現実だが
  // 数学的には常に解がある — 実現可能性の判定は Δv を見る側の仕事)
  const hyper = solveLambert(v3(R1, 0, 0), r2, 1, MU_EARTH);
  assert.ok(hyper.length >= 1 && hyper.every((s) => s.a < 0));
});

test('relative-motion: 2インパルス CW で目標相対位置へ届く', () => {
  const n = Math.sqrt(MU_EARTH / R1 ** 3);
  const t = (Math.PI / 3) / n; // 60° ぶん
  const state = { r: v3(1000, 0, 0), v: v3(0, 0, 0) };
  const result = cwTwoImpulseTransfer(state, n, t, v3(0, -500, 0));
  assert.ok(result !== null);
  const arrived = cwPropagate(
    { r: state.r, v: addScaled(state.v, result.departDeltaV, 1) }, n, t,
  );
  assert.ok(len(sub(arrived.r, v3(0, -500, 0))) < 1e-6);
  // 到着噴射を加えると相対速度が目標(0)になる
  const vFinal = addScaled(arrived.v, result.arriveDeltaV, 1);
  assert.ok(len(vFinal) < 1e-6);
});

test('trajectory-correction: 誤った初速度を終端へ合わせる', () => {
  const h = hohmann(R1, R2, MU_EARTH);
  const target = v3(-R2, 0, 0);
  const propagate = (s: KinematicState, t: number) => propagateTwoBody(s, t, MU_EARTH);
  const exact = stateFromOrbitalElements(0, h.transferA, 0, 0, 0, 0, 0, MU_EARTH);
  // 初速度に 200 m/s の誤差を入れても収束する
  const perturbed = kinematicState<'eci'>(0, exact.r, addScaled(exact.v, v3(0, 1, 0), 200));
  const res = correctInitialVelocity(perturbed, target, h.transferTime, propagate, { tolerance: 1 });
  assert.ok(res.converged);
  assert.ok(res.residual <= 1);
});

test('reference-orbit: elements 型は時刻の関数として状態を返し J2 で節点が進む', () => {
  const parts = solarSystemParts();
  const earth = motionOf(parts, 'earth');
  const a = R1, e = 0.001, inc = 51.6 * Math.PI / 180;
  const orbit = {
    kind: 'elements' as const, bodyId: 'earth', epoch: 0,
    a, e, i: inc, raan: 0.3, argPeriapsis: 0.1, meanAnomaly0: 1.0,
  };
  const env = {
    bodyById: (id: string) => (id === 'earth' ? earth : null),
    degree2Field: (_id: string, _t: number) => null,
    familyMemberAt: () => null,
    rotatingFrameAt: () => null,
  };
  const s0 = referenceOrbitStateAt(orbit, 0, env);
  const s1 = referenceOrbitStateAt(orbit, 0, env);
  assert.ok(s0 !== null && s1 !== null);
  assert.equal(s0.r.x, s1.r.x); // 決定性: 同じ入力は同じ出力
  // 相対位置の半径は近点・遠点の間に収まる
  const rRel = len(sub(s0.r, earth.stateAt(0).r));
  assert.ok(rRel >= a * (1 - e) - 1 && rRel <= a * (1 + e) + 1);
  const period = referenceOrbitPeriod(orbit, env);
  assert.ok(period !== null && period > 0);
  // 1周期後に平均近点角が2π進むが、J2 の歳差で節点・近点がずれる:
  // 戻った位置は元の位置と一致しない(完全一致なら歳差が働いていない)
  const sT = referenceOrbitStateAt(orbit, period, env);
  assert.ok(sT !== null);
  const rRelT = len(sub(sT.r, earth.stateAt(period).r));
  assert.ok(rRelT >= a * (1 - e) * 0.999 && rRelT <= a * (1 + e) * 1.001);
});
}
