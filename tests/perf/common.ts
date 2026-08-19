// tests/perf/ 配下の各実験が共有するヘルパ。src/ は一切変更しない — ここは新規ファイルのみ。
//
// game/simulation/attractors.ts の classifyAttractors/attractorsNear は EntityManager/GameEntity を
// import type で参照しているだけだが、tsc は import type でも型解決のためにモジュール全体を
// コンパイル対象へ引き込む。entity-manager.ts は three/webgpu・DOM 型に依存するため、
// tsconfig.test.json 相当(DOM/three 抜き)ではコンパイルできない(実際に試して確認した)。
// そのため classifyAttractors/attractorsNear のロジックをここへ複製する。
// GRAVITY_ALWAYS_COUNT・GRAVITY_NEGLIGIBLE_ACCEL は src/game/const.ts から素の値を import する
// (const.ts 自体は ../physics/solar-system しか import しておらず、DOM/three 非依存でコンパイルできる)。
import { Ephemeris } from '../../src/physics/ephemeris';
import { Attractor } from '../../src/physics/attractor';
import { SpatialGrid } from '../../src/physics/spatial-grid';
import { Vec3 } from '../../src/physics/vec3';
import { kinematicState, KinematicState } from '../../src/physics/kinematic-state';
import { v3 } from '../../src/physics/vec3';
import { stepDynamics } from '../../src/physics/dynamics';
import {
  MU_EARTH, R_EARTH,
  SHIP_BCINV,
  INITIAL_ALT, INITIAL_INC_DEG,
  GRAVITY_ALWAYS_COUNT, GRAVITY_NEGLIGIBLE_ACCEL,
  SUBSTEP_MAX_DT,
  ARC_STEPS_PER_REV, ARC_MIN_STEP_DT, ARC_MAX_STEPS,
  TRAJECTORY_SAMPLES_PER_REV, ARC_MAX_SAMPLES,
  ARC_STEP_BUDGET, ARC_INTERACTIVE_RATIO,
  ARC_MIN_ITEM_STEPS,
  MAX_PHYS_SIM_SPEED, SIM_SPEED_LEVELS,
} from '../../src/game/const';

export {
  MU_EARTH, R_EARTH, SHIP_BCINV, INITIAL_ALT, INITIAL_INC_DEG,
  GRAVITY_ALWAYS_COUNT, GRAVITY_NEGLIGIBLE_ACCEL, SUBSTEP_MAX_DT,
  ARC_STEPS_PER_REV, ARC_MIN_STEP_DT, ARC_MAX_STEPS,
  TRAJECTORY_SAMPLES_PER_REV, ARC_MAX_SAMPLES,
  ARC_STEP_BUDGET, ARC_INTERACTIVE_RATIO,
  ARC_MIN_ITEM_STEPS,
  MAX_PHYS_SIM_SPEED, SIM_SPEED_LEVELS,
};

// player/player.ts の Player.makeInitialState() と同一の式(高度 INITIAL_ALT・傾斜角
// INITIAL_INC_DEG の円軌道、機首プログレード配置の初期状態)。
export function initialLeoState(): KinematicState {
  const r0 = R_EARTH + INITIAL_ALT;
  const vCirc = Math.sqrt(MU_EARTH / r0);
  const inc = (INITIAL_INC_DEG * Math.PI) / 180;
  return kinematicState(0, v3(r0, 0, 0), v3(0, vCirc * Math.sin(inc), -vCirc * Math.cos(inc)));
}

// 解析モデル(.epk パックなし)の Ephemeris。tests/physics/ephemeris.test.ts と同じ
// `new Ephemeris()` 引数なし経路 — registry=SOLAR_SYSTEM, originId='earth' の既定値のまま。
export function buildEphemeris(): Ephemeris {
  return new Ephemeris();
}

// --- game/simulation/attractors.ts の classifyAttractors/attractorsNear の複製 ---
// ロジックは原本のコピー。GRAVITY_ALWAYS_COUNT/GRAVITY_NEGLIGIBLE_ACCEL は上で import した
// const.ts の値をそのまま使うので、定数の意味はゲーム本体と一致する。

export type ClassifiedAttractors = {
  readonly always: readonly Attractor[];
  readonly grid: SpatialGrid<Attractor>;
};

function alwaysThresholdMu(attractors: readonly Attractor[]): number {
  if (attractors.length <= GRAVITY_ALWAYS_COUNT) return 0;
  const mus = attractors.map((a) => a.mu).sort((x, y) => y - x);
  return mus[GRAVITY_ALWAYS_COUNT - 1] ?? 0;
}

