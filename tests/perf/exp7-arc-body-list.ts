// 実験7: 統一積分弧が引く天体を「効きうるものだけの一覧」へ絞ったときの軌道差。
//
// 比べるのは窓の作り方だけで、刻み幅は揃える: 弧(PredictedArc)を1歩ずつ伸ばしてその歩の
// 到達時刻を記録し、同じ時刻列を全重力天体(mu≠0 の64体)で積分し直した基準と突き合わせる。
// 刻み幅も歩の切れ目も同一なので、差はまるごと「窓から落とした天体の寄与」になる。
//
// 合否は乖離判定の許容(PREDICT_RESET_DIST = 500m、実際は間引き補間ぶん拡大される)。
// 乖離判定が見るのは弧の起点側の時刻なので、遠端の差ではなく各チェックポイントの差を見る。
import { PredictedArc } from '../../src/game/simulation/predicted-arc';
import type { FutureAttractorProvider } from '../../src/game/simulation/arc-bodies';
import { Ephemeris } from '../../src/physics/ephemeris';
import { KinematicState, kinematicState } from '../../src/physics/kinematic-state';
import { add, cross, lenSq, scale, v3, Vec3 } from '../../src/physics/vec3';
import { MU_MOON, R_MOON } from '../../src/physics/solar-system';
import {
  MU_EARTH, R_EARTH, SHIP_BCINV, PREDICT_RESET_DIST,
  buildEphemeris, initialLeoState, stepDynamicsAt, posError,
} from './common';

// 解析天体だけを候補に持つ provider(動的個体を置かないので候補は registry そのもの)。
function registryProvider(ephemeris: Ephemeris): FutureAttractorProvider {
  const candidates = Object.values(ephemeris.registry).map((def) => ({
    id: def.id, mu: def.mu, radius: def.radius, analytic: true, collision: true,
  }));
  return {
    revision: 0,
    candidateRevision: 0,
    candidates: () => candidates,
    bodyAt: (id, t) => ephemeris.attractorAt(id, t),
  };
}

type ArcRun = { states: KinematicState[]; times: number[]; steps: number; maxBodies: number };

// 弧を span ぶん伸ばし、各歩の到達時刻と、checkpoints 直後の状態を集める。
function runArc(
  ephemeris: Ephemeris, state0: KinematicState, span: number, checkpoints: readonly number[],
): ArcRun {
  const arc = new PredictedArc(state0, registryProvider(ephemeris), SHIP_BCINV, 0, true);
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

const m3 = (m: number) => m.toFixed(3);

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

  console.log(`許容 = PREDICT_RESET_DIST ${PREDICT_RESET_DIST}m(実際は間引き補間ぶん拡大される)\n`);
  console.log('  軌道 | span | 歩数 | 解決天体 max | 差 1/4 [m] | 差 2/4 [m] | 差 3/4 [m] | 遠端 [m]');
  console.log('  --- | --- | --- | --- | --- | --- | --- | ---');
  for (const c of cases) {
    const checkpoints = [1, 2, 3, 4].map((i) => c.state0.t + (c.span * i) / 4);
    const arc = runArc(ephemeris, c.state0, c.span, checkpoints);
    const refs = runReference(ephemeris, c.state0, arc.times, checkpoints);
    const diffs = checkpoints.map((_, i) => posError(arc.states[i]!, refs[i]!));
    console.log(
      `  ${c.label} | ${(c.span / day).toFixed(0)}日 | ${arc.steps} | ${arc.maxBodies}`
      + ` | ${diffs.map(m3).join(' | ')}`,
    );
  }

  // 起点側の差(乖離判定が実際に見る量)を、1周ぶんの短い span で確かめる。
  console.log('\n## 乖離判定が見る近端の差(LEO 1周)\n');
  const leoRev = 2 * Math.PI * Math.sqrt(((R_EARTH + 420e3) ** 3) / MU_EARTH);
  const near = circularCase('LEO 420km', R_EARTH + 420e3, 97, leoRev);
  const cps = [0.25, 0.5, 0.75, 1].map((f) => near.state0.t + leoRev * f);
  const arcNear = runArc(ephemeris, initialLeoState(), leoRev, cps);
  const refNear = runReference(ephemeris, initialLeoState(), arcNear.times, cps);
  for (let i = 0; i < cps.length; i++) {
    const d = posError(arcNear.states[i]!, refNear[i]!);
    console.log(`  t=${(cps[i]! - near.state0.t).toFixed(0)}s: ${d.toFixed(2)} m`);
  }
  console.log(`  (1周 ${leoRev.toFixed(0)}s, 歩数 ${arcNear.steps}, 解決天体 max ${arcNear.maxBodies})`);
}

if (require.main === module) run();
