// 需要(TrajectoryDemand)が計算量しか変えないこと(ARCHITECTURE R4)の回帰。需要の項目
// (予測を伸ばす長さ・履歴を残す長さ・計画の弧)を1つずつ変えて実シミュレーションを同じ歩数進め、
// 同じ時刻の状態がビット単位で一致することを、弧をなぞる個体と推力で弧を離れる個体の両方で固定する。
// 弧をなぞった状態はサンプル時刻に一致しなければ Hermite 補間の結果になるので、ここで比べるのは
// 需要の違う2つの進行の結果どうしである。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { fixedMotion } from '../physics/test-helpers';
import { add, v3, type Vec3 } from '../../src/math/vec3';
import type { CelestialBody } from '../../src/physics/celestial-body';
import { kinematicState, type KinematicState } from '../../src/physics/kinematic-state';
import { MU_EARTH, R_EARTH } from '../../src/game/celestial/solar-system/earth-system';
import type { CelestialBodies } from '../../src/game/celestial/celestial-bodies';
import { DynamicMotion } from '../../src/game/dynamic/dynamic-motion';
import { Predictor } from '../../src/game/dynamic/predictor';
import { DEFAULT_HISTORY_DURATION, PredictedArc } from '../../src/game/dynamic/predicted-arc';
import type {
  DynamicReactionServices, PredictableMotionRoster,
} from '../../src/game/dynamic/dynamic-simulation-participant';
import type { TrajectoryDemand } from '../../src/game/dynamic/trajectory-demand';

// 1フレームの時間送り [s] と、進めるフレーム数。
const SIM_DT = 5;
const FRAMES = 120;
// 天体位置を厳密に引く時刻。地球を静止させてあるので値は結果に効かない。
const PIVOT = 0;
const HOUR = 3600;
const DAY = 86400;

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

// 計画の区間の弧1本。個体と同じ時刻に速度を足した起点から 28 日先まで伸ばすので、進めるあいだ
// 毎フレーム予算を使い続ける。
function planArc(): PredictedArc {
  const ship = circularState();
  const state0 = kinematicState<'eci'>(ship.t, ship.r, add(ship.v, v3(0, 100, 0)));
  const arc = new PredictedArc(
    state0, earthOnlyBodies(), /* radius */ 0, 0, 0, /* keplerTail */ false, /* consumable */ false);
  arc.demand(state0.t + 28 * DAY, state0.t);
  return arc;
}

// 1回ぶんの進行の結果。
interface FrameRun {
  // 各歩の直後の状態。
  readonly states: readonly KinematicState[];
  // そのうち弧をなぞって積分を省いた歩数。
  readonly followed: number;
  // 最後のフレームで予測の先端が届いた時刻 [s]。
  readonly predictedEnd: number;
  // 進め終えた時点で残っている履歴の標本数。
  readonly historySamples: number;
  // 計画の弧が起点から伸びた長さの最大 [s]。弧が無ければ 0。
  readonly planArcReach: number;
}

// 需要 demand を毎フレーム与え、予測器で弧を伸ばしながら実シミュレーションを FRAMES 歩進める。
// thrust [m/s², ECI] を与えた個体は、弧が届いていても積分する。
function runFrames(demand: TrajectoryDemand, thrust: Vec3 | null): FrameRun {
  const bodies = earthOnlyBodies();
  const motion = new DynamicMotion(circularState(), {
    historyDuration: DEFAULT_HISTORY_DURATION,
    followsPredictedArc: true,
  });
  motion.setThrust(thrust);
  const roster: PredictableMotionRoster = { allMotions: () => [motion] };
  const predictor = new Predictor(roster, celestialBodiesOf(bodies));
  const services = reactionServices();

  const states: KinematicState[] = [];
  let followed = 0;
  let predictedEnd = motion.state.t;
  for (let i = 0; i < FRAMES; i++) {
    // 位相の順序は run.ts と同じ — 需要を先に立て(履歴の長さを求め、予測器が弧を伸ばし)、
    // それから1歩進める。
    motion.requestHistoryDuration(demand.historyDuration);
    predictor.update(motion.state.t, SIM_DT, motion, demand);
    predictedEnd = motion.predicted?.state.t ?? motion.state.t;
    const integrated = motion.stepSimulation(SIM_DT, bodies, bodies, null, null, PIVOT, services);
    if (!integrated) followed++;
    states.push(motion.state);
  }
  return {
    states,
    followed,
    predictedEnd,
    historySamples: motion.actual.samplesOldestFirst().length,
    planArcReach: Math.max(0, ...demand.planArcs.map((arc) => arc.trajectory.state.t - arc.state0.t)),
  };
}

// 基準の需要。ここから1項目ずつ変える。
const BASE_DEMAND: TrajectoryDemand = { horizon: HOUR, historyDuration: 0, planArcs: [] };

// 基準から1項目だけ変えた需要と、その項目が計算に効いたかの判定。計画の弧は伸ばすと中身が
// 変わるので、進行ごとに作り直す。
interface DemandVariant {
  readonly name: string;
  readonly demand: () => TrajectoryDemand;
  readonly computed: (base: FrameRun, run: FrameRun) => boolean;
}

const VARIANTS: readonly DemandVariant[] = [
  {
    name: '予測を伸ばす長さ',
    demand: () => ({ ...BASE_DEMAND, horizon: 28 * DAY }),
    computed: (base, run) => run.predictedEnd > base.predictedEnd,
  },
  {
    name: '履歴を残す長さ',
    demand: () => ({ ...BASE_DEMAND, historyDuration: 365 * DAY }),
    computed: (base, run) => run.historySamples !== base.historySamples,
  },
  {
    name: '計画の弧',
    demand: () => ({ ...BASE_DEMAND, planArcs: [planArc()] }),
    computed: (_base, run) => run.planArcReach > 0,
  },
];

// 推力 thrust の個体を、基準の需要と各項目を変えた需要とで進めて比べる。followedSteps は、
// どの需要でも弧をなぞるはずの歩数。
function assertDemandIndependent(thrust: Vec3 | null, followedSteps: number): void {
  const base = runFrames(BASE_DEMAND, thrust);
  assert.equal(base.followed, followedSteps, `前提: 基準の需要で弧をなぞった歩数が ${followedSteps} でない`);
  for (const variant of VARIANTS) {
    const run = runFrames(variant.demand(), thrust);
    assert.equal(run.followed, followedSteps, `前提: ${variant.name}を変えると弧をなぞる歩数が変わった`);
    // 効いていなければ一致は自明になる。
    assert.ok(variant.computed(base, run), `前提: ${variant.name}が計算量に効いていない`);
    assert.deepEqual(run.states, base.states, `${variant.name}を変えると実シミュレーションの状態が変わった`);
  }
}

export function register(): void {
  test('trajectory-demand: 需要のどの項目を変えても、弧をなぞる個体の状態はビット単位で変わらない', () => {
    // ARCHITECTURE R4「需要が変えてよいのは計算量だけ」
    assertDemandIndependent(null, FRAMES);
  });

  test('trajectory-demand: 推力のある個体でも、需要のどの項目を変えても状態はビット単位で変わらない', () => {
    // ARCHITECTURE R4「需要が変えてよいのは計算量だけ」
    assertDemandIndependent(v3(0, 0.1, 0), 0);
  });
}
