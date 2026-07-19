// マップモードの複数ノード・時間ベース軌道計画のための数値予測(純粋関数、
// THREE/DOM 非依存)。中心重力 + J2 + 月・太陽の第三体摂動で RK4 積分する。
// 大気抵抗は意図的に省略する(計画ツールであることに加え、高度200km以上では
// 抵抗による軌道変化が予測期間(最大28日)に対して無視できるほど小さいため)。
import {
  ExtraAccel,
  OrbitState,
  j2AccelInto,
  stepOrbitRK4,
  thirdBodyAccelAdd,
} from './orbital';
import { MU_MOON, MU_SUN, moonPosition, sunPosition } from './ephemeris';
import { Vec3, add, clone, cross, len, norm, v3 } from './vec3';

// ノードでの Δv(現在の速度・位置から定義するローカル成分: x=プログレード, y=軌道法線(ノーマル), z=ラジアルアウト)。
export interface PlannedNode {
  time: number; // 実行時刻(絶対 simTime)[s]
  dv: Vec3;
}

export interface TrajectorySample {
  t: number; // 絶対 simTime [s]
  r: Vec3; // ECI 位置 [m]
  v: Vec3; // ECI 速度 [m/s]
}

export interface PredictOpts {
  sunPhase0: number;
  moonPhase0: number;
  maxSamples?: number; // 保持するサンプル数の上限(既定 2000)
}

// 環境加速度(J2 + 月 + 太陽の第三体摂動のみ。大気抵抗は含まない)
function envAccel(sunPos: Vec3, moonPos: Vec3): ExtraAccel {
  return (r: Vec3, _v: Vec3, out?: Vec3): Vec3 => {
    const acc = j2AccelInto(out ?? v3(), r);
    thirdBodyAccelAdd(acc, r, sunPos, MU_SUN);
    thirdBodyAccelAdd(acc, r, moonPos, MU_MOON);
    return acc;
  };
}

// ノードの Δv(プログレード/ノーマル/ラジアルアウト)を、その時点の r, v から
// ワールド ECI ベクトルへ変換する。ゲーム側の「ノード時刻超過時のフォールバック
// 目標構築」でも使うため export する。
export function dvToWorld(r: Vec3, v: Vec3, dv: Vec3): Vec3 {
  const pro = norm(v);
  const h = norm(cross(r, v));
  const radOut = cross(pro, h);
  return v3(
    pro.x * dv.x + h.x * dv.y + radOut.x * dv.z,
    pro.y * dv.x + h.y * dv.y + radOut.y * dv.z,
    pro.z * dv.x + h.z * dv.y + radOut.z * dv.z,
  );
}

// 現在の動径から刻み幅を決める(低軌道では細かく、遠方では粗く)。
// LEO(~6.8e6m)で dt≈8.5s(周期の1/~1000 程度、多角形に見えない滑らかさ)、
// 月軌道付近(~4e8m)で上限の600sにクランプされる。
// duration(今回の予測全体の長さ)が長いほど、この基準刻みに coarsen 倍率を掛けて
// 粗くする——1周回・1日ぶんの近距離プレビューは秒単位の細かさを保つ一方、
// 28日ぶんを LEO の秒刻みで積分すると(間引いて捨てるだけの)無駄な RK4 ステップが
// 数十万回に達し 1 回の再計算で数百 ms かかってしまう(このツールは計画・表示用途で、
// ノード実行直前の精密なガイドは戦闘ビュー側が短い期間だけ別途高分解能で再計算するため、
// 遠い将来ぶんの粗さは実用上問題にならない)。
export function predictStepDt(r: number, duration: number): number {
  const coarsen = Math.max(1, Math.min(8, duration / 86400));
  return Math.max(5, Math.min(600, (r / 8e5) * coarsen));
}

