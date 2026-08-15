// 実験5: 予測の刻み幅を「その場の軌道周期に比例させる」必要があるかを、精度で測る。
//
// predictor.ts の dt は max(PREDICT_MIN_STEP_DT, localOrbitPeriod/PREDICT_STEPS_PER_REV,
// horizon/PREDICT_MAX_STEPS) で、真ん中の項だけが重力源の解決を要求する。その1項のために
// 1ステップにつき暦をもう1回引いている(exp3 ではこれが1反復コストの約半分)。
//
// 「周期に比例させる」と「定数にする」は、比例定数/定数の取り方次第で dt をいくらでも
// 動かせるので、dt そのものを比べても何も決まらない。決めるべきなのは
// **誤差を支配しているパラメータが dt[秒] なのか、1周あたりのステップ数なのか** である。
//   - 1周あたりのステップ数が支配的なら、軌道ごとに dt を変える(=周期比例)必要がある。
//   - dt[秒] が支配的なら、全軌道で同じ定数刻みにしても同じ精度が出るので、周期項は要らない。
// そこで、全 regime に**同じホライズン(秒)**を与えたうえで dt を掃引し、誤差を
//   (a) dt[秒] に対して   (b) 1周あたりステップ数に対して
// 並べ、どちらで揃うかを見る。最後に「同じ総ステップ数(=同じコスト)を配ったとき、
// 定数刻みと周期比例刻みのどちらが誤差が小さいか」を直接比べる。
import { Ephemeris } from '../../src/physics/ephemeris';
import { Attractor, localOrbitPeriod, strongestAttractor } from '../../src/physics/attractor';
import { kinematicState, KinematicState } from '../../src/physics/kinematic-state';
import { v3, sub, len, cross, norm, scale, add } from '../../src/physics/vec3';
import { stepDynamics } from '../../src/physics/dynamics';
import {
  buildEphemeris, initialLeoState, posError,
  PREDICT_MIN_STEP_DT, PREDICT_STEPS_PER_REV, PREDICT_MAX_STEPS,
  R_EARTH, SHIP_BCINV,
} from './common';

// 全 regime へ共通に与えるホライズン [s]。ゲームでは表示期間が全個体へ一律に配られるので、
// 「同じ秒数」を揃えるのが実際の条件に一致する。
const HORIZON_SEC = 86400;

// 誤差の基準(真値)とする刻み幅 [s]。最も細かい掃引値よりさらに細かくとる。
const TRUTH_DT = 2;

// 掃引する定数刻み [s]。
const DT_SWEEP = [10, 20, 40, 80, 160, 320, 640, 1280, 2560] as const;

type Regime = {
  readonly label: string;
  readonly state: KinematicState;
};

// 中心天体 center のまわりの円軌道。dist は中心からの距離 [m]。
function circularAround(center: Attractor, dist: number): KinematicState {
  const radial = v3(dist, 0, 0);
  const speed = Math.sqrt(center.mu / dist);
  const tangent = scale(norm(cross(v3(0, 1, 0), radial)), speed);
  return kinematicState(center.state.t, add(center.state.r, radial), add(center.state.v, tangent));
}

function buildRegimes(ephemeris: Ephemeris): readonly Regime[] {
  const bodies = ephemeris.gravityAttractorsAt(0);
  const earth = bodies.find((b) => b.id === 'earth')!;
  const moon = bodies.find((b) => b.id === 'moon')!;
  return [
    { label: 'LEO 420km', state: initialLeoState() },
    { label: '高度 2000km', state: circularAround(earth, R_EARTH + 2000e3) },
    { label: '静止軌道 GEO', state: circularAround(earth, 4.2164e7) },
    { label: '地心 1e8m', state: circularAround(earth, 1e8) },
    { label: '地心 3.5e8m', state: circularAround(earth, 3.5e8) },
    { label: '低月周回 100km', state: circularAround(moon, moon.radius + 100e3) },
    { label: '月周回 5000km', state: circularAround(moon, moon.radius + 5000e3) },
  ];
}

// dt 固定で horizon ぶん積分する(各ステップの重力源はその中点時刻で解決する — Simulator と
// Predictor がどちらも中点で解決するのに合わせる)。
function integrate(ephemeris: Ephemeris, state0: KinematicState, dt: number, horizon: number): KinematicState {
  const end = state0.t + horizon;
  let s = state0;
  while (end - s.t > 1e-9) {
    const step = Math.min(dt, end - s.t);
    const attractors = ephemeris.gravityAttractorsAt(s.t + step / 2);
    s = stepDynamics(s, step, attractors, SHIP_BCINV, 0, null);
  }
  return s;
}

// その regime の「支配天体まわりの周期」と「支配天体からの距離」。誤差の相対化に使う。
function scaleOf(ephemeris: Ephemeris, state: KinematicState): { period: number; radius: number } {
  const attractors = ephemeris.gravityAttractorsAt(state.t);
  const center = strongestAttractor(state.r, attractors);
  return { period: localOrbitPeriod(state.r, attractors), radius: len(sub(state.r, center.state.r)) };
}

