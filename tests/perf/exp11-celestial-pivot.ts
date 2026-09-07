// 実験11: 天体位置の pivot をサブステップごとに取るか、1フレームに1回取るか。
// Part 0 は1サブステップの天体解決コスト、Part 1 は外挿幅ごとの天体位置の誤差と躍度、
// Part 2 は両方式で積分した軌道の終端誤差、Part 3 はフレーム周期に対する案1の感度。
// 出力は stdout へ Markdown の表。
// 使い方: npx tsc -p tests/perf/tsconfig.perf.json && node tests/dist-perf/tests/perf/exp11-celestial-pivot.js
import '../repo-assets';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { classifyAttractors } from '../../src/game/dynamic/attractors';
import { SIM_SPEED_LEVELS } from '../../src/game/dynamic/sim-speed-manager';
import { SUBSTEP_MAX_COUNT, SUBSTEP_MAX_DT, simulationMaxStep } from '../../src/game/dynamic/time-step';
import { stepDynamics } from '../../src/physics/dynamics';
import { semiMajorFromPeriod } from '../../src/physics/elements';
import { kinematicState } from '../../src/physics/kinematic-state';
import { add, addScaled, cross, dot, len, norm, scale, sub, v3 } from '../../src/math/vec3';
import { motionOf, orbitingMotionOf, solarSystemParts, stateOf } from '../physics/test-helpers';
import type { CelestialMotion } from '../../src/physics/celestial-motion';
import type { KinematicState } from '../../src/physics/kinematic-state';
import type { Vec3 } from '../../src/math/vec3';
import type { SolarSystemParts } from '../physics/test-helpers';

// 1フレームの実時間 [s]。
const FRAME_DT = 1 / 60;
// Part 3 で比べる、フレームレートが半分のときの1フレーム [s]。
const FRAME_DT_HALF_RATE = 1 / 30;
const DAY = 86400; // [s]
const AU = 1.495978707e11; // [m]

// Part 0: 新しい pivot を COST_PIVOT_STRIDE ずつ進めて費用を払う回数と、計る前に温める回数。
const COST_PIVOT_COUNT = 3000;
const COST_MARGINAL_PIVOT_COUNT = 2000;
const COST_STEP_COUNT = 2000;
const COST_WARMUP_COUNT = 300;
const COST_PIVOT_STRIDE = 20; // [s]
// 限界費用の表に載せる件数。
const COST_TOP_COUNT = 15;
// ×65536 で1フレームに割られるサブステップ数 = ceil(65536/60 / SUBSTEP_MAX_DT)。
const SUBSTEPS_AT_65536 = 55;

// Part 1: 外挿幅 [s]。現行のサブステップ半幅 subDt/2 = max(20, warp/60/64)/2 と、案1のフレーム
// 半幅 simDt/2 = warp/60/2 をワープ段ごとに並べ、その間を 2 倍刻みで埋めたもの。
const EXTRAPOLATION_WIDTHS = [
  10, 17, 68, 273, 546, 1092, 2184, 4369, 8738, 17476, 34953, 69905, 139810, 279620,
];
// 躍度を推定する外挿幅 [s]。
const JERK_PROBE_WIDTH = 600;
// 誤差の最大を取る pivot の並び: 0, 30 日, …, 330 日。
const ERROR_PIVOT_COUNT = 12;
const ERROR_PIVOT_STRIDE = 30 * DAY; // [s]
// 表 A に列として出す天体。
const TABLE_A_IDS = ['sun', 'moon', 'mars', 'phobos', 'jupiter', 'io', 'metis', 'saturn', 'pan', 'ganymede'];
// 外挿してよい幅を求める許容誤差 [m]。
const TOLERANCES = [1, 10, 100];

// Part 2: 参照解の刻み分割数。
const REFERENCE_REFINE = 4;
// LEO の高度 [m] と傾斜角 [deg]。
const LEO_ALTITUDE = 420e3;
const LEO_INCLINATION_DEG = 97;
// TLI の初期の遠地点距離 [m](地球-月の平均距離)と、遠地点を月の進行方向側へずらす量 [m]。
const MOON_DISTANCE = 3.844e8;
const TLI_AIM_OFFSET = 1e7;
// 共鳴シナリオの公転周期をフレームの時間送りに合わせるワープ段。
const RESONANT_WARP = 2097152;
// 火星遷移巡航の出発位置(地球から公転進行方向へ)[m] と出発速度 [m/s]。
const CRUISE_DEPARTURE_DISTANCE = 3e9;
const CRUISE_DEPARTURE_SPEED = 2945;

