// 実験12: 天体表面到達判定(attractor.reachedBody)の総当たり費用と、絞り込みで残る候補。
// ?stage=debug-load 相当(自機1 + 破片500)を最高ワープの1フレームぶん、実ゲームと同じく失われた
// 個体を毎 substep 除去しながら積分し、掃引の回数と費用・絞り込み後の候補数と削減比・破片の RK4
// 費用・接触グリッドの候補ペア数を測る。絞り込みは game/simulation/surface-candidates の実装。
import { Attractor, nearestAtmosphereBody, reachedBody } from '../../src/physics/attractor';
import { burnUpBody } from '../../src/physics/atmosphere';
import { randomQuat } from '../../src/physics/attitude';
import { stepDynamics } from '../../src/physics/dynamics';
import { Ephemeris } from '../../src/physics/ephemeris';
import { KinematicState, kinematicState } from '../../src/physics/kinematic-state';
import { mulberry32 } from '../../src/physics/random';
import { SpatialGrid } from '../../src/physics/spatial-grid';
import { Vec3, add, len, scale, sub, v3 } from '../../src/physics/vec3';
import * as C from '../../src/game/const';
import { attractorsNearInto, classifyAttractors } from '../../src/game/simulation/attractors';
import { SurfaceCandidates, SurfaceParticipant } from '../../src/game/simulation/surface-candidates';
import { simulationMaxStep } from '../../src/game/simulation/time-step';
import { buildEphemeris, initialLeoState } from './common';

const FRAME_DT = 1 / 60; // 60 fps を想定した実フレーム時間 [s]
const WARP = C.SIM_SPEED_LEVELS[C.SIM_SPEED_LEVELS.length - 1]!;
const SIM_DT = FRAME_DT * WARP;
const MAX_STEP = simulationMaxStep(SIM_DT, C.SUBSTEP_MAX_DT, C.SUBSTEP_MAX_COUNT);
const SUBSTEPS = Math.round(SIM_DT / MAX_STEP);
const REPEATS = 3; // 各測定の反復数。GC とスケジューリングは上振れにしか出ないので最小値を採る
const DIVERGED_RADIUS = 10 * len(initialLeoState().r); // 積分の静かな破綻を検出する地心距離 [m]

// 積分の対象。区間の両端が揃うと SurfaceParticipant になる。
interface Body {
  readonly state: KinematicState;
  readonly radius: number;
}

// substep 1つぶんの区間。除去のぶん substep ごとに短くなる。
type Interval = readonly SurfaceParticipant[];

// substep ごとに表面到達判定が突き合わせる天体窓。
type SurfaceWindows = readonly (readonly Attractor[])[];

// 桁区切り付きの整数表記。回数が6桁を超えるので目で読めるようにする。
const num = (x: number): string => x.toLocaleString('en-US');

// fn を1回ウォームアップしてから REPEATS 回走らせ、cost が最小だった結果を返す。
function fastest<T>(fn: () => T, cost: (r: T) => number): T {
  let best = fn();
  for (let i = 0; i < REPEATS; i++) {
    const r = fn();
    if (cost(r) < cost(best)) best = r;
  }
  return best;
}

// Markdown の2列表として出す。
function table(rows: readonly (readonly [string, string])[]): void {
  console.log('項目 | 値\n--- | ---');
  for (const [name, value] of rows) console.log(`${name} | ${value}`);
}

// 中心から距離 dist の球面上の一様ランダムな向きのオフセット。rand を2回消費する。
function shellOffset(rand: () => number, dist: number): Vec3 {
  const theta = rand() * Math.PI * 2;
  const phi = Math.acos(2 * rand() - 1);
  return v3(dist * Math.sin(phi) * Math.cos(theta), dist * Math.sin(phi) * Math.sin(theta), dist * Math.cos(phi));
}

// 自機1体 + 破片 DEBUG_LOAD_DEBRIS_COUNT 体の初期状態。オフセットは stage-debug-load.ts の
// randomOffset と同一の式。破片の速度は自機と同じで、サイズと姿勢は測る対象に効かないが、
// 乱数列を原本と同じ順で消費して配置を一致させる。破片の接触半径は原本どおり 0 m。
function debugLoadStates(): readonly Body[] {
  const player = initialLeoState();
  const rand = mulberry32(C.DEBUG_LOAD_RNG_SEED);
  const bodies: Body[] = [{ state: player, radius: C.PLAYER_HULL_RADIUS }];
  const min3 = C.DEBUG_LOAD_PLACEMENT_MIN_DIST ** 3;
  for (let i = 0; i < C.DEBUG_LOAD_DEBRIS_COUNT; i++) {
    const dist = Math.cbrt(min3 + rand() * (C.DEBUG_LOAD_DEBRIS_MAX_DIST ** 3 - min3));
    bodies.push({ state: kinematicState(player.t, add(player.r, shellOffset(rand, dist)), player.v), radius: 0 });
    rand();
    randomQuat(rand);
  }
  return bodies;
}

