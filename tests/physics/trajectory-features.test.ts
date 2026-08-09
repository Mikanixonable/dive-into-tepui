// trajectory-features.ts の回帰テスト。解析的なケプラー軌道をサンプリングした列に対して、
// 折れ線走査が解析値と十分一致することを確認する。
import * as assert from 'node:assert/strict';
import { test } from './harness';
import { Attractor } from '../../src/physics/attractor';
import { apparentEccentricity, findApsis, findEquatorCrossings } from '../../src/physics/trajectory-features';
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

// a/e/inc/raan/argp のケプラー軌道を、時刻等間隔(実際の PlanArc.samples と同じ刻み方)で
// n+1 点サンプリングする。平均近点角 M = M0 + 2πt/T をケプラー方程式で真近点角へ変換する。
// phase は開始時点の平均近点角 [rad] — ブラケットの当たり外れは開始位相に依存するので、
// 呼び出し側が複数の位相で最悪値を見られるように引数で渡す。
function sampleKeplerOrbitByTime(
  a: number, e: number, incDeg: number, raan: number, argp: number, n: number, phase: number,
): KinematicState[] {
  const inc = (incDeg * Math.PI) / 180;
  const period = keplerPeriod(a, MU_EARTH);
  const out: KinematicState[] = [];
  for (let i = 0; i <= n; i++) {
    const t = (period * i) / n;
    const m = phase + (2 * Math.PI * i) / n;
    const nu = trueAnomalyFromMean(m, e);
    out.push(stateFromOrbitalElements(t, a, e, inc, raan, argp, nu, MU_EARTH));
  }
  return out;
}

export function register(): void {
  test('trajectory-features: findApsis matches the analytic pe/ap position on a time-evenly-sampled orbit (worst case over 24 start phases)', () => {
    const a = R_EARTH + 800e3;
    const e = 0.05;
    const incDeg = 51.6;
    const raan = 0.3;
    const argp = 1.1;
    // 実際の計画軌道は1周回あたり約100サンプル(PLAN_ARC_STEPS_PER_REV=100)なので、その
    // オーダーで刻む。
    const n = 102;
    const peExpected = stateFromOrbitalElements(0, a, e, (incDeg * Math.PI) / 180, raan, argp, 0, MU_EARTH).r;
    const apExpected = stateFromOrbitalElements(0, a, e, (incDeg * Math.PI) / 180, raan, argp, Math.PI, MU_EARTH).r;
    let worstPeErr = 0, worstApErr = 0;
    for (let k = 0; k < 24; k++) {
      // 半整数オフセットにするのは、位相がちょうど 0(近地点が列の端 samples[0] に乗る)を
      // 避けるため — 端点そのものは findApsis の走査対象外(隣接3点の符号判定が使えない)
      // で、これは今回のブラケット反転バグとは無関係の既知の境界条件。
      const phase = (2 * Math.PI * (k + 0.5)) / 24;
      const samples = sampleKeplerOrbitByTime(a, e, incDeg, raan, argp, n, phase);
      const pe = findApsis(samples, EARTH, 'periapsis');
      const ap = findApsis(samples, EARTH, 'apoapsis');
      assert.ok(pe && ap, `both apsides should be found at phase ${phase}`);
      worstPeErr = Math.max(worstPeErr, len(sub(pe!.r, peExpected)));
      worstApErr = Math.max(worstApErr, len(sub(ap!.r, apExpected)));
    }
    // ブラケットの取り違え(反転バグ)があると along-track に百km級ずれるが、半径だけを見る
    // 検証ではアプシスで半径の1次変化が消えるため数十mの誤差にしか見えず検出できない —
    // 解析的な近地点/遠地点の位置そのものとの距離で検証する。正しい実装なら1kmを大きく下回る。
    assert.ok(worstPeErr < 1000, `pe worst-case position error: ${worstPeErr} m`);
    assert.ok(worstApErr < 1000, `ap worst-case position error: ${worstApErr} m`);
  });

  test('trajectory-features: findEquatorCrossings finds ascending/descending nodes at zero latitude with the correct sign', () => {
    const a = R_EARTH + 500e3;
    const e = 0.01;
    const inc = 51.6;
    const samples = sampleKeplerOrbit(a, e, inc, 0, 0, 36);
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

  test('trajectory-features: apparentEccentricity rejects an apsis scan on a near-circular orbit', () => {
    const a = R_EARTH + 500e3;
    const samples = sampleKeplerOrbit(a, 0.0005, 51.6, 0, 0, 24);
    const ecc = apparentEccentricity(samples, EARTH);
    assert.ok(ecc < 0.01, `near-circular orbit should read as low apparent eccentricity: ${ecc}`);
  });

  test('trajectory-features: apparentEccentricity reads a real elliptical orbit above the circular guard', () => {
    const a = R_EARTH + 500e3;
    const samples = sampleKeplerOrbit(a, 0.05, 51.6, 0, 0, 24);
    const ecc = apparentEccentricity(samples, EARTH);
    assert.ok(ecc > 0.01, `eccentric orbit should read above the circular guard: ${ecc}`);
  });
}