// Part 3 で frameDt を変えて走らせる組(シナリオ番号は 1 始まり)。
const FRAME_RATE_PROBES = [
  { scenario: 6, warp: 524288 },
  { scenario: 9, warp: 8388608 },
];

// 有効数字 3 桁。指数表記は Number へ戻して読みやすい形へ寄せる。
function sig3(x: number): string {
  if (!Number.isFinite(x)) return x > 0 ? '∞' : String(x);
  if (x === 0) return '0';
  return String(Number(x.toPrecision(3)));
}

function secondsSince(startMs: number): string {
  return ((performance.now() - startMs) / 1000).toFixed(1);
}

function distance(a: KinematicState, b: KinematicState): number {
  return len(sub(a.r, b.r));
}

function printTable(headers: readonly string[], rows: readonly (readonly string[])[]): void {
  console.log(`| ${headers.join(' | ')} |`);
  console.log(`| ${headers.map(() => '---').join(' | ')} |`);
  for (const row of rows) console.log(`| ${row.join(' | ')} |`);
}

// 衛星ならその惑星、惑星と恒星なら自分自身の id。系ごとの合計を束ねる鍵。
function systemIdOf(m: CelestialMotion): string {
  return m.kind === 'satellite' ? (m.primary?.id ?? m.id) : m.id;
}

// ---------------------------------------------------------------- 冒頭

function printHeader(parts: SolarSystemParts): void {
  const hash = execSync('git rev-parse --short HEAD').toString().trim();
  const counts = { star: 0, planet: 0, satellite: 0 };
  for (const m of parts.system.celestialMotions) counts[m.kind]++;
  console.log('# 実験11: 天体位置の pivot(サブステップごと vs フレームに1回)\n');
  console.log(`- commit: ${hash}`);
  console.log(
    `- 天体数: ${parts.system.celestialMotions.length}`
    + `(star ${counts.star} / planet ${counts.planet} / satellite ${counts.satellite})、`
    + `重力源 ${parts.system.gravityMotions.length} 本`);
  console.log(`- FRAME_DT = 1/60 s, SUBSTEP_MAX_DT = ${SUBSTEP_MAX_DT} s, SUBSTEP_MAX_COUNT = ${SUBSTEP_MAX_COUNT}`);
  console.log(`- 太陽系: solarSystemParts()(解析暦のみ・地球原点・既定元期)`);
}

// ---------------------------------------------------------------- Part 0

// fn を新しい pivot で count 回呼んだ1回あたりの平均 [µs]。pivot は base から COST_PIVOT_STRIDE
// ずつ進め、計る前に base の負の側で COST_WARMUP_COUNT 回温める。
function meanMicrosPerPivot(fn: (pivot: number) => void, count: number, base: number): number {
  for (let k = 1; k <= COST_WARMUP_COUNT; k++) fn(base - k * COST_PIVOT_STRIDE);
  const start = performance.now();
  for (let k = 0; k < count; k++) fn(base + k * COST_PIVOT_STRIDE);
  return ((performance.now() - start) / count) * 1000;
}

// 同じ pivot で sun → earth → moon → 残りを宣言順に引いたときの、天体 id ごとの positionAt 1回の
// 平均所要時間 [µs]。Map の並びは引いた順。
function marginalCosts(parts: SolarSystemParts, base: number): Map<string, number> {
  const leading = ['sun', 'earth', 'moon'].map((id) => motionOf(parts, id));
  const order = [...leading, ...parts.system.celestialMotions.filter((m) => !leading.includes(m))];
  const totals = new Map<string, number>(order.map((m) => [m.id, 0]));
  const pull = (pivot: number, record: boolean): void => {
    for (const m of order) {
      const start = performance.now();
      m.positionAt(pivot);
      const took = performance.now() - start;
      if (record) totals.set(m.id, (totals.get(m.id) ?? 0) + took);
    }
  };
  for (let k = 1; k <= COST_WARMUP_COUNT; k++) pull(base - k * COST_PIVOT_STRIDE, false);
  for (let k = 0; k < COST_MARGINAL_PIVOT_COUNT; k++) pull(base + k * COST_PIVOT_STRIDE, true);
  return new Map(order.map((m) => [m.id, ((totals.get(m.id) ?? 0) / COST_MARGINAL_PIVOT_COUNT) * 1000]));
}

