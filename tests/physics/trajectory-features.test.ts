// trajectory-features.ts の回帰テスト。解析的なケプラー軌道をサンプリングした列に対して、
// 折れ線走査/隣接ステップ判定が解析値と十分一致することを確認する。
import * as assert from 'node:assert/strict';
import { test } from './harness';
import { Attractor } from '../../src/physics/attractor';
import { apsisCrossing, ApsisTrack, findEquatorCrossings } from '../../src/physics/trajectory-features';
import { keplerPeriod, stateFromOrbitalElements, trueAnomalyFromMean } from '../../src/physics/elements';
import { kinematicState, KinematicState } from '../../src/physics/kinematic-state';
import { MU_EARTH, R_EARTH } from '../../src/physics/solar-system';
import { len, sub, v3 } from '../../src/physics/vec3';

const EARTH: Attractor = { id: 'earth', mu: MU_EARTH, radius: R_EARTH, state: kinematicState(0, v3(0, 0, 0), v3(0, 0, 0)), degree2: null, isStar: false };

// a/e/inc/raan/argp のケプラー軌道を、真近点角を等間隔に刻んで(粗く)サンプリングする。
// 開始位相をわずかにずらすのは、近地点(nu=0)ぴったりが列の端に来ると走査が端点を
// 候補から外すため(走査は隣接3点の符号パターンで極値を判定する)。
function sampleKeplerOrbit(a: number, e: number, incDeg: number, raan: number, argp: number, n: number): KinematicState[] {
  const inc = (incDeg * Math.PI) / 180;
  const phase = 0.3;
  const out: KinematicState[] = [];
  for (let i = 0; i <= n; i++) {
    const nu = phase + (2 * Math.PI * i) / n;
    const s = stateFromOrbitalElements(i, a, e, inc, raan, argp, nu, MU_EARTH);
    out.push(s);
  }
  return out;
}

// 平均近点角 m [rad] に対応するケプラー軌道上の状態を、経過時間 t も含めて正しく作る。
// apsisCrossing の精密化は hermiteInterpolate(接線に速度を使う)を挟むので、t が実際の
// 力学と整合していないと補間誤差が乗る — そのため nu を直接指定せず、m から
// trueAnomalyFromMean で nu を、周期から t を、それぞれ導出する。
function stateAtMeanAnomaly(a: number, e: number, incDeg: number, raan: number, argp: number, m: number): KinematicState {
  const inc = (incDeg * Math.PI) / 180;
  const period = keplerPeriod(a, MU_EARTH);
  const nu = trueAnomalyFromMean(m, e);
  const t = (m / (2 * Math.PI)) * period;
  return stateFromOrbitalElements(t, a, e, inc, raan, argp, nu, MU_EARTH);
}

