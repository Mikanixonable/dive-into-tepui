// 実験4: 予測がどこまで先回りできるか。
// 予測の先端は1フレームあたり budget(ステップ数) × dt(1ステップの sim-秒)だけ進み、
// simTime は1フレームあたり warp/60 秒進む。この2つの競争をワープ倍率ごとに判定する。
import { keplerPeriod } from '../../src/physics/elements';
import {
  MU_EARTH, R_EARTH, INITIAL_ALT,
  ARC_STEP_BUDGET, ARC_COMBAT_STEP_BUDGET, ARC_INTERACTIVE_RATIO,
  ARC_MIN_ITEM_STEPS, SIM_SPEED_LEVELS,
} from './common';

// predictor.ts の dt サイジング式(実験1-Bで実測: LEO では常に 20 に飽和する)。
// horizon は 'orbit' プリセット既定 = その場の周期そのもの、を仮定するので
// horizon/ARC_MAX_STEPS(=period/20000) は period/600 より必ず小さく、事実上効かない。
function predictorDt(period: number): number {
  return Math.max(20, period / 600);
}

type BudgetScenario = { label: string; steps: number };

function budgetScenarios(): BudgetScenario[] {
  return [
    { label: 'マップ・自機のみ(他エンティティ無し→比率上限スキップ)', steps: ARC_STEP_BUDGET },
    { label: `マップ・他エンティティあり(自機の取り分=budget×${ARC_INTERACTIVE_RATIO})`, steps: Math.floor(ARC_STEP_BUDGET * ARC_INTERACTIVE_RATIO) },
    { label: '戦闘ビュー・自機のみ(all=[player]なので常にこれ)', steps: ARC_COMBAT_STEP_BUDGET },
    { label: `マップ・混雑時最悪(ラウンドロビンの1体あたり下限 ARC_MIN_ITEM_STEPS)`, steps: ARC_MIN_ITEM_STEPS },
  ];
}

function analyzeOrbit(label: string, period: number): void {
  const dt = predictorDt(period);
  console.log(`\n## ${label}\n`);
  console.log(`  周期 = ${period.toFixed(1)} s, period/600 = ${(period / 600).toFixed(3)} s, 予測の実効dt = ${dt.toFixed(3)} s\n`);

  console.log('budget シナリオ | 予測の先端が1フレームに進む量 = budget×dt [sim-s] | 追い抜かれる倍率(理論値, capacity×60)');
  console.log('--- | --- | ---');
  const scenarios = budgetScenarios();
  const capacities: { scenario: BudgetScenario; capacity: number; crossoverWarp: number }[] = [];
  for (const sc of scenarios) {
    const capacity = sc.steps * dt;
    const crossoverWarp = capacity * 60;
    capacities.push({ scenario: sc, capacity, crossoverWarp });
    console.log(`${sc.label}(steps=${sc.steps}) | ${capacity.toFixed(1)} | warp > ${crossoverWarp.toFixed(0)}`);
  }

  console.log('\n倍率ごとの判定(simTime前進量 = warp/60 と、各シナリオの先端前進量の比較):\n');
  const header = ['倍率', 'simTime前進[sim-s/frame]', ...scenarios.map((s) => s.label.split('(')[0])];
  console.log(header.join(' | '));
  console.log(header.map(() => '---').join(' | '));
  for (const warp of SIM_SPEED_LEVELS) {
    const simTimePerFrame = warp / 60;
    const cells = capacities.map(({ capacity }) => {
      const net = capacity - simTimePerFrame;
      return net >= 0 ? `伸びる(+${net.toFixed(1)})` : `縮む(${net.toFixed(1)})`;
    });
    console.log(`${warp} | ${simTimePerFrame.toFixed(2)} | ${cells.join(' | ')}`);
  }

  console.log('\n各シナリオで「予測が追い抜かれる」最初の倍率(SIM_SPEED_LEVELS の中で):');
  for (const { scenario, crossoverWarp } of capacities) {
    const outrun = SIM_SPEED_LEVELS.find((w) => w / 60 > scenario.steps * dt);
    console.log(`  ${scenario.label}: 理論しきい値 warp>${crossoverWarp.toFixed(0)} → SIM_SPEED_LEVELS内では ${outrun !== undefined ? `warp=${outrun} から追い抜かれる` : '追い抜かれる倍率なし(全レベルで先端が伸び続ける)'}`);
  }
}

export function run(): void {
  console.log('# 実験4: 予測がどこまで先回りできるか\n');
  console.log('前提: ARC_STEP_BUDGET=500(マップ), ARC_COMBAT_STEP_BUDGET=128(戦闘),');
  console.log('ARC_INTERACTIVE_RATIO=0.5, ARC_MIN_ITEM_STEPS=16(混雑時のラウンドロビン下限)。');
  console.log('horizon(表示期間)は既定「1周」= その場の周期そのもの、を仮定する。');

  const rLeo = R_EARTH + INITIAL_ALT;
  const periodLeo = keplerPeriod(rLeo, MU_EARTH);
  analyzeOrbit(`LEO(高度420km, 周期${periodLeo.toFixed(0)}s)`, periodLeo);

  // 月距離(384,400km)の地球周回軌道(高高度軌道の参考ケース)。
  const rHigh = 384400e3;
  const periodHigh = keplerPeriod(rHigh, MU_EARTH);
  analyzeOrbit(`地球周回・月距離相当(半径384,400km, 周期${periodHigh.toFixed(0)}s ≈ ${(periodHigh / 86400).toFixed(2)}日)`, periodHigh);
}

if (require.main === module) run();