function leoState(parts: SolarSystemParts): KinematicState {
  const earth = motionOf(parts, 'earth').def;
  const r0 = earth.radius + LEO_ALTITUDE;
  const vCirc = Math.sqrt(earth.mu / r0);
  const inc = (LEO_INCLINATION_DEG * Math.PI) / 180;
  return kinematicState<'eci'>(0, v3(r0, 0, 0), v3(0, vCirc * Math.sin(inc), -vCirc * Math.cos(inc)));
}

function part0(parts: SolarSystemParts): void {
  const partStart = performance.now();
  const system = parts.system;
  const motions = system.celestialMotions;
  const gravity = system.gravityMotions;
  console.log('\n## Part 0: 1サブステップの天体解決コスト\n');
  console.log(`新しい pivot(${COST_PIVOT_STRIDE} s 刻み)ごとの費用。各計測の前に ${COST_WARMUP_COUNT} pivot 温める。\n`);

  // (i) Simulator が1サブステップで払うぶん: 分類 + 全天体の stateAt。
  const resolveAll = meanMicrosPerPivot((pivot) => {
    classifyAttractors(gravity, pivot, pivot, pivot);
    for (const m of motions) m.stateAt(pivot);
  }, COST_PIVOT_COUNT, 0);
  // (ii) 分類だけ(pivot 更新込み)。
  const classifyOnly = meanMicrosPerPivot((pivot) => {
    classifyAttractors(gravity, pivot, pivot, pivot);
  }, COST_PIVOT_COUNT, 1e6);
  // (iii) 恒星の位置だけ(重心相対位置の畳み込み = 全惑星系のケプラー解)。
  const sun = motionOf(parts, 'sun');
  const sunOnly = meanMicrosPerPivot((pivot) => {
    sun.positionAt(pivot);
  }, COST_PIVOT_COUNT, 2e6);

  printTable(['計測', 'µs/サブステップ'], [
    [`(i) classifyAttractors + 全 ${motions.length} 天体の stateAt`, sig3(resolveAll)],
    ['(ii) classifyAttractors だけ', sig3(classifyOnly)],
    ['(iii) sun.positionAt だけ', sig3(sunOnly)],
  ]);

  // (iv) 限界費用。
  const costs = marginalCosts(parts, 3e6);
  const leading = ['sun', 'earth', 'moon'];
  console.log(`\n(iv) 限界費用(${COST_MARGINAL_PIVOT_COUNT} pivot の平均、performance.now の呼び出し込み)。`
    + `先に引く3体: ${leading.map((id) => `${id} ${sig3(costs.get(id) ?? 0)} µs`).join(', ')}\n`);
  const rest = motions.filter((m) => !leading.includes(m.id));
  const ranked = [...rest].sort((a, b) => (costs.get(b.id) ?? 0) - (costs.get(a.id) ?? 0));
  printTable(['順位', 'id', 'kind', '系', '限界費用 [µs]'], ranked.slice(0, COST_TOP_COUNT).map((m, i) => [
    String(i + 1), m.id, m.kind, systemIdOf(m), sig3(costs.get(m.id) ?? 0),
  ]));
  const bySystem = new Map<string, { count: number; total: number }>();
  for (const m of rest) {
    const entry = bySystem.get(systemIdOf(m)) ?? { count: 0, total: 0 };
    entry.count++;
    entry.total += costs.get(m.id) ?? 0;
    bySystem.set(systemIdOf(m), entry);
  }
  console.log('');
  printTable(['系(主惑星の id)', '天体数', '合計 [µs]'],
    [...bySystem.entries()].sort((a, b) => b[1].total - a[1].total).map(([id, e]) => [
      id, String(e.count), sig3(e.total),
    ]));
  let restTotal = 0;
  for (const m of rest) restTotal += costs.get(m.id) ?? 0;
  console.log(`\n残り ${rest.length} 天体の限界費用の合計: ${sig3(restTotal)} µs`);

  // (v) 文脈用: always 側の重力源で stepDynamics を1回呼ぶ費用。
  const stepPivot = 4e6;
  const always = classifyAttractors(gravity, stepPivot, stepPivot, stepPivot).always;
  const leoAtZero = leoState(parts);
  const leo = kinematicState<'eci'>(stepPivot, leoAtZero.r, leoAtZero.v);
  let acc = 0;
  for (let i = 0; i < COST_WARMUP_COUNT; i++) {
    acc += stepDynamics(leo, SUBSTEP_MAX_DT, always, [], null, stepPivot, 0, 0, null).r.x;
  }
  const stepStart = performance.now();
  for (let i = 0; i < COST_STEP_COUNT; i++) {
    acc += stepDynamics(leo, SUBSTEP_MAX_DT, always, [], null, stepPivot, 0, 0, null).r.x;
  }
  const stepMicros = ((performance.now() - stepStart) / COST_STEP_COUNT) * 1000;
  console.log(`\n(v) stepDynamics 1歩(重力源 ${always.length} 本、温まった同じ pivot、LEO): ${sig3(stepMicros)} µs/歩`
    + `(checksum ${acc.toExponential(3)})`);

  console.log(`\n- (i) × ${SUBSTEP_MAX_COUNT} = 高倍率での1フレームの天体解決: ${sig3((resolveAll * SUBSTEP_MAX_COUNT) / 1000)} ms`);
  console.log(`- (i) × ${SUBSTEPS_AT_65536} = ×65536 での1フレーム: ${sig3((resolveAll * SUBSTEPS_AT_65536) / 1000)} ms`);
  console.log(`\nPart 0 の壁時計: ${secondsSince(partStart)} s`);
}

