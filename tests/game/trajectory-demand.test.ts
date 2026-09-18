// 需要(TrajectoryDemand)が計算量しか変えないこと(CODING-RULE 1.3 R4)の回帰。horizon だけを
// 変えて実シミュレーションを同じ歩数進め、同じ時刻の状態がビット単位で一致することを固定する。
// 弧をなぞった状態はサンプル時刻に一致しなければ Hermite 補間の結果になるので、ここで比べるのは
// horizon の違う2つのなぞり結果どうしである。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { fixedMotion } from '../physics/test-helpers';
import { v3 } from '../../src/math/vec3';
import type { CelestialBody } from '../../src/physics/celestial-body';
import { kinematicState, type KinematicState } from '../../src/physics/kinematic-state';
import { MU_EARTH, R_EARTH } from '../../src/game/celestial/solar-system/earth-system';
import type { CelestialBodies } from '../../src/game/celestial/celestial-bodies';
import { DynamicMotion } from '../../src/game/dynamic/dynamic-motion';
import { Predictor } from '../../src/game/dynamic/predictor';
import { DEFAULT_HISTORY_DURATION } from '../../src/game/dynamic/predicted-arc';
import type {
  DynamicReactionServices, PredictableMotionRoster,
} from '../../src/game/dynamic/dynamic-simulation-participant';
import type { TrajectoryDemand } from '../../src/game/dynamic/trajectory-demand';

// 1フレームの時間送り [s] と、進めるフレーム数。
const SIM_DT = 5;
const FRAMES = 120;
// 天体位置を厳密に引く時刻。地球を静止させてあるので値は結果に効かない。
const PIVOT = 0;

// 高度 420km の円軌道。
function circularState(): KinematicState<'eci'> {
  const r0 = R_EARTH + 420e3;
  return kinematicState<'eci'>(0, v3(r0, 0, 0), v3(0, Math.sqrt(MU_EARTH / r0), 0));
}

// 大気を持たない地球1体だけの顔ぶれ。地球は ECI 原点に静止する。
function earthOnlyBodies(): readonly CelestialBody[] {
  return [
    fixedMotion({
      id: 'earth', mu: MU_EARTH, radius: R_EARTH,
      state: kinematicState<'eci'>(0, v3(), v3()), accel: v3(), degree2: null, atmosphere: null,
    }),
  ];
}

// 予測器が読む面(登録天体の一覧)の最小の代役。
function celestialBodiesOf(bodies: readonly CelestialBody[]): CelestialBodies {
  return { celestialMotions: bodies } as unknown as CelestialBodies;
}

// 反応を持たない個体の進行が受け取る面の最小の代役。
function reactionServices(): DynamicReactionServices {
  return {} as unknown as DynamicReactionServices;
}

// 1回ぶんの進行の結果。
interface FrameRun {
  // 各歩の直後の状態。
  readonly states: readonly KinematicState[];
  // そのうち弧をなぞって積分を省いた歩数。
  readonly followed: number;
  // 進め終えた時点で予測の先端が届いていた時刻 [s]。
  readonly predictedEnd: number;
}

// horizon だけを与えて、予測器で弧を伸ばしながら実シミュレーションを FRAMES 歩進める。
// 推力は与えないので、弧が届いている歩は弧をなぞる。
function runFrames(horizon: number): FrameRun {
  const bodies = earthOnlyBodies();
  const motion = new DynamicMotion(circularState(), {
    historyDuration: DEFAULT_HISTORY_DURATION,
    followsPredictedArc: true,
  });
  const roster: PredictableMotionRoster = { allMotions: () => [motion] };
  const predictor = new Predictor(roster, celestialBodiesOf(bodies));
  const demand: TrajectoryDemand = { horizon, historyDuration: 0, planArcs: [] };
  const services = reactionServices();

  const states: KinematicState[] = [];
  let followed = 0;
  for (let i = 0; i < FRAMES; i++) {
    // 位相の順序は run.ts と同じ — 需要を先に立て、予測器が弧を伸ばしてから1歩進める。
    predictor.update(motion.state.t, SIM_DT, motion, demand);
    const integrated = motion.stepSimulation(SIM_DT, bodies, bodies, null, null, PIVOT, services);
    if (!integrated) followed++;
    states.push(motion.state);
  }
  return { states, followed, predictedEnd: motion.predicted?.state.t ?? motion.state.t };
}

export function register(): void {
  test('trajectory-demand: horizon を変えても実シミュレーションの状態はビット単位で変わらない', () => {
    const short = runFrames(3600); // 1時間
    const long = runFrames(28 * 86400); // 28日

    // 前提1: どちらの run も弧が届いていて、全歩が実際になぞられている。
    assert.equal(short.followed, FRAMES, '短い horizon でも全歩が弧をなぞるはず');
    assert.equal(long.followed, FRAMES, '長い horizon でも全歩が弧をなぞるはず');
    // 前提2: horizon は計算量には効いている(効いていなければ一致は自明になる)。
    assert.ok(
      long.predictedEnd > short.predictedEnd,
      `長い horizon のほうが予測は先まで伸びるはず: ${short.predictedEnd} / ${long.predictedEnd}`);

    // 本題: 同じ歩数を進めた各歩の時刻・位置・速度が、horizon によらず一致する。
    assert.deepEqual(short.states, long.states, '実シミュレーションの状態が horizon で変わってはいけない');
  });
}