const MOON_IMPACT_COUNT = 40; // 正例の照合に使う個体数
const MOON_IMPACT_MAX_ALT = 200e3; // 月面からの初期高度の上限 [m]。等間隔に割って到達時刻を散らす

// 月へ自由落下する MOON_IMPACT_COUNT 体。月と同じ速度で置くので月の重力だけで表面へ落ち、大気を
// 持たない相手なので焼失で先に消えることがない — 照合に正例を踏ませるための配置で、費用は測らない。
function moonImpactStates(ephemeris: Ephemeris, t0: number): readonly Body[] {
  const moon = ephemeris.attractorAt('moon', t0);
  const rand = mulberry32(C.DEBUG_LOAD_RNG_SEED);
  const bodies: Body[] = [];
  for (let i = 1; i <= MOON_IMPACT_COUNT; i++) {
    const alt = (MOON_IMPACT_MAX_ALT * i) / MOON_IMPACT_COUNT;
    const offset = shellOffset(rand, moon.radius + alt);
    bodies.push({ state: kinematicState(t0, add(moon.state.r, offset), moon.state.v), radius: 0 });
  }
  return bodies;
}

// 剛体接触を解決する帯は区間終点の全天体窓、解決しない帯は積分に使った中点の重力窓を読む。
function surfaceWindows(ephemeris: Ephemeris, t0: number, select: 'all' | 'gravity'): SurfaceWindows {
  const windows: (readonly Attractor[])[] = [];
  for (let k = 0; k < SUBSTEPS; k++) {
    const t = t0 + k * MAX_STEP;
    windows.push(select === 'all'
      ? ephemeris.attractorsAt(t + MAX_STEP)
      : ephemeris.gravityAttractorsAt(t + MAX_STEP / 2));
  }
  return windows;
}

// 1フレームぶんの積分結果と、その健全性。
interface Frame {
  readonly timeline: readonly Interval[];
  readonly stepMs: number; // stepDynamics だけの累計 [ms](除去の判定を含まない)
  readonly steps: number; // stepDynamics の呼び出し回数
  readonly reached: number; // 表面へ到達して除去した個体数
  readonly burnedUp: number; // 大気で焼失して除去した個体数
  readonly maxRadius: number; // 積分中に現れた地心距離の最大 [m]
  readonly diverged: number; // DIVERGED_RADIUS を超えた個体 × substep
}

// 全個体を substep ごとに積分し、失われた個体を実ゲームの cleanup と同じ位置・同じ判定(表面到達
// または大気での焼失)で以後の積分から外す。判定は総当たりで行う — 絞り込みを使うと測定対象その
// ものが絞り込みに依存する。焼失を落とすと、大気の底を掠めた個体が1歩ぶんの巨大な抗力で弾かれ、
// 境界球を桁で膨らませて絞り込みの測定を壊す。
function integrateFrame(ephemeris: Ephemeris, initial: readonly Body[], windows: SurfaceWindows): Frame {
  const timeline: Interval[] = [];
  const scratch: Attractor[] = [];
  let alive: readonly Body[] = initial;
  let stepMs = 0;
  let steps = 0;
  let maxRadius = 0;
  let diverged = 0;
  let reached = 0;
  let burnedUp = 0;
  for (let k = 0; k < SUBSTEPS; k++) {
    const tMid = initial[0]!.state.t + (k + 0.5) * MAX_STEP;
    const classified = classifyAttractors(ephemeris.gravityAttractorsAt(tMid));
    const air = ephemeris.atmosphereAttractorsAt(tMid);
    const t0 = performance.now();
    const stepped = alive.map((b) => stepDynamics(
      b.state, MAX_STEP, attractorsNearInto(b.state.r, classified, scratch), nearestAtmosphereBody(b.state.r, air),
      C.SMALL_DEBRIS_BCINV, C.SMALL_DEBRIS_SRP_COEFF, null));
    stepMs += performance.now() - t0;
    steps += alive.length;
    const interval = alive.map((b, i) => ({ prevState: b.state, state: stepped[i]!, radius: b.radius }));
    timeline.push(interval);
    const survivors: Body[] = [];
    for (const p of interval) {
      const radius = len(p.state.r);
      maxRadius = Math.max(maxRadius, radius);
      if (radius > DIVERGED_RADIUS) diverged++;
      if (reachedBody(p.prevState, p.state, windows[k]!) !== null) reached++;
      else if (burnUpBody(p.state.r, windows[k]!, C.DEBRIS_BURNUP_DENSITY) !== null) burnedUp++;
      else survivors.push({ state: p.state, radius: p.radius });
    }
    alive = survivors;
  }
  return { timeline, stepMs, steps, reached, burnedUp, maxRadius, diverged };
}