// ---------------------------------------------------------------- Part 1

// 外挿幅 s [s] での天体 m の位置誤差 [m]。pivot を 30 日ごとに 12 個取り、その最大。
function extrapolationError(m: CelestialMotion, s: number): number {
  let worst = 0;
  for (let i = 0; i < ERROR_PIVOT_COUNT; i++) {
    const p = i * ERROR_PIVOT_STRIDE;
    worst = Math.max(worst, len(sub(m.positionAt(p, p + s), m.positionAt(p + s))));
  }
  return worst;
}

// 外挿幅 s が、どのワープ段の subDt/2 / simDt/2 に当たるかの見出し。
function widthLabel(s: number): string {
  const substepWarps: number[] = [];
  const frameWarps: number[] = [];
  for (const warp of SIM_SPEED_LEVELS) {
    const substepHalf = simulationMaxStep(warp * FRAME_DT, SUBSTEP_MAX_DT, SUBSTEP_MAX_COUNT) / 2;
    const frameHalf = (warp * FRAME_DT) / 2;
    if (Math.abs(substepHalf - s) / s < 0.05) substepWarps.push(warp);
    if (Math.abs(frameHalf - s) / s < 0.05) frameWarps.push(warp);
  }
  const range = (warps: readonly number[]): string =>
    warps.length === 1 ? `×${warps[0]}` : `×${warps[0]}〜×${warps[warps.length - 1]}`;
  const tags: string[] = [];
  if (substepWarps.length > 0) tags.push(`subDt/2 ${range(substepWarps)}`);
  if (frameWarps.length > 0) tags.push(`simDt/2 ${range(frameWarps)}`);
  return tags.length === 0 ? '中間' : tags.join('; ');
}

