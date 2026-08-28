// 実験6: 統一積分弧(game/simulation/predicted-arc.ts)の刻み幅ポリシーが、表示期間の遠端に
// 残す誤差の分解測定。A-7(ARC_STEPS_PER_REV / ARC_MAX_STEPS / ARC_MIN_STEP_DT の値)の判断材料。
//
// マップで見えるのは折れ線の「形」なので、誤差は基準軌道の局所基底へ分解して読む:
// 動径(radial)と面外(cross)のずれは線の形を歪めて画面に出るが、進行方向(along)のずれは
// 位相の遅速でしかなく、閉軌道が重なって描かれるマップ表示では見えない。
// 判断基準は「動径・面外のずれが、その表示スケールの1px(全周表示の LEO で約20km)を跨ぐか」。
//
// 刻み幅ポリシーは predicted-arc.ts の stepDt の複製(パラメーター化)。接近項の衝突体は
// 原本の中点窓(101体)ではなく重力窓(64体)で代用する — 接近項に効くのは半径を持つ近傍の
// 大質量天体だけなので、結論には影響しない。重力源は共通の stepDynamicsAt(全64天体・
// グリッド絞り込みなし・SRPなし)で、比較する全構成と基準積分に同一に効く。
import { Ephemeris } from '../../src/physics/ephemeris';
import { CelestialBody, orbitalElementsOf, strongestAttractor } from '../../src/physics/celestial-body';
import { keplerPeriod } from '../../src/physics/elements';
import { KinematicState, kinematicState } from '../../src/physics/kinematic-state';
import { add, cross, dot, len, norm, sub, v3, Vec3 } from '../../src/math/vec3';
import { MU_MOON, R_MOON } from '../../src/physics/solar-system';
import {
  MU_EARTH, R_EARTH,
  ARC_MIN_STEP_DT, ARC_STEPS_PER_REV, ARC_MAX_STEPS,
  buildEphemeris, initialLeoState, stepDynamicsAt, integrateFixedDt,
} from './common';

// predicted-arc.ts の ARC_APPROACH_SAFETY の複製(const.ts から import できるが、
// この実験ではポリシー一式をここに閉じる)。
const APPROACH_SAFETY = 0.5;

type StepPolicy = { minStepDt: number; stepsPerRev: number; maxSteps: number; label: string };

