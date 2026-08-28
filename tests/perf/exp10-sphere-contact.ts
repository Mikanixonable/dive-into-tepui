// 実験10: 掃引接触判定(physics/sphere-contact)の解法別コスト。
// 弦・二次・三次を、棄却経路(箱で落ちる相手)と求根経路(表面を跨ぐ相手)に分けて測る。
// 配置は二体問題の RK4 から作り、実シミュレーション側の刻みガードは通さない。
import { kinematicState } from '../../src/physics/kinematic-state';
import { R_EARTH_EQ } from '../../src/physics/solar-system/constants';
import { add, v3 } from '../../src/math/vec3';
import {
  EARTH, SOLVERS, Solver, Sweep, againstBody, circular, companion, freeFall, solve, still, sweepOf,
} from './sphere-contact-sweeps';

const STEP_DT = 20;

function sweeps(): readonly Sweep[] {
  const leo = circular(EARTH, 413e3);
  const earthFall = freeFall(EARTH);
  // 動径方向へ落として、区間の途中で地表へ届かせる。
  const descending = kinematicState(0, circular(EARTH, 60e3).r, add(circular(EARTH, 60e3).v, v3(-4000, 0, 0)));
  const far = kinematicState(0, v3(7.8e11, 0, 0), v3());
  return [
    againstBody('周回中の地球(触れない)', EARTH, leo, STEP_DT, earthFall),
    sweepOf('遠方の天体(木星の距離)', leo, far, STEP_DT, earthFall, still, 7.1e7),
    againstBody('再突入(表面を跨ぐ)', EARTH, descending, STEP_DT, earthFall),
    sweepOf('個体どうし・すれ違い', leo, companion(leo, v3(0, 0, 3000), v3()), STEP_DT,
      earthFall, earthFall, 20),
    sweepOf('個体どうし・接触', leo, companion(leo, v3(0, 0, 10), v3(0, 1.5, 0)), STEP_DT,
      earthFall, earthFall, 20),
  ];
}

// 同じ区間を n 回解いて1回あたりの ns を返す。半径和を毎回わずかに動かして呼び出しを畳ませない。
function bench(sweep: Sweep, solver: Solver, n: number): number {
  let sink = 0;
  const t0 = performance.now();
  for (let i = 0; i < n; i++) {
    const contact = solve(sweep, solver, sweep.radiusSum * (1 + i * 1e-13));
    sink += contact === null ? 0 : contact.crossing === null ? 1 : contact.crossing.toi;
  }
  const ms = performance.now() - t0;
  if (!Number.isFinite(sink)) throw new Error('sink が非有限');
  return (ms / n) * 1e6;
}

// 3モードの答えを並べる。コストを測る前に、同じ区間で同じ結論が出ることを確かめる。
function reportAnswers(list: readonly Sweep[]): void {
  console.log('配置 | 弦 | 二次 | 三次');
  console.log('--- | --- | --- | ---');
  for (const s of list) {
    const cells = SOLVERS.map((solver) => {
      const c = solve(s, solver, s.radiusSum);
      if (c === null) return 'null';
      if (c.crossing === null) return c.startsInside ? '内側のまま' : '跨ぎなし';
      return `toi=${c.crossing.toi.toFixed(6)}`;
    });
    console.log(`${s.label} | ${cells.join(' | ')}`);
  }
}

export function run(): void {
  console.log('# 実験10: 掃引接触判定の解法別コスト\n');
  const list = sweeps();

  console.log('## 3モードの答え\n');
  reportAnswers(list);

  console.log('\n## 1回あたりのコスト [ns]\n');
  console.log('配置 | 弦 | 二次 | 三次 | 二次/弦 | 三次/弦 | 三次/二次');
  console.log('--- | --- | --- | --- | --- | --- | ---');
  const n = 2e6;
  for (const s of list) {
    for (const solver of SOLVERS) bench(s, solver, 1e5); // ウォームアップ
    const [lin, quad, cub] = SOLVERS.map((solver) => bench(s, solver, n));
    console.log(`${s.label} | ${lin!.toFixed(1)} | ${quad!.toFixed(1)} | ${cub!.toFixed(1)}`
      + ` | ${(quad! / lin!).toFixed(2)}× | ${(cub! / lin!).toFixed(2)}× | ${(cub! / quad!).toFixed(2)}×`);
  }

  console.log(`\n(n=${n.toExponential(0)} 回/セル、ウォームアップ 1e5 回、刻み ${STEP_DT} s)`);
  console.log(`地球の衝突球 ${(R_EARTH_EQ / 1e3).toFixed(0)} km、周回半径 ${((R_EARTH_EQ + 413e3) / 1e3).toFixed(0)} km`);
}

if (require.main === module) run();