function part1(parts: SolarSystemParts): void {
  const partStart = performance.now();
  const motions = parts.system.celestialMotions;
  console.log('\n## Part 1: 天体ごとの外挿誤差と躍度\n');
  console.log(`e(s) = max over pivot p ∈ {0, 30d, …, 330d} of |positionAt(p, p + s) − positionAt(p + s)| [m]\n`);

  // 表 A。
  console.log('### 表A: 外挿幅ごとの位置誤差 [m]\n');
  const columns = TABLE_A_IDS.map((id) => motionOf(parts, id));
  const rowsA = EXTRAPOLATION_WIDTHS.map((s) => {
    let worst = 0;
    let worstId = '';
    for (const m of motions) {
      const e = extrapolationError(m, s);
      if (e > worst) { worst = e; worstId = m.id; }
    }
    return [
      String(s), widthLabel(s),
      ...columns.map((m) => sig3(extrapolationError(m, s))),
      `${sig3(worst)} (${worstId})`,
    ];
  });
  printTable(['s [s]', '幅の意味', ...TABLE_A_IDS, '全天体の最大 (id)'], rowsA);

  // 表 B。
  console.log(`\n### 表B: 躍度の推定 j = 6·e(${JERK_PROBE_WIDTH})/${JERK_PROBE_WIDTH}³ と、外挿してよい幅 τ(ε) = (6ε/j)^(1/3)(τ(1 m) の昇順)\n`);
  const jerks = motions.map((m) => {
    const j = (6 * extrapolationError(m, JERK_PROBE_WIDTH)) / JERK_PROBE_WIDTH ** 3;
    const taus = TOLERANCES.map((eps) => Math.cbrt((6 * eps) / j));
    return { m, j, taus };
  });
  jerks.sort((a, b) => {
    const ta = a.taus[0] ?? Infinity;
    const tb = b.taus[0] ?? Infinity;
    return ta < tb ? -1 : ta > tb ? 1 : 0;
  });
  printTable(['id', 'kind', 'j [m/s³]', ...TOLERANCES.map((eps) => `τ(${eps} m) [s]`)],
    jerks.map(({ m, j, taus }) => [m.id, m.kind, sig3(j), ...taus.map(sig3)]));

  // 表 C。
  console.log('\n### 表C: ワープ段ごとの subDt と、サブステップごとに引き直さないと ε を超える天体の本数\n');
  printTable(['warp', 'subDt [s]', ...TOLERANCES.map((eps) => `τ(${eps} m) < subDt`)],
    SIM_SPEED_LEVELS.map((warp) => {
      const subDt = simulationMaxStep(warp * FRAME_DT, SUBSTEP_MAX_DT, SUBSTEP_MAX_COUNT);
      return [
        `×${warp}`, sig3(subDt),
        ...TOLERANCES.map((_, k) => String(jerks.filter(({ taus }) => (taus[k] ?? Infinity) < subDt).length)),
      ];
    }));
  console.log(`\nPart 1 の壁時計: ${secondsSince(partStart)} s`);
}

// ---------------------------------------------------------------- Part 2

type PivotPolicy = 'substep' | 'frame';

// 1本の積分の結果。closest は closestTo の天体への最接近距離 [m](測らなければ Infinity)、
// wall は壁時計 [ms]。
type Integration = {
  readonly state: KinematicState;
  readonly closest: number;
  readonly wall: number;
};

// Simulator.advance と同じ区切りで state0 を tEnd まで積分する(重力と2次重力場だけ、重力源は
// 全数)。policy が 'frame' なら pivot をフレームの中点に1つ、'substep' ならサブステップごとの
// 中点に取る。refine はサブステップの刻みをさらに割る分割数。
function integrate(
  parts: SolarSystemParts, state0: KinematicState, tEnd: number, warp: number, frameDt: number,
  policy: PivotPolicy, refine: number, closestTo: string | null,
): Integration {
  const attractors = parts.system.gravityMotions;
  const start = performance.now();
  let state = state0;
  let simTime = state0.t;
  let closest = Infinity;
  while (simTime < tEnd) {
    const simDt = Math.min(warp * frameDt, tEnd - simTime);
    const maxStep = simulationMaxStep(simDt, SUBSTEP_MAX_DT, SUBSTEP_MAX_COUNT) / refine;
    const framePivot = simTime + simDt / 2;
    const target = simTime + simDt;
    while (simTime < target) {
      const endTime = Math.min(simTime + maxStep, target);
      const subDt = endTime - simTime;
      const pivot = policy === 'frame' ? framePivot : simTime + subDt / 2;
      state = stepDynamics(state, subDt, attractors, [], null, pivot, 0, 0, null);
      simTime = endTime;
      if (closestTo !== null) {
        closest = Math.min(closest, len(sub(state.r, stateOf(parts, closestTo, simTime).r)));
      }
    }
  }
  return { state, closest, wall: performance.now() - start };
}

