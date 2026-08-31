// 実験7: 統一積分弧が引く天体を「効きうるものだけの一覧」へ絞ったときの軌道差。
//
// 比べるのは窓の作り方だけで、刻み幅は揃える: 弧(PredictedArc)を1歩ずつ伸ばしてその歩の
// 到達時刻を記録し、同じ時刻列を全重力天体(mu≠0 の64体)で積分し直した基準と突き合わせる。
// 刻み幅も歩の切れ目も同一なので、差はまるごと「窓から落とした天体の寄与」になる。
//
// 合否は窓の絞り込み自身が約束している精度から立てる: 落とした天体の加速度は
// GRAVITY_NEGLIGIBLE_ACCEL 未満なので、経過時間 T のあいだに積み上がる位置差は高々
// GRAVITY_NEGLIGIBLE_ACCEL * T² / 2。実シミュレーションが状態を引くのは弧の起点側なので、遠端の差
// ではなく各チェックポイントをその経過時間なりの許容と突き合わせる。
import { PredictedArc } from '../../src/game/simulation/predicted-arc';
import { ArcBodies, type FutureCelestialBodyProvider } from '../../src/game/simulation/arc-bodies';
import { attractorsNearInto, classifyAttractors } from '../../src/game/simulation/attractors';
import { Ephemeris } from '../../src/physics/ephemeris';
import { CelestialBody, attractorAccel } from '../../src/physics/celestial-body';
import { KinematicState, kinematicState } from '../../src/physics/kinematic-state';
import { add, cross, len, lenSq, scale, sub, v3, Vec3 } from '../../src/math/vec3';
import { MU_MOON, R_MOON } from '../../src/physics/solar-system/constants';
import {
  MU_EARTH, R_EARTH, SHIP_BCINV, GRAVITY_NEGLIGIBLE_ACCEL,
  buildEphemeris, initialLeoState, stepDynamicsAt, posError,
} from './common';

// registry の全天体を候補に持つ provider。
function registryProvider(ephemeris: Ephemeris): FutureCelestialBodyProvider {
  const candidates = Object.values(ephemeris.registry).map((def) => ({
    id: def.id, mu: def.mu, radius: def.radius,
  }));
  return {
    candidates: () => candidates,
    celestialBodyAt: (id, t) => ephemeris.celestialBodyAt(id, t),
  };
}

// 経過時間 elapsedSec のあいだ、大きさ GRAVITY_NEGLIGIBLE_ACCEL の加速度差が積み上がって
// 生みうる位置差の上限 [m]。
function negligibleAccelBudget(elapsedSec: number): number {
  return 0.5 * GRAVITY_NEGLIGIBLE_ACCEL * elapsedSec * elapsedSec;
}

type ArcRun = { states: KinematicState[]; times: number[]; steps: number; maxBodies: number };

// 弧を span ぶん伸ばし、各歩の到達時刻と、checkpoints 直後の状態を集める。
function runArc(
  ephemeris: Ephemeris, state0: KinematicState, span: number, checkpoints: readonly number[],
): ArcRun {
  const arc = new PredictedArc(
    state0, registryProvider(ephemeris), /* radius */ 0, SHIP_BCINV, 0,
    /* keplerTail */ true, /* consumable */ false,
  );
  arc.requiredEnd = state0.t + span;
  arc.retainFrom = state0.t;
  const times: number[] = [];
  const states: KinematicState[] = [];
  let maxBodies = 0;
  let next = 0;
  while (arc.step()) {
    const tip = arc.trajectory.state;
    times.push(tip.t);
    maxBodies = Math.max(maxBodies, arc.lastResolvedBodies);
    while (next < checkpoints.length && tip.t >= checkpoints[next]!) {
      states.push(tip);
      next++;
    }
    if (arc.truncated) break;
  }
  while (states.length < checkpoints.length) states.push(arc.trajectory.state);
  return { states, times, steps: times.length, maxBodies };
}

// 同じ時刻列を、全重力天体を毎歩渡して積分し直した基準。
function runReference(
  ephemeris: Ephemeris, state0: KinematicState, times: readonly number[], checkpoints: readonly number[],
): KinematicState[] {
  const states: KinematicState[] = [];
  let s = state0;
  let next = 0;
  for (const t of times) {
    s = stepDynamicsAt(ephemeris, s, t - s.t);
    while (next < checkpoints.length && t >= checkpoints[next]!) {
      states.push(s);
      next++;
    }
  }
  while (states.length < checkpoints.length) states.push(s);
  return states;
}

