// 実験3: 1ステップあたりの重力源解決コスト。
// Ephemeris(解析モデル)を毎回異なる時刻 t で呼び、gravityAttractorsAt/attractorsAt/
// classifyAttractors/attractorsNear の単体コストと、Predictor.advanceBudget が1ステップに
// 払う分(classifyAttractors(gravityAttractorsAt(...)) を2回)を測る。
import { Ephemeris } from '../../src/physics/ephemeris';
import { Attractor, nearestAtmosphereBody } from '../../src/physics/attractor';
import { stepDynamics } from '../../src/physics/dynamics';
import {
  buildEphemeris, initialLeoState, classifyAttractors, attractorsNear,
  SHIP_BCINV, ARC_STEP_BUDGET,
} from './common';

// 毎回異なる t を作る(リングキャッシュに当たらないようにする)。無理数っぽい定数を掛けて
// 単純な等間隔サンプリングにしない。
function uniqueT(i: number, scale: number): number {
  return i * scale;
}

function bench(label: string, n: number, fn: (i: number) => void): number {
  const t0 = performance.now();
  for (let i = 0; i < n; i++) fn(i);
  const ms = performance.now() - t0;
  console.log(`${label}: ${((ms / n) * 1000).toFixed(2)} us/call (n=${n}, 合計 ${ms.toFixed(1)} ms)`);
  return ms / n; // ms/call
}

export function run(): void {
  console.log('# 実験3: 1ステップあたりの重力源解決コスト\n');
  const ephemeris = buildEphemeris();
  const s0 = initialLeoState();
  const N = 3000;

  console.log('## gravityAttractorsAt / attractorsAt 単体(毎回異なる t)\n');
  let bodyCountGravity = 0;
  const msGravity = bench('ephemeris.gravityAttractorsAt(t)', N, (i) => {
    const a = ephemeris.gravityAttractorsAt(uniqueT(i, 1.31));
    bodyCountGravity = a.length;
  });
  let bodyCountAll = 0;
  const msAll = bench('ephemeris.attractorsAt(t)', N, (i) => {
    const a = ephemeris.attractorsAt(uniqueT(i, 1.73));
    bodyCountAll = a.length;
  });
  console.log(`  (gravityAttractorsAt が返す天体数=${bodyCountGravity}, attractorsAt が返す天体数=${bodyCountAll})`);

  console.log('\n## classifyAttractors / attractorsNear 単体\n');
  // classify/attractorsNear のコストだけを見るため、入力配列は先に作っておく。
  const prefetched: Attractor[][] = [];
  for (let i = 0; i < N; i++) prefetched.push(ephemeris.gravityAttractorsAt(uniqueT(i, 2.11)).slice());
  let alwaysLen = 0, griddedNearLen = 0;
  const msClassify = bench('classifyAttractors(attractors)', N, (i) => {
    const c = classifyAttractors(prefetched[i]!);
    alwaysLen = c.always.length;
  });
  const classified = classifyAttractors(prefetched[0]!);
  const msNear = bench('attractorsNear(pos, classified)', N, () => {
    const near = attractorsNear(s0.r, classified);
    griddedNearLen = near.length;
  });
  console.log(`  (always側の天体数=${alwaysLen}, attractorsNear が返す総数=${griddedNearLen}, 全天体数64との比較)`);

  console.log('\n## stepDynamics 単体(64天体固定・LEO初期状態)\n');
  const fixedAttractors = ephemeris.gravityAttractorsAt(0);
  const fixedAtmosphere = nearestAtmosphereBody(s0.r, ephemeris.atmosphereAttractorsAt(0));
  let sAcc = s0;
  const msStep = bench('stepDynamics(64 attractors, fixed)', 20000, () => {
    sAcc = stepDynamics(sAcc, 1, fixedAttractors, fixedAtmosphere, SHIP_BCINV, 0, null);
  });
  void sAcc;

  console.log('\n## Predictor.advanceBudget が1ステップに払う分(src/game/simulation/predictor.ts:80-103)\n');
  console.log('advanceBudget の1反復は: ');
  console.log('  (1) classifyAttractors(gravityAttractorsAt(ephemeris, tipState.t))  … dt サイジング用');
  console.log('  (2) attractorsNearInto(tipState.r, currentClassified, scratch)      … 同上、局所周期を出すため');
  console.log('  (3) classifyAttractors(gravityAttractorsAt(ephemeris, tipState.t+dt/2)) … 実ステップ用');
  console.log('  (4) attractorsNearInto(tipState.r, stepClassified, scratch)         … 同上');
  console.log('  (5) 弧の1歩の中の stepDynamics 1回');
  console.log('を毎ステップ行う。\n');

  let tip = s0.t;
  const msPredictorStep = bench('advanceBudget 1反復相当(1+2+3+4+5)', N, (i) => {
    const t = tip + i * 37.0; // 毎回時刻をずらす(実際に予測が進むのと同じく毎回異なる t になる)
    const g1 = ephemeris.gravityAttractorsAt(t);
    const c1 = classifyAttractors(g1);
    const near1 = attractorsNear(s0.r, c1);
    void near1;
    const g2 = ephemeris.gravityAttractorsAt(t + 10);
    const c2 = classifyAttractors(g2);
    const near2 = attractorsNear(s0.r, c2);
    stepDynamics(
      s0, 20, near2, nearestAtmosphereBody(s0.r, ephemeris.atmosphereAttractorsAt(t + 10)),
      SHIP_BCINV, 0, null,
    );
  });

  console.log('\n## 内訳との比較\n');
  console.log(`  classifyAttractors(gravityAttractorsAt(...)) を2回 ≈ 2 × (${msGravity.toFixed(3)}(gravityAttractorsAt) + ${msClassify.toFixed(3)}(classify)) = ${(2 * (msGravity + msClassify)).toFixed(3)} ms/step`);
  console.log(`  attractorsNear を2回 ≈ 2 × ${msNear.toFixed(4)} ms/step`);
  console.log(`  stepDynamics 1回 ≈ ${msStep.toFixed(4)} ms/step`);
  console.log(`  advanceBudget 1反復(実測) = ${msPredictorStep.toFixed(3)} ms/step`);

  console.log('\n## 1フレームに N ステップ回すと何 ms になるか\n');
  console.log('N(ステップ数/フレーム) | advanceBudget相当[ms] | stepDynamics単体のみ[ms]');
  console.log('--- | --- | ---');
  for (const nSteps of [128, 256, 500, 1000]) {
    console.log(`${nSteps} | ${(msPredictorStep * nSteps).toFixed(2)} | ${(msStep * nSteps).toFixed(3)}`);
  }
  console.log(`\n(参考: ARC_STEP_BUDGET=${ARC_STEP_BUDGET} が実際の1フレーム上限)`);
}

if (require.main === module) run();
