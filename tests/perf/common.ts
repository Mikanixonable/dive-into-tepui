// tests/perf/ 配下の各実験が共有する土台。ゲーム本体と同じ調整値の再 export、LEO の初期状態と
// Ephemeris の生成、刻み幅固定の積分、結果の比較と整形を持つ。
import { Ephemeris } from '../../src/physics/ephemeris';
import { nearestAtmosphereBody } from '../../src/physics/attractor';
import { kinematicState, KinematicState } from '../../src/physics/kinematic-state';
import { v3 } from '../../src/physics/vec3';
import { stepDynamics } from '../../src/physics/dynamics';
import {
  MU_EARTH, R_EARTH,
  SHIP_BCINV,
  INITIAL_ALT, INITIAL_INC_DEG,
  GRAVITY_NEGLIGIBLE_ACCEL,
  SUBSTEP_MAX_DT,
  ARC_STEPS_PER_REV, ARC_MIN_STEP_DT, ARC_MAX_STEPS,
  TRAJECTORY_SAMPLES_PER_REV, ARC_MAX_SAMPLES,
  ARC_STEP_BUDGET, ARC_INTERACTIVE_RATIO,
  ARC_MIN_ITEM_STEPS,
  MAX_PHYS_SIM_SPEED, SIM_SPEED_LEVELS,
} from '../../src/game/const';

export {
  MU_EARTH, R_EARTH, SHIP_BCINV, INITIAL_ALT, INITIAL_INC_DEG,
  GRAVITY_NEGLIGIBLE_ACCEL, SUBSTEP_MAX_DT,
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

// 1ステップぶん、ステップ中点の時刻で重力源を解決してから stepDynamics を呼ぶ。重力源は窓を
// そのまま渡す — 刻み幅の比較に絞り込みの有無が混ざらないようにする。
// Simulator.substep がサブステップ中点で attractorsAt を評価するのと同じ方針。
export function stepDynamicsAt(ephemeris: Ephemeris, state: KinematicState, dt: number): KinematicState {
  const tMid = state.t + dt / 2;
  const attractors = ephemeris.gravityAttractorsAt(tMid);
  return stepDynamics(
    state, dt, attractors, ephemeris.attractorsAt(tMid),
    nearestAtmosphereBody(state.r, ephemeris.atmosphereAttractorsAt(tMid)),
    SHIP_BCINV, 0, null,
  );
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