type Row = {
  readonly dt: number;
  readonly steps: number;
  readonly stepsPerRev: number;
  readonly absErr: number;
  readonly relErr: number;
};

function sweepRegime(ephemeris: Ephemeris, regime: Regime): { rows: Row[]; period: number; radius: number } {
  const { period, radius } = scaleOf(ephemeris, regime.state);
  const truth = integrate(ephemeris, regime.state, TRUTH_DT, HORIZON_SEC);
  const rows: Row[] = [];
  for (const dt of DT_SWEEP) {
    const s = integrate(ephemeris, regime.state, dt, HORIZON_SEC);
    const absErr = posError(s, truth);
    rows.push({
      dt,
      steps: Math.ceil(HORIZON_SEC / dt),
      stepsPerRev: period / dt,
      absErr,
      relErr: absErr / radius,
    });
  }
  return { rows, period, radius };
}

// --- 5-A: 誤差を dt[秒] に対して並べる ------------------------------------------------------
function partA(swept: ReadonlyMap<string, { rows: Row[]; period: number; radius: number }>): void {
  console.log('\n## 実験5-A: 誤差を dt[秒] に対して並べる\n');
  console.log(`ホライズン ${HORIZON_SEC}s を全 regime 共通で積分し、真値(dt=${TRUTH_DT}s)との位置差を出す。`);
  console.log('dt が誤差を支配しているなら、同じ dt の列で誤差が揃うはず。\n');
  console.log(`軌道 | 周期[s] | ${DT_SWEEP.map((d) => `dt=${d}`).join(' | ')}`);
  console.log(`--- | --- | ${DT_SWEEP.map(() => '---').join(' | ')}`);
  for (const [label, { rows, period }] of swept) {
    const cells = rows.map((r) => (r.absErr >= 1e4 ? r.absErr.toExponential(1) : r.absErr.toFixed(1)));
    console.log(`${label} | ${period.toFixed(0)} | ${cells.join(' | ')}`);
  }
  console.log('\n(単位 m。相対誤差 = 位置差 / 支配天体からの距離)\n');
  console.log(`軌道 | 半径[m] | ${DT_SWEEP.map((d) => `dt=${d}`).join(' | ')}`);
  console.log(`--- | --- | ${DT_SWEEP.map(() => '---').join(' | ')}`);
  for (const [label, { rows, radius }] of swept) {
    console.log(`${label} | ${radius.toExponential(2)} | ${rows.map((r) => r.relErr.toExponential(1)).join(' | ')}`);
  }
}

// --- 5-B: 誤差を「1周あたりステップ数」に対して並べる ---------------------------------------
function partB(swept: ReadonlyMap<string, { rows: Row[]; period: number; radius: number }>): void {
  console.log('\n## 実験5-B: 誤差を「1周あたりステップ数」に対して並べる\n');
  console.log('1周あたりステップ数が誤差を支配しているなら、この値が近い行どうしで');
  console.log('相対誤差が揃うはず。5-A と見比べて、どちらで揃うかを読む。\n');
  console.log('軌道 | 1周あたりステップ数 → 相対誤差 の対応(dt 昇順)');
  console.log('--- | ---');
  for (const [label, { rows }] of swept) {
    const pairs = rows.map((r) => `${r.stepsPerRev.toFixed(0)}歩/周:${r.relErr.toExponential(1)}`);
    console.log(`${label} | ${pairs.join(', ')}`);
  }
}

// --- 5-C: 同じ総コストを配ったときの精度 ------------------------------------------------------
// 周期比例(現行)が全 regime で使う総ステップ数を求め、同じ総ステップ数になる定数刻みを
// 逆算して、そのときの各 regime の誤差を比べる。
function partC(ephemeris: Ephemeris, regimes: readonly Regime[]): void {
  console.log('\n## 実験5-C: 同じ総ステップ数(=同じコスト)を配ったときの精度\n');
  console.log('現行の周期比例則が全 regime 合計で使うステップ数を求め、同じ合計になる定数刻みを');
  console.log('逆算して、regime ごとの誤差を突き合わせる。コストを揃えた上での精度勝負。\n');

  // 現行則の dt と、その総ステップ数。
  const adaptive = regimes.map((regime) => {
    const { period, radius } = scaleOf(ephemeris, regime.state);
    const dt = Math.min(
      HORIZON_SEC,
      Math.max(PREDICT_MIN_STEP_DT, period / PREDICT_STEPS_PER_REV, HORIZON_SEC / PREDICT_MAX_STEPS),
    );
    return { regime, period, radius, dt, steps: Math.ceil(HORIZON_SEC / dt) };
  });
  const totalSteps = adaptive.reduce((acc, a) => acc + a.steps, 0);
  // 定数刻み dt にすると総ステップ数は regimes.length * ceil(HORIZON/dt) なので、
  // それが totalSteps に一致する dt を解く。
  const constantDt = (HORIZON_SEC * regimes.length) / totalSteps;
  console.log(`現行則の総ステップ数 = ${totalSteps}(${regimes.length} regime 合計)`);
  console.log(`同じ総ステップ数になる定数刻み = ${constantDt.toFixed(2)}s\n`);

  console.log('軌道 | 現行dt[s] | 現行steps | 現行の絶対誤差[m] | 現行の相対誤差 | '
    + `定数dt=${constantDt.toFixed(1)}s steps | 定数の絶対誤差[m] | 定数の相対誤差`);
  console.log('--- | --- | --- | --- | --- | --- | --- | ---');
  for (const a of adaptive) {
    const truth = integrate(ephemeris, a.regime.state, TRUTH_DT, HORIZON_SEC);
    const adapt = integrate(ephemeris, a.regime.state, a.dt, HORIZON_SEC);
    const constant = integrate(ephemeris, a.regime.state, constantDt, HORIZON_SEC);
    const aErr = posError(adapt, truth);
    const cErr = posError(constant, truth);
    console.log(
      `${a.regime.label} | ${a.dt.toFixed(1)} | ${a.steps} | ${aErr.toExponential(2)} | `
      + `${(aErr / a.radius).toExponential(2)} | ${Math.ceil(HORIZON_SEC / constantDt)} | `
      + `${cErr.toExponential(2)} | ${(cErr / a.radius).toExponential(2)}`,
    );
  }
}

