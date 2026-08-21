// 実験1: RK4 のステップ幅と誤差。
// LEO 自機軌道を dt=0.5s(真値)・20s(実シミュレーション/予測相当)・40/80/160/320s(参考)で
// 積分し、経過時間ごとの真値からの位置誤差 [m] を比較する。
// さらに、実シミュレーション dt=20s(端数込み)と予測 dt=20s(固定)が「同じ刻み」なのに
// なぜ乖離しうるのかを、フレーム分割の端数(Simulator.advance の ceil(simDt/20))から
// 生じる実際の per-substep dt を計算して検証する。
import { Ephemeris } from '../../src/physics/ephemeris';
import { localOrbitPeriod } from '../../src/physics/celestial-body';
import {
  buildEphemeris, initialLeoState, integrateFixedDt, integrateToCheckpoints,
  posError, SUBSTEP_MAX_DT, SIM_SPEED_LEVELS,
  ARC_MIN_STEP_DT, ARC_STEPS_PER_REV, ARC_MAX_STEPS,
} from './common';

const CHECKPOINTS = [60, 300, 600, 1800, 5580, 11160, 86400];
const CHECKPOINT_LABELS: Record<number, string> = {
  60: '60s', 300: '300s', 600: '600s', 1800: '1800s',
  5580: '5580s(1周)', 11160: '11160s(2周)', 86400: '86400s(1日)',
};

function partA(ephemeris: Ephemeris): void {
  console.log('\n## 実験1-A: dt 別の真値からの位置誤差 [m]\n');
  const s0 = initialLeoState();

  console.log('真値(dt=0.5s)を積分中...');
  const t0 = performance.now();
  const truth = integrateToCheckpoints(ephemeris, s0, 0.5, CHECKPOINTS);
  console.log(`  所要時間: ${((performance.now() - t0) / 1000).toFixed(1)} s`);

  const dtCases = [20, 40, 80, 160, 320];
  const results = new Map<number, Map<number, number>>(); // dt -> checkpoint -> error[m]
  const times = new Map<number, number>();
  for (const dt of dtCases) {
    const tStart = performance.now();
    const states = integrateToCheckpoints(ephemeris, s0, dt, CHECKPOINTS);
    times.set(dt, performance.now() - tStart);
    const errs = new Map<number, number>();
    for (const cp of CHECKPOINTS) {
      errs.set(cp, posError(states.get(cp)!, truth.get(cp)!));
    }
    results.set(dt, errs);
  }

  const header = ['経過時間', ...dtCases.map((dt) => `dt=${dt}s`)];
  console.log(header.join(' | '));
  console.log(header.map(() => '---').join(' | '));
  for (const cp of CHECKPOINTS) {
    const row = [CHECKPOINT_LABELS[cp]!, ...dtCases.map((dt) => results.get(dt)!.get(cp)!.toFixed(2))];
    console.log(row.join(' | '));
  }
  console.log('\n各 dt ケースの積分所要時間:');
  for (const dt of dtCases) console.log(`  dt=${dt}s: ${times.get(dt)!.toFixed(1)} ms`);
}

