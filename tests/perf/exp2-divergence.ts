// 実験2: 乖離が許容量に達するまでの時間(sawtooth 周期の推定)。
// game-entity.ts の divergenceTolerance() の式で LEO・低月周回・地球高軌道の許容量 [m] を
// 計算し、実験1の「予測(dt=20s固定) vs 実シミュレーション相当(per-substep dt固定)」の
// 誤差成長カーブを実測で伸ばして、許容量を超える時刻(sawtooth の周期)を探す。
import { Ephemeris } from '../../src/physics/ephemeris';
import { keplerPeriod } from '../../src/physics/elements';
import { MU_MOON, R_MOON } from '../../src/physics/solar-system';
import {
  buildEphemeris, initialLeoState, divergenceToleranceFormula, findCrossing, extrapolateCrossing,
  MU_EARTH, R_EARTH, SUBSTEP_MAX_DT, SIM_SPEED_LEVELS,
} from './common';

function partTolerance(): number {
  console.log('\n## 実験2-A: divergenceTolerance() の許容量 [m](game-entity.ts の式)\n');
  const s0 = initialLeoState();
  const rLeo = Math.sqrt(s0.r.x * s0.r.x + s0.r.y * s0.r.y + s0.r.z * s0.r.z);

  const cases: { label: string; dist: number; mu: number; horizonLabel: string; horizon: number }[] = [];
  // horizon(表示期間)の既定「1周」は、その場の軌道周期そのもの。
  const leoPeriod = keplerPeriod(rLeo, MU_EARTH);
  cases.push({ label: 'LEO(高度420km)', dist: rLeo, mu: MU_EARTH, horizonLabel: '1周(既定)', horizon: leoPeriod });

  const rLunar = R_MOON + 100e3;
  const lunarPeriod = keplerPeriod(rLunar, MU_MOON);
  cases.push({ label: '低月周回(高度100km)', dist: rLunar, mu: MU_MOON, horizonLabel: '1周(既定)', horizon: lunarPeriod });

  const rGeo = R_EARTH + 35786e3;
  const geoPeriod = keplerPeriod(rGeo, MU_EARTH);
  cases.push({ label: '地球高軌道(GEO相当, 高度35786km)', dist: rGeo, mu: MU_EARTH, horizonLabel: '1周(既定)', horizon: geoPeriod });

  // 参考: LEO で表示期間を長く(28日)取った場合。
  cases.push({ label: 'LEO(高度420km) 参考: 表示期間28日', dist: rLeo, mu: MU_EARTH, horizonLabel: '28日', horizon: 28 * 86400 });

  console.log('ケース | period[s] | interval[s] | coarsening | raw[m] | orbitScale[m] | tolerance[m]');
  console.log('--- | --- | --- | --- | --- | --- | ---');
  let leoTolerance = 500;
  for (const c of cases) {
    const r = divergenceToleranceFormula(c.dist, c.mu, c.horizon);
    console.log(`${c.label}(horizon=${c.horizonLabel}) | ${r.period.toFixed(1)} | ${r.interval.toFixed(2)} | ${r.coarsening.toFixed(3)} | ${r.raw.toFixed(2)} | ${r.orbitScale.toExponential(3)} | ${r.tolerance.toFixed(2)}`);
    if (c.label.startsWith('LEO') && c.horizonLabel === '1周(既定)') leoTolerance = r.tolerance;
  }
  return leoTolerance;
}

// SIM_SPEED_LEVELS の各倍率について、60fps 前提の per-substep dt を返す(実験1-Cと同じ式)。
function perSubstepDt(warp: number): number {
  const simDt = (1 / 60) * warp;
  const nSubsteps = Math.ceil(simDt / SUBSTEP_MAX_DT);
  return simDt / nSubsteps;
}