// 積分のシナリオ。closestTo は最接近距離を測る相手の天体 id(測らないなら null)、heliocentric
// は終端の太陽中心距離を出すか、period は表に P/simDt を併記する公転周期 [s](併記しないなら null)。
type Scenario = {
  readonly title: string;
  readonly days: number;
  readonly warps: readonly number[];
  readonly state0: KinematicState;
  readonly closestTo: string | null;
  readonly heliocentric: boolean;
  readonly period: number | null;
};

// centerId を中心に半径 radius・法線 normal の円軌道に乗った t = 0 の状態。面内の向きは、
// ECI の +X(法線に近いときは +Z)を面へ落とした向き。
function circularState(parts: SolarSystemParts, centerId: string, radius: number, normal: Vec3): KinematicState {
  const center = stateOf(parts, centerId, 0);
  const mu = motionOf(parts, centerId).def.mu;
  const seed = Math.abs(normal.x) < 0.9 ? v3(1, 0, 0) : v3(0, 0, 1);
  const offset = scale(norm(sub(seed, scale(normal, dot(seed, normal)))), radius);
  const prograde = norm(cross(normal, offset));
  return kinematicState<'eci'>(0, add(center.r, offset), addScaled(center.v, prograde, Math.sqrt(mu / radius)));
}

// 近地点 = 高度 LEO_ALTITUDE、遠地点が到達時刻の月の位置(白道面内で進行方向側へ TLI_AIM_OFFSET
// ずらした点)を向く地球中心の楕円の、近地点での状態。
function tliState(parts: SolarSystemParts): KinematicState {
  const earth = motionOf(parts, 'earth').def;
  const moon = orbitingMotionOf(parts, 'moon');
  const rLeo = earth.radius + LEO_ALTITUDE;
  const a0 = (rLeo + MOON_DISTANCE) / 2;
  const tArrival = Math.PI * Math.sqrt(a0 ** 3 / earth.mu);
  const rm = stateOf(parts, 'moon', tArrival).r;
  const n = moon.orbitNormalAt(tArrival);
  const q = addScaled(rm, norm(cross(n, rm)), TLI_AIM_OFFSET);
  const a = (rLeo + len(q)) / 2;
  const qHat = norm(q);
  const perigee = scale(qHat, -rLeo);
  const speed = Math.sqrt(earth.mu * (2 / rLeo - 1 / a));
  return kinematicState<'eci'>(0, perigee, scale(norm(cross(n, scale(qHat, -1))), speed));
}

// 地球の公転進行方向 û = −(太陽の ECI 速度の単位ベクトル)へ CRUISE_DEPARTURE_DISTANCE 離れた
// 位置から、ECI 速度 CRUISE_DEPARTURE_SPEED × û で出発する状態。
function cruiseState(parts: SolarSystemParts): KinematicState {
  const u = norm(scale(stateOf(parts, 'sun', 0).v, -1));
  return kinematicState<'eci'>(0, scale(u, CRUISE_DEPARTURE_DISTANCE), scale(u, CRUISE_DEPARTURE_SPEED));
}