function partB(ephemeris: Ephemeris): void {
  console.log('\n## 実験1-B: 予測の実効刻み幅の検証\n');
  console.log(`予測の dt = min(remaining, max(ARC_MIN_STEP_DT=${ARC_MIN_STEP_DT}, localOrbitPeriod/ARC_STEPS_PER_REV(=${ARC_STEPS_PER_REV}), horizon/ARC_MAX_STEPS(=${ARC_MAX_STEPS})))`);
  console.log('horizon は表示期間既定値「1周」= その時点の周期そのもの、を仮定する(remaining は');
  console.log('その瞬間に予測を開始したときの初期値 = horizon 自身とする)。\n');

  const s0 = initialLeoState();
  let s = s0;
  console.log('経過時間 | 高度[km] | period[s] | period/stepsPerRev[s] | horizon/maxSteps[s] | 予測dt[s]');
  console.log('--- | --- | --- | --- | --- | ---');
  const checks = [0, 60, 300, 600, 1800, 5580, 11160, 86400];
  for (const t of checks) {
    s = integrateFixedDt(ephemeris, s, 20, t);
    const celestialBodies = ephemeris.gravityAttractorsAt(s.t);
    const period = localOrbitPeriod(s.r, celestialBodies);
    const horizon = period; // 'orbit' プリセット既定値
    const remaining = horizon;
    const dt = Math.min(remaining, Math.max(ARC_MIN_STEP_DT, period / ARC_STEPS_PER_REV, horizon / ARC_MAX_STEPS));
    const alt = (Math.sqrt(s.r.x * s.r.x + s.r.y * s.r.y + s.r.z * s.r.z) - 6371e3) / 1000;
    console.log(`${t}s | ${alt.toFixed(2)} | ${period.toFixed(2)} | ${(period / ARC_STEPS_PER_REV).toFixed(3)} | ${(horizon / ARC_MAX_STEPS).toFixed(3)} | ${dt.toFixed(4)}`);
  }
}

function warpSubstepTable(): { warp: number; simDt: number; nSubsteps: number; perSubstepDt: number }[] {
  const rows: { warp: number; simDt: number; nSubsteps: number; perSubstepDt: number }[] = [];
  for (const warp of SIM_SPEED_LEVELS) {
    const simDt = (1 / 60) * warp;
    const nSubsteps = Math.ceil(simDt / SUBSTEP_MAX_DT);
    const perSubstepDt = simDt / nSubsteps;
    rows.push({ warp, simDt, nSubsteps, perSubstepDt });
  }
  return rows;
}

function partC(): void {
  console.log('\n## 実験1-C: ワープ倍率ごとの実サブステップ幅(60fps 前提)\n');
  console.log('倍率 | simDt=warp/60[s] | nSubsteps=ceil(simDt/20) | per-substep dt[s]');
  console.log('--- | --- | --- | ---');
  for (const row of warpSubstepTable()) {
    console.log(`${row.warp} | ${row.simDt.toFixed(4)} | ${row.nSubsteps} | ${row.perSubstepDt.toFixed(4)}`);
  }
}

function partD(ephemeris: Ephemeris): void {
  console.log('\n## 実験1-D: 「同じ20s」でも刻みの位相・端数が違うと生じる乖離\n');
  console.log('予測(dt=20s固定)と、実シミュレーション相当(その倍率の per-substep dt 固定)を');
  console.log('同じ初期状態(simTime=0)から積分し、両者の位置差[m]を経過時間ごとに見る。\n');

  const s0 = initialLeoState();
  const substeps = warpSubstepTable();
  const sample = [4096, 65536].map((w) => substeps.find((r) => r.warp === w)!);

  console.log('選んだ代表倍率:');
  for (const row of sample) console.log(`  warp=${row.warp}: simDt=${row.simDt.toFixed(3)}s, nSubsteps=${row.nSubsteps}, per-substep dt=${row.perSubstepDt.toFixed(4)}s`);

  const predictor = integrateToCheckpoints(ephemeris, s0, 20, CHECKPOINTS);
  const actuals = sample.map((row) => integrateToCheckpoints(ephemeris, s0, row.perSubstepDt, CHECKPOINTS));

  const header = ['経過時間', ...sample.map((r) => `|実sim(warp=${r.warp}) - 予測(dt=20)|`)];
  console.log('\n' + header.join(' | '));
  console.log(header.map(() => '---').join(' | '));
  for (const cp of CHECKPOINTS) {
    const row = [CHECKPOINT_LABELS[cp]!, ...actuals.map((m) => posError(m.get(cp)!, predictor.get(cp)!).toFixed(3))];
    console.log(row.join(' | '));
  }
}

export function run(): void {
  console.log('# 実験1: RK4 のステップ幅と誤差');
  const ephemeris = buildEphemeris();
  partA(ephemeris);
  partB(ephemeris);
  partC();
  partD(ephemeris);
}

if (require.main === module) run();
