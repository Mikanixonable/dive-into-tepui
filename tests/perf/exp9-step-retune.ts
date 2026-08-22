// 実験9: ARC_STEPS_PER_REV / ARC_MIN_STEP_DT の値の根拠。4つの表示域それぞれについて
// この2定数の全組み合わせ(4×5=20通り)を掃引し、表示期間の遠端に残る形状誤差と、その区間を
// 積分するのに要した総ステップ数(= 予測1本ぶんの積分コストに比例)を並べて読む。
// 一度に1パラメータだけを動かす exp6 に対し、こちらが要るのは2定数が互いを上書きするため:
// period/ARC_STEPS_PER_REV が ARC_MIN_STEP_DT を割る領域 — LEO と離心軌道の近地点通過 —
// では床のほうが採用値になるので、片方ずつ振っても効きが読めない。
//
// 刻み幅ポリシー・誤差分解(局所基底 radial/along/cross)・各ケースの初期状態組み立ては
// exp6-arc-far-end-error.ts と同じ(ARC_MAX_STEPS はこの掃引の対象外なので現行値で固定)。
import { Ephemeris } from '../../src/physics/ephemeris';
import { CelestialBody, orbitalElementsOf, strongestAttractor } from '../../src/physics/celestial-body';
import { keplerPeriod } from '../../src/physics/elements';
import { KinematicState, kinematicState } from '../../src/physics/kinematic-state';
import { add, cross, dot, len, norm, sub, v3, Vec3 } from '../../src/physics/vec3';
import { MU_MOON, R_MOON } from '../../src/physics/solar-system';
import {
  MU_EARTH, R_EARTH,
  ARC_MAX_STEPS,
  buildEphemeris, initialLeoState, stepDynamicsAt, integrateFixedDt, posError,
} from './common';

const APPROACH_SAFETY = 0.5;

type StepPolicy = { minStepDt: number; stepsPerRev: number; maxSteps: number };

// predicted-arc.ts の stepDt の複製(exp6 と同一)。
function policyDt(
  tip: KinematicState, span: number, policy: StepPolicy, window: readonly CelestialBody[],
): number {
  const center = strongestAttractor(tip.r, window);
  const period = keplerPeriod(len(sub(tip.r, center.state.r)), center.mu);
  const naturalDt = period / policy.stepsPerRev;
  const coarseFloor = span / policy.maxSteps;
  let approachDt = Infinity;
  for (const body of window) {
    if (body.radius <= 0) continue;
    const relR = sub(tip.r, body.state.r);
    const dist = len(relR);
    const clearance = dist - body.radius;
    if (clearance <= 0) continue;
    const closingRate = -dot(relR, sub(tip.v, body.state.v)) / dist;
    if (closingRate <= 1e-9) continue;
    approachDt = Math.min(approachDt, (clearance / closingRate) * APPROACH_SAFETY);
  }
  return Math.max(policy.minStepDt, Math.min(span, approachDt, Math.max(naturalDt, coarseFloor)));
}

function integrateWithPolicy(
  ephemeris: Ephemeris, state0: KinematicState, span: number, policy: StepPolicy, endT: number,
): { state: KinematicState; steps: number } {
  let s = state0;
  let steps = 0;
  let window = ephemeris.gravityAttractorsAt(state0.t);
  while (endT - s.t > 1e-9) {
    const dt = Math.min(policyDt(s, span, policy, window), endT - s.t);
    s = stepDynamicsAt(ephemeris, s, dt);
    window = ephemeris.gravityAttractorsAt(s.t);
    steps++;
  }
  return { state: s, steps };
}

function decompose(
  ephemeris: Ephemeris, ref: KinematicState, test: KinematicState,
): { radial: number; along: number; crossTrack: number } {
  const window = ephemeris.gravityAttractorsAt(ref.t);
  const center = strongestAttractor(ref.r, window);
  const relR = sub(ref.r, center.state.r);
  const relV = sub(ref.v, center.state.v);
  const rHat = norm(relR);
  const hHat = norm(cross(relR, relV));
  const alongHat = norm(cross(hHat, rHat));
  const d = sub(test.r, ref.r);
  return { radial: dot(d, rHat), along: dot(d, alongHat), crossTrack: dot(d, hHat) };
}

type OrbitCase = { label: string; state0: KinematicState; span: number; refDt: number };

function leoCase(): OrbitCase {
  const r0 = R_EARTH + 420e3;
  const span = 2 * Math.PI * Math.sqrt(r0 ** 3 / MU_EARTH);
  return { label: 'LEO 420km 1周(既定表示期間)', state0: initialLeoState(), span, refDt: 5 };
}