export function register(): void {
  const a = R_EARTH + 800e3;
  const e = 0.05;
  const incDeg = 51.6;
  const raan = 0.3;
  const argp = 1.1;
  // 隣接ステップの間隔。実際の積分の1ステップに相当する程度に小さく取る — アプシス走査が
  // 荒いサンプルの局所極値ではなく、真に隣接する1ステップの符号反転を見る設計であることを
  // 確かめたいので、粗い1/100周回間隔ではなくこの程度の細かさを使う。
  const dm = 0.02;

  test('trajectory-features: apsisCrossing finds periapsis between consecutive states straddling nu=0', () => {
    const prev = stateAtMeanAnomaly(a, e, incDeg, raan, argp, -dm);
    const next = stateAtMeanAnomaly(a, e, incDeg, raan, argp, dm);
    const result = apsisCrossing(EARTH, prev, next);
    assert.ok(result, 'periapsis crossing should be detected');
    assert.equal(result!.kind, 'periapsis');
    const expected = stateFromOrbitalElements(0, a, e, (incDeg * Math.PI) / 180, raan, argp, 0, MU_EARTH).r;
    // ブラケットが十分狭いので、精密化後の誤差は1kmを大きく下回るはず。
    assert.ok(len(sub(result!.state.r, expected)) < 1000, `periapsis position error: ${len(sub(result!.state.r, expected))} m`);
  });

  test('trajectory-features: apsisCrossing finds apoapsis between consecutive states straddling nu=pi', () => {
    const prev = stateAtMeanAnomaly(a, e, incDeg, raan, argp, Math.PI - dm);
    const next = stateAtMeanAnomaly(a, e, incDeg, raan, argp, Math.PI + dm);
    const result = apsisCrossing(EARTH, prev, next);
    assert.ok(result, 'apoapsis crossing should be detected');
    assert.equal(result!.kind, 'apoapsis');
    const expected = stateFromOrbitalElements(0, a, e, (incDeg * Math.PI) / 180, raan, argp, Math.PI, MU_EARTH).r;
    assert.ok(len(sub(result!.state.r, expected)) < 1000, `apoapsis position error: ${len(sub(result!.state.r, expected))} m`);
  });

  test('trajectory-features: apsisCrossing returns null when the pair stays on one leg (no sign change)', () => {
    // どちらも遠地点手前(まだ遠ざかり続けている脚)で、近地点にも遠地点にもまたがらない対。
    const prev = stateAtMeanAnomaly(a, e, incDeg, raan, argp, Math.PI / 4);
    const next = stateAtMeanAnomaly(a, e, incDeg, raan, argp, Math.PI / 2);
    assert.equal(apsisCrossing(EARTH, prev, next), null);
  });

  test('trajectory-features: apsisCrossing returns null for a monotonically approaching pair (no crossing yet)', () => {
    // 近地点の手前、動径速度が両端とも負(接近し続けている)対。これは衝突などで軌道が
    // 近地点に到達する前に打ち切られたケースの直接的な再現であり、そのようなときに
    // 偽の近地点を報告せず null を返すことが、粗いサンプル走査からステップごとの符号反転
    // 判定へ変えた設計上の要点。
    const prev = stateAtMeanAnomaly(a, e, incDeg, raan, argp, -0.5);
    const next = stateAtMeanAnomaly(a, e, incDeg, raan, argp, -0.3);
    assert.equal(apsisCrossing(EARTH, prev, next), null);
  });

  // 2周回ぶんの近地点・遠地点をまたぐステップ対を、時刻昇順(m=0 の近地点→m=π の遠地点→
  // m=2π の近地点→m=3π の遠地点)で作る。
  const apsisStepPairs = (): readonly (readonly [KinematicState, KinematicState])[] =>
    [-dm, Math.PI - dm, 2 * Math.PI - dm, 3 * Math.PI - dm].map((m0) => [
      stateAtMeanAnomaly(a, e, incDeg, raan, argp, m0),
      stateAtMeanAnomaly(a, e, incDeg, raan, argp, m0 + 2 * dm),
    ] as const);

  test('trajectory-features: ApsisTrack accumulates periapsis/apoapsis in ascending time order and answers the first', () => {
    const pairs = apsisStepPairs();
    const track = new ApsisTrack(EARTH);
    for (const [prev, next] of pairs) track.observe(prev, next);

    const expectedFirstPeriapsis = apsisCrossing(EARTH, ...pairs[0]!)!.state;
    const expectedFirstApoapsis = apsisCrossing(EARTH, ...pairs[1]!)!.state;
    assert.deepEqual(track.periapsis, expectedFirstPeriapsis);
    assert.deepEqual(track.apoapsis, expectedFirstApoapsis);
    assert.ok(track.periapsis!.t < track.apoapsis!.t, 'periapsis should precede apoapsis in time');
  });

  test('trajectory-features: ApsisTrack.dropBefore drops earlier extrema and promotes the next one to the front', () => {
    const period = keplerPeriod(a, MU_EARTH);
    const pairs = apsisStepPairs();
    const track = new ApsisTrack(EARTH);
    for (const [prev, next] of pairs) track.observe(prev, next);

    const expectedSecondPeriapsis = apsisCrossing(EARTH, ...pairs[2]!)!.state;
    const expectedSecondApoapsis = apsisCrossing(EARTH, ...pairs[3]!)!.state;
    // 1つめの近地点(t≈0)・遠地点(t≈period/2)は落ち、2つめ(t≈period, t≈1.5period)が先頭になる。
    track.dropBefore(period * 0.75);
    assert.deepEqual(track.periapsis, expectedSecondPeriapsis);
    assert.deepEqual(track.apoapsis, expectedSecondApoapsis);
  });

  test('trajectory-features: ApsisTrack answers null with no observations or no crossings observed', () => {
    const track = new ApsisTrack(EARTH);
    assert.equal(track.periapsis, null);
    assert.equal(track.apoapsis, null);

    // 遠地点手前でまだ遠ざかり続けている脚 — 符号反転がなく極値が見つからない対。
    track.observe(
      stateAtMeanAnomaly(a, e, incDeg, raan, argp, Math.PI / 4),
      stateAtMeanAnomaly(a, e, incDeg, raan, argp, Math.PI / 2),
    );
    assert.equal(track.periapsis, null);
    assert.equal(track.apoapsis, null);
  });

  test('trajectory-features: findEquatorCrossings finds ascending/descending nodes at zero latitude with the correct sign', () => {
    const a2 = R_EARTH + 500e3;
    const e2 = 0.01;
    const inc2 = 51.6;
    const samples = sampleKeplerOrbit(a2, e2, inc2, 0, 0, 36);
    const pole = v3(0, 1, 0);
    const { ascending, descending } = findEquatorCrossings(samples, EARTH, pole);
    assert.ok(ascending && descending, 'both nodes should be found');
    const scale = len(sub(ascending!.r, EARTH.state.r));
    assert.ok(Math.abs(ascending!.r.y) / scale < 1e-3, `ascending node should sit at zero latitude: y=${ascending!.r.y}`);
    assert.ok(Math.abs(descending!.r.y) / scale < 1e-3, `descending node should sit at zero latitude: y=${descending!.r.y}`);
    // 昇交点は南→北(v の pole 成分が正)、降交点は北→南(負)へ渡る瞬間
    assert.ok(ascending!.v.y > 0, `ascending node should be moving north: vy=${ascending!.v.y}`);
    assert.ok(descending!.v.y < 0, `descending node should be moving south: vy=${descending!.v.y}`);
  });
}