// predicted-arc.ts の stepDt の複製。span は表示期間(requiredEnd - retainFrom)で固定。
function policyDt(
  tip: KinematicState, span: number, policy: StepPolicy, window: readonly CelestialBody[],
): number {
  const center = strongestAttractor(tip.r, window);
  const period = keplerPeriod(len(sub(tip.r, center.state.r)), center.mu);
  const naturalDt = period / policy.stepsPerRev;
  const coarseFloor = span / policy.maxSteps;
  // 接近項: 動径接近率が正(接近中)の天体だけ、表面までの残距離ぶんの猶予を見る。
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

// チェックポイント時刻へ正確に着地しながら span ぶん積分し、各チェックポイントの状態を返す。
function integrateWithPolicy(
  ephemeris: Ephemeris, state0: KinematicState, span: number, policy: StepPolicy,
  checkpoints: readonly number[],
): { states: KinematicState[]; steps: number } {
  let s = state0;
  let steps = 0;
  const states: KinematicState[] = [];
  const window0 = ephemeris.gravityAttractorsAt(state0.t);
  let window = window0;
  for (const cp of checkpoints) {
    while (cp - s.t > 1e-9) {
      // チェックポイントを跨がないよう最後の1歩だけ縮める(誤差の比較点を両者で揃えるため)。
      const dt = Math.min(policyDt(s, span, policy, window), cp - s.t);
      s = stepDynamicsAt(ephemeris, s, dt);
      window = ephemeris.gravityAttractorsAt(s.t);
      steps++;
    }
    states.push(s);
  }
  return { states, steps };
}

// 基準(固定 dt)積分で同じチェックポイント列の状態を得る。
function integrateReference(
  ephemeris: Ephemeris, state0: KinematicState, dt: number, checkpoints: readonly number[],
): KinematicState[] {
  let s = state0;
  const states: KinematicState[] = [];
  for (const cp of checkpoints) {
    s = integrateFixedDt(ephemeris, s, dt, cp);
    states.push(s);
  }
  return states;
}

// 誤差を基準状態の中心天体相対の局所基底(動径・進行・面外)へ分解する。
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

// 中心天体まわりの長半径 [m]。双曲線なら NaN。
function semiMajor(ephemeris: Ephemeris, s: KinematicState): number {
  const window = ephemeris.gravityAttractorsAt(s.t);
  const center = strongestAttractor(s.r, window);
  return orbitalElementsOf(s, center)?.a ?? NaN;
}

type OrbitCase = { label: string; state0: KinematicState; span: number; refDt: number };

// 各ケースの基準積分 dt は、最も細かい構成(20s)より 2〜4 倍細かく取る(長い span は計算量の
// 都合で 10s)。以下のケース生成はいずれも初期状態と span を束ねるだけ。
function leoCase(span: number, label: string): OrbitCase {
  return { label, state0: initialLeoState(), span, refDt: span > 1e6 ? 10 : 5 };
}

function geoCase(span: number): OrbitCase {
  const r0 = 42_164e3;
  const v = Math.sqrt(MU_EARTH / r0);
  return {
    label: `GEO 静止軌道 ${fmtSpan(span)}`,
    state0: kinematicState(0, v3(r0, 0, 0), v3(0, 0, -v)),
    span, refDt: span > 1e6 ? 10 : 5,
  };
}

function molniyaCase(span: number): OrbitCase {
  const rp = R_EARTH + 500e3;
  const a = 26_600e3;
  const vp = Math.sqrt(MU_EARTH * (2 / rp - 1 / a));
  const inc = (63.4 * Math.PI) / 180;
  return {
    label: `モルニヤ e=0.74 ${fmtSpan(span)}`,
    state0: kinematicState(0, v3(rp, 0, 0), v3(0, vp * Math.sin(inc), -vp * Math.cos(inc))),
    span, refDt: span > 1e6 ? 10 : 5,
  };
}

function lunarCase(ephemeris: Ephemeris, span: number): OrbitCase {
  const moon = ephemeris.stateOf('moon', 0);
  const r0 = R_MOON + 100e3;
  const v = Math.sqrt(MU_MOON / r0);
  const offset: Vec3 = v3(r0, 0, 0);
  const vel: Vec3 = v3(0, v, 0);
  return {
    label: `低月周回 100km ${fmtSpan(span)}`,
    state0: kinematicState(0, add(moon.r, offset), add(moon.v, vel)),
    span, refDt: 5,
  };
}

// ラベル用の期間表記。
function fmtSpan(span: number): string {
  if (span >= 86400 * 2) return `${(span / 86400).toFixed(0)}日`;
  if (span >= 86400) return '1日';
  return '1周';
}

const km = (m: number) => (Math.abs(m) >= 1e5 ? (m / 1e3).toFixed(0) : (m / 1e3).toFixed(2));

// 全ケース × 全構成を回して表を出す。28日ケースの基準積分が支配的で、全体で数分かかる。
export function run(): void {
  console.log('# 実験6: 弧の刻み幅ポリシーと遠端誤差(A-7)\n');
  const ephemeris = buildEphemeris();

  const policies: StepPolicy[] = [
    { label: `現行 ${ARC_MIN_STEP_DT}/${ARC_STEPS_PER_REV}/${ARC_MAX_STEPS}`, minStepDt: ARC_MIN_STEP_DT, stepsPerRev: ARC_STEPS_PER_REV, maxSteps: ARC_MAX_STEPS },
    { label: 'maxSteps 10000', minStepDt: ARC_MIN_STEP_DT, stepsPerRev: ARC_STEPS_PER_REV, maxSteps: 10000 },
    { label: 'maxSteps 40000', minStepDt: ARC_MIN_STEP_DT, stepsPerRev: ARC_STEPS_PER_REV, maxSteps: 40000 },
    { label: 'stepsPerRev 300', minStepDt: ARC_MIN_STEP_DT, stepsPerRev: 300, maxSteps: ARC_MAX_STEPS },
    { label: 'stepsPerRev 150', minStepDt: ARC_MIN_STEP_DT, stepsPerRev: 150, maxSteps: ARC_MAX_STEPS },
    { label: 'minStepDt 30', minStepDt: 30, stepsPerRev: ARC_STEPS_PER_REV, maxSteps: ARC_MAX_STEPS },
    { label: 'minStepDt 40', minStepDt: 40, stepsPerRev: ARC_STEPS_PER_REV, maxSteps: ARC_MAX_STEPS },
  ];

  const leoRev = 2 * Math.PI * Math.sqrt(((R_EARTH + 420e3) ** 3) / MU_EARTH);
  const lunarRev = 2 * Math.PI * Math.sqrt(((R_MOON + 100e3) ** 3) / MU_MOON);
  const cases: OrbitCase[] = [
    leoCase(leoRev, 'LEO 420km 1周'),
    leoCase(28 * 86400, 'LEO 420km 28日'),
    geoCase(28 * 86400),
    molniyaCase(86400),
    molniyaCase(28 * 86400),
    lunarCase(ephemeris, lunarRev),
    lunarCase(ephemeris, 7 * 86400),
  ];

  for (const c of cases) {
    console.log(`\n## ${c.label}(span=${c.span.toFixed(0)}s, 基準 dt=${c.refDt}s)\n`);
    const checkpoints = Array.from({ length: 8 }, (_, i) => c.state0.t + (c.span * (i + 1)) / 8);
    const t0 = performance.now();
    const refs = integrateReference(ephemeris, c.state0, c.refDt, checkpoints);
    const refMs = performance.now() - t0;
    console.log(`  (基準積分 ${refMs.toFixed(0)}ms)`);
    console.log('  構成 | 歩数 | 遠端 radial/cross/along [km] | max|radial| [km] | Δa [km] | 計算 [ms]');
    console.log('  --- | --- | --- | --- | --- | ---');
    for (const p of policies) {
      const t1 = performance.now();
      const { states, steps } = integrateWithPolicy(ephemeris, c.state0, c.span, p, checkpoints);
      const ms = performance.now() - t1;
      let maxRadial = 0;
      for (let i = 0; i < checkpoints.length; i++) {
        const d = decompose(ephemeris, refs[i]!, states[i]!);
        maxRadial = Math.max(maxRadial, Math.abs(d.radial));
      }
      const dEnd = decompose(ephemeris, refs[refs.length - 1]!, states[states.length - 1]!);
      const da = semiMajor(ephemeris, states[states.length - 1]!) - semiMajor(ephemeris, refs[refs.length - 1]!);
      console.log(
        `  ${p.label} | ${steps} | ${km(dEnd.radial)} / ${km(dEnd.crossTrack)} / ${km(dEnd.along)}`
        + ` | ${km(maxRadial)} | ${km(da)} | ${ms.toFixed(0)}`,
      );
    }
  }
}

if (require.main === module) run();
