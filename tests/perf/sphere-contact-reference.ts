// 掃引接触判定を外から測るための参照実装。判定器と同じ制御点で曲線を張り直し、原点との
// 最接近距離を密なサンプリングで出す。**判定器の内部は一切使わない** — 判定器がその最接近
// 距離をどこで拾うかを測るのが目的なので、参照が判定器を経由してはならない。
import { Vec3, len, scale, sub, v3 } from '../../src/math/vec3';
import { Solver, Sweep, solve } from './sphere-contact-sweeps';

const SAMPLES = 200001;
const REFINE_ITERATIONS = 120;
const FLIP_ITERATIONS = 100;

function controlPoints(s: Sweep, solver: Solver): readonly Vec3[] {
  const dt = s.aEnd.t - s.aStart.t;
  const p0 = sub(s.bStart.r, s.aStart.r);
  const p1 = sub(s.bEnd.r, s.aEnd.r);
  const t0 = scale(sub(s.bStart.v, s.aStart.v), dt);
  const t1 = scale(sub(s.bEnd.v, s.aEnd.v), dt);
  if (solver === '弦') return [p0, p1];
  if (solver === '二次') {
    return [p0, v3(
      (p0.x + p1.x) / 2 + (t0.x - t1.x) / 4,
      (p0.y + p1.y) / 2 + (t0.y - t1.y) / 4,
      (p0.z + p1.z) / 2 + (t0.z - t1.z) / 4), p1];
  }
  return [p0,
    v3(p0.x + t0.x / 3, p0.y + t0.y / 3, p0.z + t0.z / 3),
    v3(p1.x - t1.x / 3, p1.y - t1.y / 3, p1.z - t1.z / 3), p1];
}

// de Casteljau。次数は制御点の数で決まる。
function bezierAt(control: readonly Vec3[], u: number): Vec3 {
  let level = control;
  while (level.length > 1) {
    const next: Vec3[] = [];
    for (let i = 0; i + 1 < level.length; i++) {
      const a = level[i]!, b = level[i + 1]!;
      next.push(v3(a.x + (b.x - a.x) * u, a.y + (b.y - a.y) * u, a.z + (b.z - a.z) * u));
    }
    level = next;
  }
  return level[0]!;
}

// その近似曲線が相手の中心へどこまで近づくか。粗いサンプリングで谷を見つけ、黄金分割で詰める。
export function minDistanceOf(s: Sweep, solver: Solver): number {
  const control = controlPoints(s, solver);
  let best = Infinity;
  let bu = 0;
  for (let i = 0; i < SAMPLES; i++) {
    const u = i / (SAMPLES - 1);
    const d = len(bezierAt(control, u));
    if (d < best) { best = d; bu = u; }
  }
  let lo = Math.max(0, bu - 1 / (SAMPLES - 1));
  let hi = Math.min(1, bu + 1 / (SAMPLES - 1));
  for (let k = 0; k < REFINE_ITERATIONS; k++) {
    const m1 = lo + (hi - lo) / 3;
    const m2 = hi - (hi - lo) / 3;
    if (len(bezierAt(control, m1)) < len(bezierAt(control, m2))) hi = m2; else lo = m1;
  }
  return Math.min(best, len(bezierAt(control, (lo + hi) / 2)));
}

function crosses(s: Sweep, solver: Solver, radiusSum: number): boolean {
  const c = solve(s, solver, radiusSum);
  return c !== null && !c.startsInside && c.crossing !== null;
}

// 判定器の答えが「跨ぎなし」から「跨ぐ」へ反転する半径和。始点で重なる手前を上限に取るので、
// 最接近が区間の端にある配置では反転が起きず null になる。
export function flipRadius(s: Sweep, solver: Solver): number | null {
  let hi = Math.min(len(sub(s.bStart.r, s.aStart.r)), len(sub(s.bEnd.r, s.aEnd.r))) * (1 - 1e-13);
  if (!crosses(s, solver, hi)) return null;
  let lo = 0;
  for (let k = 0; k < FLIP_ITERATIONS; k++) {
    const mid = (lo + hi) / 2;
    if (crosses(s, solver, mid)) hi = mid; else lo = mid;
  }
  return (lo + hi) / 2;
}