// pos, t における celestialBodies の加速度の合成。
function sumAccel(pos: Vec3, t: number, celestialBodies: readonly CelestialBody[]): Vec3 {
  let acc = v3(0, 0, 0);
  for (const a of celestialBodies) acc = add(acc, attractorAccel(pos, a, t));
  return acc;
}

// 同じ位置・時刻で (a) ArcBodies が絞る一覧 と (b) 実シミュレーション相当(27近傍グリッド、
// classifyAttractors/attractorsNearInto)の一覧 の加速度差 [m/s²]。弧が「予測」から
// 「実シミュレーションに消費される」側へ切り替わっても加速度が飛ばないことの確認 —
// 差が GRAVITY_NEGLIGIBLE_ACCEL を超えなければ、どちらの窓で評価しても運動方程式は
// 同じとみなせる。ArcBodies は毎回新規に作る — 初回の resolve は全候補を訪問するので
// (nextVisitT の初期値が -Infinity)、これは PredictedArc が自分の先端でその場作る
// 最初の窓と同じものになる。
function accelWindowDiff(ephemeris: Ephemeris, state: KinematicState): number {
  const bodies = new ArcBodies(registryProvider(ephemeris));
  const arcWindow = bodies.resolve(state.t, state, 0);
  const accelArc = sumAccel(state.r, state.t, arcWindow.gravity);

  const all = ephemeris.gravityAttractorsAt(state.t);
  const simNear: CelestialBody[] = [];
  attractorsNearInto(state.r, classifyAttractors(all), simNear);
  const accelSim = sumAccel(state.r, state.t, simNear);

  return len(sub(accelArc, accelSim));
}

type OrbitCase = { label: string; state0: KinematicState; span: number };

function circularCase(label: string, radius: number, incDeg: number, span: number): OrbitCase {
  const v = Math.sqrt(MU_EARTH / radius);
  const inc = (incDeg * Math.PI) / 180;
  return {
    label, span,
    state0: kinematicState(0, v3(radius, 0, 0), v3(0, v * Math.sin(inc), -v * Math.cos(inc))),
  };
}

function molniyaCase(span: number): OrbitCase {
  const rp = R_EARTH + 500e3;
  const a = 26_600e3;
  const vp = Math.sqrt(MU_EARTH * (2 / rp - 1 / a));
  const inc = (63.4 * Math.PI) / 180;
  return {
    label: 'モルニヤ e=0.74', span,
    state0: kinematicState(0, v3(rp, 0, 0), v3(0, vp * Math.sin(inc), -vp * Math.cos(inc))),
  };
}

function lunarCase(ephemeris: Ephemeris, span: number): OrbitCase {
  const moon = ephemeris.stateOf('moon', 0);
  const r0 = R_MOON + 100e3;
  const v = Math.sqrt(MU_MOON / r0);
  const offset: Vec3 = v3(r0, 0, 0);
  const vel: Vec3 = v3(0, v, 0);
  return {
    label: '低月周回 100km', span,
    state0: kinematicState(0, add(moon.r, offset), add(moon.v, vel)),
  };
}

// 地球-月 L1 に静止させた状態。共線点は回転系で静止するので、慣性系では月の公転角速度
// ω = (r × v)/|r|² で回る。
function lagrangeCase(ephemeris: Ephemeris, span: number): OrbitCase {
  const l1 = ephemeris.lagrangeAt('moon', 0).L1;
  const moon = ephemeris.stateOf('moon', 0);
  const omega = scale(cross(moon.r, moon.v), 1 / lenSq(moon.r));
  return { label: '地球-月 L1', span, state0: kinematicState(0, l1, cross(omega, l1)) };
}

type CaseRun = { c: OrbitCase; checkpoints: number[]; arc: ArcRun; refs: KinematicState[] };