function geoCase(): OrbitCase {
  const r0 = 42_164e3;
  const v = Math.sqrt(MU_EARTH / r0);
  return {
    label: 'GEO 静止軌道 28日',
    state0: kinematicState(0, v3(r0, 0, 0), v3(0, 0, -v)),
    span: 28 * 86400, refDt: 10,
  };
}

function molniyaCase(): OrbitCase {
  const rp = R_EARTH + 500e3;
  const a = 26_600e3;
  const vp = Math.sqrt(MU_EARTH * (2 / rp - 1 / a));
  const inc = (63.4 * Math.PI) / 180;
  return {
    label: 'モルニヤ e=0.74 1日',
    state0: kinematicState(0, v3(rp, 0, 0), v3(0, vp * Math.sin(inc), -vp * Math.cos(inc))),
    span: 86400, refDt: 5,
  };
}

function lunarCase(ephemeris: Ephemeris): OrbitCase {
  const moon = ephemeris.stateOf('moon', 0);
  const r0 = R_MOON + 100e3;
  const v = Math.sqrt(MU_MOON / r0);
  const span = 2 * Math.PI * Math.sqrt(r0 ** 3 / MU_MOON);
  const offset: Vec3 = v3(r0, 0, 0);
  const vel: Vec3 = v3(0, v, 0);
  return {
    label: '低月周回 100km 1周(既定表示期間)',
    state0: kinematicState(0, add(moon.r, offset), add(moon.v, vel)),
    span, refDt: 5,
  };
}

const STEPS_PER_REV_GRID = [50, 100, 150, 300];
const MIN_STEP_DT_GRID = [20, 40, 60, 100, 200];

export function run(): void {
  console.log('# 実験9: ARC_STEPS_PER_REV × ARC_MIN_STEP_DT 掃引(表示期間遠端の形状誤差)\n');
  console.log(`ARC_MAX_STEPS は現行値 ${ARC_MAX_STEPS} に固定。`);
  console.log('各セルは「動径[m] / 面外[m] (歩数)」。動径・面外は表示期間の遠端での局所基底誤差、');
  console.log('歩数はその区間を積分するのに要した総ステップ数(=予測1本ぶんの積分コストに比例)。\n');

  const ephemeris = buildEphemeris();
  const cases: OrbitCase[] = [leoCase(), geoCase(), molniyaCase(), lunarCase(ephemeris)];

  for (const c of cases) {
    console.log(`\n## ${c.label}(span=${c.span.toFixed(0)}s, 基準 dt=${c.refDt}s)\n`);
    const endT = c.state0.t + c.span;
    const t0 = performance.now();
    const ref = integrateFixedDt(ephemeris, c.state0, c.refDt, endT);
    console.log(`  (基準積分 ${(performance.now() - t0).toFixed(0)}ms)`);

    // 基準解の刻みが十分細かいか: refDt/2 で取り直し、終端位置差を掃引で見る誤差スケールと比べる。
    // これが掃引の誤差(下の表の動径/面外)より十分小さければ、基準解自体の誤差は無視できる。
    const t0b = performance.now();
    const refFine = integrateFixedDt(ephemeris, c.state0, c.refDt / 2, endT);
    const refConvergence = posError(ref, refFine);
    console.log(`  (基準解の収束チェック: dt=${c.refDt}s と dt=${c.refDt / 2}s の終端位置差 = ${refConvergence.toExponential(3)}m, 収束チェック積分 ${(performance.now() - t0b).toFixed(0)}ms)\n`);

    const header = ['ARC_STEPS_PER_REV \\ ARC_MIN_STEP_DT', ...MIN_STEP_DT_GRID.map((d) => `${d}s`)];
    console.log('  ' + header.join(' | '));
    console.log('  ' + header.map(() => '---').join(' | '));
    for (const spr of STEPS_PER_REV_GRID) {
      const cells: string[] = [];
      for (const minDt of MIN_STEP_DT_GRID) {
        const policy: StepPolicy = { minStepDt: minDt, stepsPerRev: spr, maxSteps: ARC_MAX_STEPS };
        const { state, steps } = integrateWithPolicy(ephemeris, c.state0, c.span, policy, endT);
        const d = decompose(ephemeris, ref, state);
        cells.push(`${d.radial.toFixed(1)} / ${d.crossTrack.toFixed(1)} (${steps})`);
      }
      console.log(`  **${spr}** | ` + cells.join(' | '));
    }
  }
}

if (require.main === module) run();