function partCrossing(ephemeris: Ephemeris, tolerance: number): void {
  console.log('\n## 実験2-B: 予測(dt=20s固定) vs 実シミュレーション相当、乖離が許容量を超える時刻\n');
  console.log(`許容量(LEO・1周プリセット): ${tolerance.toFixed(1)} m\n`);

  const MAX_DAYS = 25;
  const MAX_SEC = MAX_DAYS * 86400;
  const SAMPLE_STEP = 3600; // 1時間おきにサンプリング

  // per-substep dt が 20s に近いほど計算コストが低い(1歩あたり ~200us、1日あたり ~1s)。
  // dt<=5s のケースは 25日分をこの刻みで直接積分すると数分かかるため、5s を「真値相当」の
  // 代表として1回だけ実測し、それより細かい(=誤差がさらに無視できる)倍率はこの結果を流用する。
  const warpToDt = new Map(SIM_SPEED_LEVELS.map((w) => [w, perSubstepDt(w)] as const));
  console.log('倍率 | per-substep dt[s]');
  console.log('--- | ---');
  for (const w of SIM_SPEED_LEVELS) console.log(`${w} | ${warpToDt.get(w)!.toFixed(4)}`);

  // 実際に積分するケース: per-substep dt の相異なる値ごとに1回。
  const distinctDts = Array.from(new Set(SIM_SPEED_LEVELS.map((w) => warpToDt.get(w)!)));
  // dt<=5s は「真値相当」として1本(dt=5s)にまとめる — 実験1-Aで示した通り、dt=20sの
  // 真値からの誤差(1日で約12m)は dt が細かくなるほど dt^4〜dt^5 に近い速さで急減するため、
  // 5s刻みの誤差はこの規模の許容量([m]オーダー)に対して無視できる。
  const proxyDts = distinctDts.filter((dt) => dt <= 5);
  const dedicatedDts = distinctDts.filter((dt) => dt > 5).sort((a, b) => a - b);

  type CaseResult = { dt: number; label: string; tCrossSec: number | null; extrapolated: boolean };
  const results: CaseResult[] = [];

  if (proxyDts.length > 0) {
    console.log(`\n[真値代替 dt=5s] 対象 per-substep dt: ${proxyDts.map((d) => d.toFixed(4)).join(', ')} を代表`);
    const t0 = performance.now();
    const r = findCrossing(ephemeris, 20, 5, tolerance, MAX_SEC, SAMPLE_STEP);
    console.log(`  積分所要時間: ${((performance.now() - t0) / 1000).toFixed(1)} s`);
    let tCross = r.tCross;
    let extrapolated = false;
    if (!r.crossed) {
      tCross = extrapolateCrossing(r.samples, tolerance);
      extrapolated = true;
      console.log(`  ${MAX_DAYS}日以内には到達せず。末尾サンプルからべき乗則で外挿。`);
    }
    console.log(`  最終サンプル: t=${r.samples[r.samples.length - 1]!.t}s, diff=${r.samples[r.samples.length - 1]!.diff.toFixed(3)}m`);
    results.push({ dt: 5, label: 'dt<=5s(真値相当)', tCrossSec: tCross, extrapolated });
  }

  for (const dt of dedicatedDts) {
    console.log(`\n[実測 dt=${dt.toFixed(4)}s]`);
    const t0 = performance.now();
    const r = findCrossing(ephemeris, 20, dt, tolerance, MAX_SEC, SAMPLE_STEP);
    console.log(`  積分所要時間: ${((performance.now() - t0) / 1000).toFixed(1)} s`);
    let tCross = r.tCross;
    let extrapolated = false;
    if (!r.crossed) {
      tCross = extrapolateCrossing(r.samples, tolerance);
      extrapolated = true;
      console.log(`  ${MAX_DAYS}日以内には到達せず。末尾サンプルからべき乗則で外挿。`);
    }
    console.log(`  最終サンプル: t=${r.samples[r.samples.length - 1]!.t}s, diff=${r.samples[r.samples.length - 1]!.diff.toFixed(3)}m`);
    results.push({ dt, label: `dt=${dt.toFixed(4)}s`, tCrossSec: tCross, extrapolated });
  }

  console.log('\n## 実験2-C: ワープ倍率ごとの sawtooth 周期(実時間換算)\n');
  console.log('倍率 | per-substep dt[s] | 乖離許容量到達までの simTime[s] | 同・日数 | 実時間換算[s] | 何フレームごとか(60fps)');
  console.log('--- | --- | --- | --- | --- | ---');
  for (const w of SIM_SPEED_LEVELS) {
    const dt = warpToDt.get(w)!;
    const match = dt <= 5
      ? results.find((r) => r.dt === 5)!
      : results.find((r) => Math.abs(r.dt - dt) < 1e-6)!;
    const tCross = match.tCrossSec;
    if (tCross === null) {
      console.log(`${w} | ${dt.toFixed(4)} | 不明(外挿失敗) | - | - | -`);
      continue;
    }
    const simDtPerFrame = w / 60;
    const framesToDiscard = tCross / simDtPerFrame;
    const realSecToDiscard = framesToDiscard / 60;
    const flag = match.extrapolated ? '(外挿)' : '(実測)';
    console.log(`${w} | ${dt.toFixed(4)} | ${tCross.toFixed(0)}${flag} | ${(tCross / 86400).toFixed(2)} | ${realSecToDiscard.toFixed(1)} | ${framesToDiscard.toFixed(0)}`);
  }
}

export function run(): void {
  console.log('# 実験2: 乖離が許容量に達するまでの時間');
  const ephemeris = buildEphemeris();
  const tolerance = partTolerance();
  partCrossing(ephemeris, tolerance);
}

if (require.main === module) run();