// 判定の呼び出しを畳ませないための集計先。値そのものは読まない。
let sink = 0;

// 全生存個体 × 全天体 × 全 substep の reachedBody を1フレームぶん通した所要 [ms]。
function bruteForce(timeline: readonly Interval[], windows: SurfaceWindows): number {
  const t0 = performance.now();
  for (let k = 0; k < SUBSTEPS; k++) {
    for (const p of timeline[k]!) sink += reachedBody(p.prevState, p.state, windows[k]!) === null ? 0 : 1;
  }
  return performance.now() - t0;
}

// 1フレームぶんの絞り込みの費用と通過数。
interface Narrowed {
  readonly stage1Ms: number;
  readonly stage2Ms: number;
  readonly stage1Total: number; // 1段目を通った天体数の全 substep 合計
  readonly stage1Max: number; // 1段目を通った天体数の substep 最大
  readonly stage2Total: number; // 2段目を通った延べ候補数(全 substep × 全個体)
}

// SurfaceCandidates を1フレームぶん通し、段ごとの所要 [ms] と通過数を返す。
function narrow(timeline: readonly Interval[], windows: SurfaceWindows): Narrowed {
  const candidates = new SurfaceCandidates();
  const out: Attractor[] = [];
  let stage1Ms = 0;
  let stage2Ms = 0;
  let stage1Total = 0;
  let stage1Max = 0;
  let stage2Total = 0;
  for (let k = 0; k < SUBSTEPS; k++) {
    const interval = timeline[k]!;
    const t0 = performance.now();
    candidates.reset(interval, windows[k]!);
    const t1 = performance.now();
    for (const p of interval) stage2Total += candidates.into(p, out).length;
    stage2Ms += performance.now() - t1;
    stage1Ms += t1 - t0;
    stage1Total += candidates.count;
    stage1Max = Math.max(stage1Max, candidates.count);
  }
  return { stage1Ms, stage2Ms, stage1Total, stage1Max, stage2Total };
}

// 総当たりと絞り込みが同じ到達を返すか。食い違った件数を返す(0 でなければ絞り込みが誤り)。
// 計時とは別の走査にする — 照合が呼ぶ総当たりの掃引を narrow の計測区間へ混ぜないため。
function mismatches(timeline: readonly Interval[], windows: SurfaceWindows): number {
  const candidates = new SurfaceCandidates();
  const out: Attractor[] = [];
  let count = 0;
  for (let k = 0; k < SUBSTEPS; k++) {
    const interval = timeline[k]!;
    candidates.reset(interval, windows[k]!);
    for (const p of interval) {
      const full = reachedBody(p.prevState, p.state, windows[k]!);
      const only = reachedBody(p.prevState, p.state, candidates.into(p, out));
      if ((full?.body.id ?? null) !== (only?.body.id ?? null)) count++;
    }
  }
  return count;
}

// 個体どうしの接触グリッドのセル一辺 [m] と、その27近傍から集まる候補ペア数(j > i の重複除去
// 込み)。一辺は contact.ts の contactCellSize の式の複製 — 原本は GameEntity 経由で three/DOM を
// 引き込むため、tests/perf の tsconfig ではコンパイルできない。
function contactGrid(interval: Interval): { readonly cellSize: number; readonly pairs: number } {
  const displacements = interval.map((p) => sub(p.state.r, p.prevState.r));
  let sum = v3();
  for (const d of displacements) sum = add(sum, d);
  const mean = scale(sum, 1 / displacements.length);
  let maxReach = 0;
  for (let i = 0; i < displacements.length; i++) {
    maxReach = Math.max(maxReach, interval[i]!.radius + len(sub(displacements[i]!, mean)));
  }
  const cellSize = 2 * maxReach || C.CONTACT_GRID_CELL_SIZE_FLOOR;
  const grid = new SpatialGrid<number>(cellSize);
  for (let i = 0; i < interval.length; i++) grid.insert(i, interval[i]!.state.r);
  const neighbors: number[] = [];
  let pairs = 0;
  for (let i = 0; i < interval.length; i++) {
    for (const j of grid.neighborsInto(interval[i]!.state.r, neighbors)) if (j > i) pairs++;
  }
  return { cellSize, pairs };
}