function gridCellSize(gridded: readonly Attractor[]): number {
  let heaviestMu = 0;
  for (const a of gridded) heaviestMu = Math.max(heaviestMu, a.mu);
  return heaviestMu > 0 ? Math.sqrt(heaviestMu / GRAVITY_NEGLIGIBLE_ACCEL) : 1;
}

export function classifyAttractors(attractors: readonly Attractor[]): ClassifiedAttractors {
  const thresholdMu = alwaysThresholdMu(attractors);
  const always: Attractor[] = [];
  const gridded: Attractor[] = [];
  for (const a of attractors) {
    if (a.mu >= thresholdMu) always.push(a);
    else gridded.push(a);
  }
  const grid = new SpatialGrid<Attractor>(gridCellSize(gridded));
  for (const a of gridded) grid.insert(a, a.state.r);
  return { always, grid };
}

export function attractorsNear(pos: Vec3, classified: ClassifiedAttractors): readonly Attractor[] {
  const nearby = classified.grid.neighbors(pos);
  return nearby.length === 0 ? classified.always : [...classified.always, ...nearby];
}

// game/simulation/attractors.ts の predictedAttractorsAt(ephemeris, entities, t) の簡略版。
// 本実験では動的な重力天体(生存中の GameEntity)を一切置かないので、
// mergeAttractors(gravityBodiesAt(ephemeris, t), entities.attractors()) は
// entities.attractors() が常に空配列 → gravityBodiesAt(ephemeris, t) 自体と等価になる。
export function predictedAttractorsAtNoEntities(ephemeris: Ephemeris, t: number): readonly Attractor[] {
  return ephemeris.gravityAttractorsAt(t);
}

// 実験1・2・4で共有する積分の足回り。公平のため常に ephemeris.gravityAttractorsAt(t)
// (mu!==0 の全64天体)を重力源として使い、game/simulation/attractors.ts の
// classifyAttractors によるグリッド近傍への絞り込みは適用しない(絞り込み自体のコストは
// 実験3で単独測定する — 絞り込みは dt の違いに関わらず全ケースへ一様に効くので、
// dt 比較の結論には影響しない)。

// 1ステップぶん、ステップ中点の時刻で重力源を解決してから stepDynamics を呼ぶ。
// Simulator.substep がサブステップ中点で attractorsAt を評価するのと同じ方針。
export function stepDynamicsAt(ephemeris: Ephemeris, state: KinematicState, dt: number): KinematicState {
  const tMid = state.t + dt / 2;
  const attractors = ephemeris.gravityAttractorsAt(tMid);
  return stepDynamics(state, dt, attractors, SHIP_BCINV, 0, null);
}

// 刻み幅 dt 固定で state から targetT まで積分する。端数(remaining < dt)は最後の1ステップを
// remaining の長さに縮めて targetT へ厳密に着地する — Simulator.advance が
// ceil(simDt/SUBSTEP_MAX_DT) 個のサブステップへ割るのと同じ「最後の1歩だけ短くなる」構造。
export function integrateFixedDt(
  ephemeris: Ephemeris,
  state: KinematicState,
  dt: number,
  targetT: number,
): KinematicState {
  let s = state;
  while (targetT - s.t > 1e-9) {
    const step = Math.min(dt, targetT - s.t);
    s = stepDynamicsAt(ephemeris, s, step);
  }
  return s;
}

// チェックポイント時刻の列へ順に着地しながら積分し、時刻→状態の Map を返す(1回の連続積分で
// 全チェックポイントぶんを賄うので、チェックポイントごとに t=0 からやり直さない)。
export function integrateToCheckpoints(
  ephemeris: Ephemeris,
  state0: KinematicState,
  dt: number,
  checkpoints: readonly number[],
): Map<number, KinematicState> {
  const out = new Map<number, KinematicState>();
  let s = state0;
  for (const t of checkpoints) {
    s = integrateFixedDt(ephemeris, s, dt, t);
    out.set(t, s);
  }
  return out;
}

// 位置 r [m] の誤差ノルム。
export function posError(a: KinematicState, b: KinematicState): number {
  const dx = a.r.x - b.r.x, dy = a.r.y - b.r.y, dz = a.r.z - b.r.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export function fmtUs(ms: number, n: number): string {
  return ((ms / n) * 1000).toFixed(2);
}