function scenarios(parts: SolarSystemParts): readonly Scenario[] {
  const earth = motionOf(parts, 'earth').def;
  const moon = orbitingMotionOf(parts, 'moon');
  const mars = orbitingMotionOf(parts, 'mars');
  const io = orbitingMotionOf(parts, 'io');
  const resonantPeriod = RESONANT_WARP * FRAME_DT;
  const resonantRadius = semiMajorFromPeriod(resonantPeriod, mars.def.mu);
  const none = { closestTo: null, heliocentric: false, period: null };
  return [
    {
      ...none, title: `LEO(地球原点, 半径 ${earth.radius} m + 高度 ${LEO_ALTITUDE / 1e3} km, 傾斜 ${LEO_INCLINATION_DEG}°)`,
      days: 5, warps: [16384, 65536, 131072], state0: leoState(parts),
    },
    {
      ...none, title: 'GEO(地球中心, 半径 4.2164e7 m, 赤道面)',
      days: 10, warps: [65536, 131072, 524288],
      state0: circularState(parts, 'earth', 4.2164e7, v3(0, 1, 0)),
    },
    {
      ...none, title: `TLI(月フライバイ, 近地点高度 ${LEO_ALTITUDE / 1e3} km, ずらし ${TLI_AIM_OFFSET.toExponential(0)} m)`,
      days: 5.5, warps: [65536, 131072, 524288], state0: tliState(parts), closestTo: 'moon',
    },
    {
      ...none, title: '低月周回(月中心, 高度 100 km, 白道面)',
      days: 5, warps: [16384, 65536, 131072],
      state0: circularState(parts, 'moon', moon.def.radius + 100e3, moon.orbitNormalAt(0)),
    },
    {
      ...none, title: '低火星周回(火星中心, 高度 300 km, 火星の軌道面)',
      days: 5, warps: [16384, 65536, 131072],
      state0: circularState(parts, 'mars', mars.def.radius + 300e3, mars.orbitNormalAt(0)),
    },
    {
      ...none, title: '火星静止軌道(火星中心, 半径 2.0428e7 m, 火星の軌道面)',
      days: 10, warps: [131072, 524288, 2097152],
      state0: circularState(parts, 'mars', 2.0428e7, mars.orbitNormalAt(0)),
    },
    {
      ...none, title: '低イオ周回(イオ中心, 高度 200 km, イオの軌道面)',
      days: 3, warps: [16384, 65536, 131072],
      state0: circularState(parts, 'io', io.def.radius + 200e3, io.orbitNormalAt(0)),
    },
    {
      ...none, title: '木星高軌道(木星中心, 半径 2.0e9 m, イオの軌道面)',
      days: 10, warps: [524288, 2097152, 8388608],
      state0: circularState(parts, 'jupiter', 2.0e9, io.orbitNormalAt(0)),
    },
    {
      ...none, title: `火星遷移巡航(地球から進行方向へ ${CRUISE_DEPARTURE_DISTANCE.toExponential(0)} m, ECI 速度 ${CRUISE_DEPARTURE_SPEED} m/s)`,
      days: 259, warps: [2097152, 8388608, 33554432], state0: cruiseState(parts), heliocentric: true,
    },
    {
      ...none, title: `火星周回・フレーム周期と共鳴(火星中心, 周期 ${resonantPeriod.toFixed(1)} s = ×${RESONANT_WARP} の simDt, 半径 ${sig3(resonantRadius)} m, 火星の軌道面)`,
      days: 10, warps: [524288, 2097152, 8388608],
      state0: circularState(parts, 'mars', resonantRadius, mars.orbitNormalAt(0)), period: resonantPeriod,
    },
  ];
}

function heliocentricAu(parts: SolarSystemParts, state: KinematicState): string {
  return (len(sub(state.r, stateOf(parts, 'sun', state.t).r)) / AU).toFixed(4);
}

// 1シナリオを全ワープ段で A / B / Ref の3通り走らせて表を出し、warp → |B−Ref| [m] を返す。
function runScenario(parts: SolarSystemParts, index: number, sc: Scenario, frameDt: number): Map<number, number> {
  const scenarioStart = performance.now();
  console.log(`\n### ${index}. ${sc.title} — ${sc.days} 日\n`);
  const headers = [
    'warp', 'B の外挿幅 simDt/2 [s]',
    ...(sc.period !== null ? ['P/simDt'] : []),
    '\\|A−Ref\\| [m]', '\\|B−Ref\\| [m]', '\\|B−A\\| [m]',
    ...(sc.closestTo !== null ? [`最接近 ${sc.closestTo} A / B / Ref [km]`] : []),
    ...(sc.heliocentric ? ['終端の太陽中心距離 A / B / Ref [AU]'] : []),
    '壁時計 A / B / Ref [s]',
  ];
  const bMinusRef = new Map<number, number>();
  const rows: string[][] = [];
  for (const warp of sc.warps) {
    const tEnd = sc.days * DAY;
    const a = integrate(parts, sc.state0, tEnd, warp, frameDt, 'substep', 1, sc.closestTo);
    const b = integrate(parts, sc.state0, tEnd, warp, frameDt, 'frame', 1, sc.closestTo);
    const ref = integrate(parts, sc.state0, tEnd, warp, frameDt, 'substep', REFERENCE_REFINE, sc.closestTo);
    bMinusRef.set(warp, distance(b.state, ref.state));
    const km = (m: number): string => (m / 1e3).toFixed(0);
    const sec = (ms: number): string => (ms / 1000).toFixed(1);
    rows.push([
      `×${warp}`, sig3((warp * frameDt) / 2),
      ...(sc.period !== null ? [sig3(sc.period / (warp * frameDt))] : []),
      sig3(distance(a.state, ref.state)), sig3(distance(b.state, ref.state)), sig3(distance(b.state, a.state)),
      ...(sc.closestTo !== null ? [`${km(a.closest)} / ${km(b.closest)} / ${km(ref.closest)}`] : []),
      ...(sc.heliocentric
        ? [`${heliocentricAu(parts, a.state)} / ${heliocentricAu(parts, b.state)} / ${heliocentricAu(parts, ref.state)}`]
        : []),
      `${sec(a.wall)} / ${sec(b.wall)} / ${sec(ref.wall)}`,
    ]);
  }
  printTable(headers, rows);
  console.log(`\nシナリオ ${index} の壁時計: ${secondsSince(scenarioStart)} s`);
  return bMinusRef;
}