// 1つの天体窓ぶんの総当たり・絞り込み・整合検査を測って表に出す。
function reportWindow(label: string, frame: Frame, windows: SurfaceWindows): void {
  const bodies = windows[0]!.length;
  const sweeps = frame.steps * bodies;
  const bruteMs = fastest(() => bruteForce(frame.timeline, windows), (ms) => ms);
  const n = fastest(() => narrow(frame.timeline, windows), (r) => r.stage1Ms + r.stage2Ms);
  const nsPerSweep = (bruteMs / sweeps) * 1e6;
  const narrowedMs = n.stage1Ms + n.stage2Ms + (nsPerSweep / 1e6) * n.stage2Total;
  const bad = mismatches(frame.timeline, windows);
  console.log(`\n### ${label}\n`);
  table([
    ['総当たり',
      `${bodies} 体 × ${num(sweeps)} 回/フレーム、${bruteMs.toFixed(1)} ms(掃引1回 ${nsPerSweep.toFixed(1)} ns)`],
    ['1段目を通った天体', `平均 ${(n.stage1Total / SUBSTEPS).toFixed(2)} 体/substep、最大 ${n.stage1Max} 体`],
    ['2段目を通った候補',
      `${num(n.stage2Total)} 回/フレーム(削減比 ${(sweeps / Math.max(1, n.stage2Total)).toFixed(0)}×)`],
    ['絞り込みの費用 [ms/フレーム]', `1段目 ${n.stage1Ms.toFixed(2)} + 2段目 ${n.stage2Ms.toFixed(2)}`
      + ` + 残った掃引 ${(narrowedMs - n.stage1Ms - n.stage2Ms).toFixed(2)} = ${narrowedMs.toFixed(2)}`
      + `(総当たりの ${(narrowedMs / bruteMs * 100).toFixed(1)} %)`],
    ['総当たりとの答えの食い違い', bad === 0 ? '0 件(一致)' : `${bad} 件(絞り込みが誤り)`],
  ]);
}