// --- 5-D: 刻み幅の決定に、専用の暦解決が要るか ------------------------------------------------
// 現行は1ステップにつき2回暦を引く: 開始時刻(dt を決めるためだけ)と中点時刻(積分本体)。
// dt を「1歩前の中点で解決済みの重力源」から決めれば、解決は1ステップ1回で済む。
// 周期は位置のなめらかな関数なので、半歩ぶん古い天体位置で決めても dt はほとんど動かないはず。
// それを、最終位置の差と dt の比の最大値で確かめる。
function partD(ephemeris: Ephemeris, regimes: readonly Regime[]): void {
  console.log('\n## 実験5-D: 刻み幅の決定に専用の暦解決が要るか\n');
  console.log('現行(開始時刻で解決して dt を決める)と、使い回し(1歩前の中点の解決を流用)を');
  console.log('並走させ、最終位置の差と、決まった dt の比の最大値を見る。\n');
  console.log('軌道 | ステップ数 | 現行の暦解決回数 | 使い回しの解決回数 | 最終位置差[m] | dt比の最大');
  console.log('--- | --- | --- | --- | --- | ---');
  for (const { label, state } of regimes) {
    const end = state.t + HORIZON_SEC;

    let a = state;
    let stepsA = 0;
    let resolveA = 0;
    while (end - a.t > 1e-9) {
      const start = ephemeris.gravityAttractorsAt(a.t);
      resolveA++;
      const dt = Math.min(end - a.t, Math.max(
        PREDICT_MIN_STEP_DT, localOrbitPeriod(a.r, start) / PREDICT_STEPS_PER_REV,
        HORIZON_SEC / PREDICT_MAX_STEPS,
      ));
      const mid = ephemeris.gravityAttractorsAt(a.t + dt / 2);
      resolveA++;
      a = stepDynamics(a, dt, mid, SHIP_BCINV, 0, null);
      stepsA++;
    }

    let b = state;
    let resolveB = 0;
    let maxRatio = 1;
    // 初回だけは1歩前が無いので開始時刻で解決する。以降は前ステップの中点の結果を使う。
    let sizing = ephemeris.gravityAttractorsAt(b.t);
    resolveB++;
    while (end - b.t > 1e-9) {
      const dt = Math.min(end - b.t, Math.max(
        PREDICT_MIN_STEP_DT, localOrbitPeriod(b.r, sizing) / PREDICT_STEPS_PER_REV,
        HORIZON_SEC / PREDICT_MAX_STEPS,
      ));
      const fresh = Math.min(end - b.t, Math.max(
        PREDICT_MIN_STEP_DT, localOrbitPeriod(b.r, ephemeris.gravityAttractorsAt(b.t)) / PREDICT_STEPS_PER_REV,
        HORIZON_SEC / PREDICT_MAX_STEPS,
      ));
      maxRatio = Math.max(maxRatio, Math.max(dt / fresh, fresh / dt));
      const mid = ephemeris.gravityAttractorsAt(b.t + dt / 2);
      resolveB++;
      b = stepDynamics(b, dt, mid, SHIP_BCINV, 0, null);
      sizing = mid;
    }

    console.log(
      `${label} | ${stepsA} | ${resolveA} | ${resolveB} | `
      + `${posError(a, b).toExponential(2)} | ${maxRatio.toFixed(6)}`,
    );
  }
  console.log('\n(dt比の比較に使った解決は、使い回し側の解決回数には数えていない — 比較専用。)');
}

export function runExp5(): void {
  console.log('# 実験5: 予測の刻み幅の周期項に存在理由があるか(精度ベース)');
  const ephemeris = buildEphemeris();
  const regimes = buildRegimes(ephemeris);
  const swept = new Map<string, { rows: Row[]; period: number; radius: number }>();
  for (const regime of regimes) swept.set(regime.label, sweepRegime(ephemeris, regime));
  partA(swept);
  partB(swept);
  partC(ephemeris, regimes);
  partD(ephemeris, regimes);
}

if (require.main === module) runExp5();