function computeCase(ephemeris: Ephemeris, c: OrbitCase): CaseRun {
  const checkpoints = [1, 2, 3, 4].map((i) => c.state0.t + (c.span * i) / 4);
  const arc = runArc(ephemeris, c.state0, c.span, checkpoints);
  const refs = runReference(ephemeris, c.state0, arc.times, checkpoints);
  return { c, checkpoints, arc, refs };
}

// diff[m] と許容[m] を1セルへ整形する(diff/許容、超過なら末尾に ✗)。
function cell(diff: number, budget: number): string {
  return `${diff.toFixed(2)}/${budget.toFixed(1)}${diff <= budget ? '✓' : '✗'}`;
}

export function run(): void {
  console.log('# 実験7: 弧の天体一覧化による軌道差\n');
  const ephemeris = buildEphemeris();
  const day = 86400;
  const cases: OrbitCase[] = [
    circularCase('LEO 420km', R_EARTH + 420e3, 97, 28 * day),
    circularCase('GEO 静止軌道', 42_164e3, 0, 28 * day),
    molniyaCase(28 * day),
    lunarCase(ephemeris, 7 * day),
    lagrangeCase(ephemeris, 28 * day),
  ];
  const runs = cases.map((c) => computeCase(ephemeris, c));

  console.log('許容 = GRAVITY_NEGLIGIBLE_ACCEL * T² / 2(T=起点からの経過時間)。各セルは 差[m]/許容[m]。\n');
  console.log('  軌道 | span | 歩数 | 解決天体 max | 差 1/4 | 差 2/4 | 差 3/4 | 遠端');
  console.log('  --- | --- | --- | --- | --- | --- | --- | ---');
  for (const r of runs) {
    const cells = r.checkpoints.map((cp, i) => cell(
      posError(r.arc.states[i]!, r.refs[i]!),
      negligibleAccelBudget(cp - r.c.state0.t),
    ));
    console.log(
      `  ${r.c.label} | ${(r.c.span / day).toFixed(0)}日 | ${r.arc.steps} | ${r.arc.maxBodies}`
      + ` | ${cells.join(' | ')}`,
    );
  }

  // 起点側の差(実シミュレーションが実際に引く範囲)を、1周ぶんの短い span で確かめる。
  console.log('\n## 実シミュレーションが引く近端の差(LEO 1周)\n');
  const leoRev = 2 * Math.PI * Math.sqrt(((R_EARTH + 420e3) ** 3) / MU_EARTH);
  const near = circularCase('LEO 420km', R_EARTH + 420e3, 97, leoRev);
  const cps = [0.25, 0.5, 0.75, 1].map((f) => near.state0.t + leoRev * f);
  const arcNear = runArc(ephemeris, initialLeoState(), leoRev, cps);
  const refNear = runReference(ephemeris, initialLeoState(), arcNear.times, cps);
  for (let i = 0; i < cps.length; i++) {
    const d = posError(arcNear.states[i]!, refNear[i]!);
    const budget = negligibleAccelBudget(cps[i]! - near.state0.t);
    console.log(`  t=${(cps[i]! - near.state0.t).toFixed(0)}s: ${d.toFixed(2)} m (許容 ${budget.toFixed(1)} m)${d <= budget ? '✓' : '✗'}`);
  }
  console.log(`  (1周 ${leoRev.toFixed(0)}s, 歩数 ${arcNear.steps}, 解決天体 max ${arcNear.maxBodies})`);

  // 消費される弧(実シミュレーション)と予測弧のどちらの窓で評価しても加速度が飛ばないことの確認。
  console.log('\n## 消費と積分を行き来しても加速度が飛ばないことの確認(窓一致)\n');
  console.log(`許容 = GRAVITY_NEGLIGIBLE_ACCEL = ${GRAVITY_NEGLIGIBLE_ACCEL.toExponential(2)} m/s²\n`);
  console.log('  軌道 | 差 1/4 [m/s²] | 差 2/4 | 差 3/4 | 遠端');
  console.log('  --- | --- | --- | --- | ---');
  for (const r of runs) {
    const flags = r.arc.states.map((s) => {
      const d = accelWindowDiff(ephemeris, s);
      return `${d.toExponential(2)}${d <= GRAVITY_NEGLIGIBLE_ACCEL ? '✓' : '✗'}`;
    });
    console.log(`  ${r.c.label} | ${flags.join(' | ')}`);
  }
}

if (require.main === module) run();