export function run(): void {
  console.log('# 実験12: 天体表面到達判定の総当たり費用と2段の絞り込み\n');
  const ephemeris = buildEphemeris();
  const initial = debugLoadStates();
  const t0 = initial[0]!.state.t;
  // 最高ワープ帯は剛体接触を解決しないので、除去に使う窓は重力窓(実ゲームの surfaceBodies と同じ)。
  const gravity = surfaceWindows(ephemeris, t0, 'gravity');
  const frame = fastest(() => integrateFrame(ephemeris, initial, gravity), (f) => f.stepMs);

  console.log('## (0) 積分の健全性\n');
  table([
    ['除去した個体', `表面到達 ${frame.reached} 体 + 大気で焼失 ${frame.burnedUp} 体 / ${initial.length} 体`],
    ['積分中の地心距離の最大', `${frame.maxRadius.toExponential(3)} m(初期半径の `
      + `${(frame.maxRadius / len(initial[0]!.state.r)).toFixed(2)} 倍)。10倍を超えた個体 × substep は `
      + `${frame.diverged} 件${frame.diverged === 0 ? '(発散なし)' : '(発散あり — 以降の数字は無効)'}`],
  ]);

  console.log('\n## (1)(2) 掃引の費用と、2段の絞り込みで残る候補');
  reportWindow('attractorsAt(×4 以下の窓)', frame, surfaceWindows(ephemeris, t0, 'all'));
  reportWindow('gravityAttractorsAt(×4 超の窓)', frame, gravity);

  // 比較対象として、フレーム全体を1歩でまたいだ場合の費用も測る。絞り込みを通さない
  // 重力窓をそのまま渡す。
  const debris = initial.slice(1);
  const sources = ephemeris.gravityAttractorsAt(t0 + SIM_DT);
  const air = ephemeris.atmosphereAttractorsAt(t0 + SIM_DT);
  const lodStep = (b: Body): KinematicState => stepDynamics(
    b.state, SIM_DT, sources, nearestAtmosphereBody(b.state.r, air),
    C.SMALL_DEBRIS_BCINV, C.SMALL_DEBRIS_SRP_COEFF, null);
  const lodMs = fastest(() => {
    const t = performance.now();
    debris.map(lodStep);
    return performance.now() - t;
  }, (ms) => ms);
  const usPerStep = (frame.stepMs / frame.steps) * 1e3;
  console.log('\n## (3) 破片の RK4 費用\n');
  table([
    ['毎 substep 積分 [ms/フレーム]',
      `${frame.stepMs.toFixed(1)}(${num(frame.steps)} 歩、1歩 ${usPerStep.toFixed(2)} µs)`],
    [`破片 ${debris.length} 体 × ${SUBSTEPS} substep 相当 [ms/フレーム]`,
      `${(usPerStep * debris.length * SUBSTEPS / 1e3).toFixed(1)}`],
    [`フレームに1歩だけ(破片 ${debris.length} 体 × 1歩) [ms/フレーム]`,
      `${lodMs.toFixed(2)}(1歩 ${((lodMs / debris.length) * 1e3).toFixed(2)} µs)`],
  ]);

  console.log('\n## (4) 個体どうしの接触グリッド\n');
  const grid = contactGrid(frame.timeline[0]!);
  table([
    ['contactCellSize が返すセル一辺 [m]', grid.cellSize.toFixed(1)],
    [`27近傍の候補ペア数(${initial.length} 体)`, num(grid.pairs)],
  ]);
  console.log(`\n現状の debug-load の破片は kind:'fragment' で collides=false・質量0 なので、個体どうしの接触の`
    + `参加者にならない — いまの参加者は自機1体だけで、候補ペアは 0 件である。上の数字は、後の段で破片が`
    + `参加者になったときに ${initial.length} 体を載せた場合の値(半径は自機 ${C.PLAYER_HULL_RADIUS} m・破片 0 m)。`);

  console.log('\n## (5) 正例での照合(大気を持たない天体への突入)\n');
  const moonFrame = integrateFrame(ephemeris, moonImpactStates(ephemeris, t0), gravity);
  const moonNarrow = narrow(moonFrame.timeline, gravity);
  const moonBad = mismatches(moonFrame.timeline, gravity);
  table([
    ['配置', `月面から ${MOON_IMPACT_MAX_ALT / 1e3} km 以下に ${MOON_IMPACT_COUNT} 体、月と同速度で自由落下`],
    ['総当たりが返した表面到達', `${moonFrame.reached} 件`
      + `${moonFrame.reached === 0 ? '(正例が踏めていない — 配置の失敗)' : ''}、大気で焼失 ${moonFrame.burnedUp} 体`],
    ['1段目を通った天体',
      `平均 ${(moonNarrow.stage1Total / SUBSTEPS).toFixed(2)} 体/substep、最大 ${moonNarrow.stage1Max} 体`],
    ['2段目を通った候補', `${num(moonNarrow.stage2Total)} 回/フレーム`],
    ['総当たりとの答えの食い違い', moonBad === 0 ? '0 件(一致)' : `${moonBad} 件(絞り込みが誤り)`],
  ]);

  console.log('\n## 測定条件\n');
  console.log([
    `個体数 ${initial.length}(自機1 + 破片 ${C.DEBUG_LOAD_DEBRIS_COUNT})、ワープ ×${WARP}、dt = 1/60 s、`
      + `simDt = ${SIM_DT.toFixed(1)} s、測定はウォームアップ後 ${REPEATS} 回の最小値`,
    `maxStep = max(SUBSTEP_MAX_DT=${C.SUBSTEP_MAX_DT}, simDt/SUBSTEP_MAX_COUNT=${C.SUBSTEP_MAX_COUNT})`
      + ` = ${MAX_STEP.toFixed(3)} s → substep 数 ${SUBSTEPS}。天体窓は attractorsAt ${ephemeris.attractorsAt(t0).length}`
      + ` 体 / gravityAttractorsAt ${ephemeris.gravityAttractorsAt(t0).length} 体`,
    `破片の配置: mulberry32(${C.DEBUG_LOAD_RNG_SEED})、距離 [${C.DEBUG_LOAD_PLACEMENT_MIN_DIST}, `
      + `${C.DEBUG_LOAD_DEBRIS_MAX_DIST}] m の球殻一様、速度は自機と同じ。(4) の区間は substep 0 で、`
      + `剛体接触の解決自体はワープ ×${C.MAX_PHYS_SIM_SPEED} 以下でしか走らない`,
  ].join('\n'));
}

if (require.main === module) run();