function part2(parts: SolarSystemParts, list: readonly Scenario[]): Map<string, number> {
  const partStart = performance.now();
  console.log('\n## Part 2: 軌道積分の誤差(A = 現行 substep pivot, B = 案1 frame pivot, Ref = substep pivot × refine 4)\n');
  console.log('積分は stepDynamics(重力 + 2次重力場、重力源は gravityMotions の全数、大気・輻射圧・推力なし)。');
  console.log('終端位置の差 [m] と、各走行の壁時計 [s]。');
  const baseline = new Map<string, number>();
  list.forEach((sc, i) => {
    for (const [warp, err] of runScenario(parts, i + 1, sc, FRAME_DT)) baseline.set(`${i + 1}:${warp}`, err);
  });
  console.log(`\nPart 2 の壁時計: ${secondsSince(partStart)} s`);
  return baseline;
}

// ---------------------------------------------------------------- Part 3

function part3(parts: SolarSystemParts, list: readonly Scenario[], baseline: Map<string, number>): void {
  const partStart = performance.now();
  console.log(`\n## Part 3: frameDt の感度(B と Ref を frameDt = 1/30 s でも走らせ、|B−Ref| を 1/60 s と並べる)\n`);
  const rows = FRAME_RATE_PROBES.map(({ scenario, warp }) => {
    const sc = list[scenario - 1];
    if (sc === undefined) throw new Error(`シナリオ ${scenario} が無い`);
    const tEnd = sc.days * DAY;
    const b = integrate(parts, sc.state0, tEnd, warp, FRAME_DT_HALF_RATE, 'frame', 1, null);
    const ref = integrate(parts, sc.state0, tEnd, warp, FRAME_DT_HALF_RATE, 'substep', REFERENCE_REFINE, null);
    const errHalfRate = distance(b.state, ref.state);
    const errBase = baseline.get(`${scenario}:${warp}`) ?? NaN;
    return [
      `${scenario}. ${sc.title}`, `×${warp}`,
      sig3((warp * FRAME_DT) / 2), sig3(errBase),
      sig3((warp * FRAME_DT_HALF_RATE) / 2), sig3(errHalfRate),
      sig3(errHalfRate / errBase),
      `${(b.wall / 1000).toFixed(1)} / ${(ref.wall / 1000).toFixed(1)}`,
    ];
  });
  printTable([
    'シナリオ', 'warp', 'simDt/2 @1/60 [s]', '\\|B−Ref\\| @1/60 [m]', 'simDt/2 @1/30 [s]', '\\|B−Ref\\| @1/30 [m]',
    '比(1/30 ÷ 1/60)', '壁時計 B / Ref @1/30 [s]',
  ], rows);
  console.log(`\nPart 3 の壁時計: ${secondsSince(partStart)} s`);
}

// ---------------------------------------------------------------- 入口

export function run(): void {
  const start = performance.now();
  const parts = solarSystemParts();
  printHeader(parts);
  part0(parts);
  part1(parts);
  const list = scenarios(parts);
  const baseline = part2(parts, list);
  part3(parts, list, baseline);
  console.log(`\n全体の壁時計: ${secondsSince(start)} s`);
}

// webpack 用に `require` がグローバル宣言されているので、node の require はここで作る。
if (createRequire(__filename).main === module) run();