// state0(t0 時点)から duration 秒ぶん、nodes の Δv を適宜適用しながら RK4 で
// 数値予測する。サンプルは概ね maxSamples 個になるよう間引いて保持する
// (低軌道でも 28日 = 数万ステップになり得るため、全ステップを保持すると
// 描画・ピッキングのコストが無視できなくなる)。
export function predictTrajectory(
  state0: OrbitState,
  t0: number,
  duration: number,
  nodes: PlannedNode[],
  opts: PredictOpts,
): TrajectorySample[] {
  if (duration <= 0) return [{ t: t0, r: clone(state0.r), v: clone(state0.v) }];

  const sorted = nodes
    .filter((n) => n.time > t0 && n.time <= t0 + duration)
    .slice()
    .sort((a, b) => a.time - b.time);
  const maxSamples = Math.max(10, opts.maxSamples ?? 2000);
  const tEnd = t0 + duration;

  let r = clone(state0.r);
  let v = clone(state0.v);
  let t = t0;
  let nodeIdx = 0;

  // 平均刻み幅からステップ総数を概算し、間引き間隔を決める(2回積分せずに済むよう
  // 開始時の動径から見積もる。動径が大きく変わる軌道(高楕円等)では粗い見積もりに
  // なるが、間引きは表示密度の問題でしかないため実用上問題ない)。
  const estSteps = Math.max(1, Math.ceil(duration / predictStepDt(len(r), duration)));
  const storeEvery = Math.max(1, Math.floor(estSteps / maxSamples));

  const samples: TrajectorySample[] = [{ t, r: clone(r), v: clone(v) }];
  let sinceStore = 0;

  while (t < tEnd - 1e-6) {
    let dt = predictStepDt(len(r), duration);
    let hitNode = false;
    if (nodeIdx < sorted.length && sorted[nodeIdx]!.time - t <= dt) {
      dt = Math.max(0, sorted[nodeIdx]!.time - t);
      hitNode = true;
    }
    dt = Math.min(dt, tEnd - t);

    if (dt > 1e-9) {
      const mid = t + dt / 2;
      const accel = envAccel(sunPosition(mid, opts.sunPhase0), moonPosition(mid, opts.moonPhase0));
      const state = { r, v };
      stepOrbitRK4(state, dt, accel);
      r = state.r;
      v = state.v;
      t += dt;
      sinceStore++;
    } else if (hitNode) {
      t = sorted[nodeIdx]!.time;
    }

    if (hitNode) {
      const node = sorted[nodeIdx]!;
      v = add(v, dvToWorld(r, v, node.dv));
      nodeIdx++;
      samples.push({ t, r: clone(r), v: clone(v) });
      sinceStore = 0;
      continue;
    }

    if (sinceStore >= storeEvery || t >= tEnd - 1e-9) {
      samples.push({ t, r: clone(r), v: clone(v) });
      sinceStore = 0;
    }
  }

  return samples;
}

// samples から時刻 t の状態を二分探索 + 線形補間で求める(範囲外は端にクランプ)。
// ノード直後の強制サンプルにより、ノード通過の瞬間だけ速度が不連続になる区間が
// 生じ得るが、その区間は 1 ステップぶん(数〜数百秒)しかなく、計画ツールの
// 表示・ワープ照準用途では実用上問題にならない。
export function sampleAt(samples: TrajectorySample[], t: number): TrajectorySample | null {
  if (samples.length === 0) return null;
  const first = samples[0]!;
  if (t <= first.t) return first;
  const last = samples[samples.length - 1]!;
  if (t >= last.t) return last;

  let lo = 0;
  let hi = samples.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid]!.t <= t) lo = mid;
    else hi = mid;
  }
  const a = samples[lo]!;
  const b = samples[hi]!;
  const span = b.t - a.t;
  const f = span > 1e-9 ? (t - a.t) / span : 0;
  return {
    t,
    r: v3(a.r.x + (b.r.x - a.r.x) * f, a.r.y + (b.r.y - a.r.y) * f, a.r.z + (b.r.z - a.r.z) * f),
    v: v3(a.v.x + (b.v.x - a.v.x) * f, a.v.y + (b.v.y - a.v.y) * f, a.v.z + (b.v.z - a.v.z) * f),
  };
}
