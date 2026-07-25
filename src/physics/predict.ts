// 時間ベース軌道の数値予測プリミティブ(純粋関数、THREE/DOM 非依存)。中心重力 + J2 +
// 月・太陽の第三体摂動で RK4 積分する。大気抵抗は意図的に省略する(計画ツールであることに
// 加え、高度200km以上では抵抗による軌道変化が予測期間(最大28日)に対して無視できるほど
// 小さいため)。
//
// 扱うのは単一 arc の自由伝播だけ — マニューバノードによる区間分割は知らない。それは
// plan 側の責務で、plan-editor / plan-trajectory がノード境界ごとにこのプリミティブを呼ぶ。
import { ExtraAccel, OrbitState, orbitState, stepOrbitRK4 } from './orbital';
import { Ephemeris } from './ephemeris';
import { envAccelInto } from './envaccel';
import { Vec3, clone, cross, len, norm, v3 } from './vec3';

export interface TrajectorySample {
  t: number; // 絶対 simTime [s]
  r: Vec3; // ECI 位置 [m]
  v: Vec3; // ECI 速度 [m/s]
}

// 環境加速度(J2 + 月 + 太陽の第三体摂動のみ。bcInv = 0 で大気抵抗を省略)
function envAccel(sunPos: Vec3, moonPos: Vec3): ExtraAccel {
  return (r: Vec3, v: Vec3, out?: Vec3): Vec3 =>
    envAccelInto(out ?? v3(), r, v, sunPos, moonPos, 0);
}

// state を dt だけ前進させる(中点 t+dt/2 の太陽・月位置で環境加速度を評価)。
// predictTrajectory と propagateState が共有する 1 ステップ。
function stepPredict(state: OrbitState, t: number, dt: number, ephemeris: Ephemeris): void {
  const mid = t + dt / 2;
  const accel = envAccel(ephemeris.sunPosAt(mid), ephemeris.moonPosAt(mid));
  stepOrbitRK4(state, dt, accel);
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

// state0(時刻 t0)から duration 秒ぶん、大気抵抗なしで自由伝播した軌道点列を RK4 で
// 数値予測する。サンプルは概ね maxSamples 個になるよう間引いて保持する(低軌道でも
// 28日 = 数万ステップになり得るため、全ステップ保持は描画・ピッキングのコストが無視
// できなくなる)。マニューバノードによる区間分割は行わない — 呼び出し側(plan)が
// arc ごとにこの関数を呼ぶ。
export function predictTrajectory(
  state0: OrbitState,
  t0: number,
  duration: number,
  ephemeris: Ephemeris,
  maxSamplesOpt?: number, // 保持するサンプル数の上限(既定 2000)
): TrajectorySample[] {
  if (duration <= 0) return [{ t: t0, r: clone(state0.r), v: clone(state0.v) }];

  const maxSamples = Math.max(10, maxSamplesOpt ?? 2000);
  const tEnd = t0 + duration;
  const state = orbitState(clone(state0.r), clone(state0.v));
  let t = t0;

  // 平均刻み幅からステップ総数を概算し、間引き間隔を決める(2回積分せずに済むよう
  // 開始時の動径から見積もる。動径が大きく変わる軌道(高楕円等)では粗い見積もりに
  // なるが、間引きは表示密度の問題でしかないため実用上問題ない)。
  const estSteps = Math.max(1, Math.ceil(duration / predictStepDt(len(state.r), duration)));
  const storeEvery = Math.max(1, Math.floor(estSteps / maxSamples));

  const samples: TrajectorySample[] = [{ t, r: clone(state.r), v: clone(state.v) }];
  let sinceStore = 0;

  while (t < tEnd - 1e-6) {
    const dt = Math.min(predictStepDt(len(state.r), duration), tEnd - t);
    if (dt <= 1e-9) break;
    stepPredict(state, t, dt, ephemeris);
    t += dt;
    sinceStore++;
    if (sinceStore >= storeEvery || t >= tEnd - 1e-9) {
      samples.push({ t, r: clone(state.r), v: clone(state.v) });
      sinceStore = 0;
    }
  }

  return samples;
}

// state0(時刻 t0)を targetT まで自由伝播した最終状態だけを返す(サンプルは保持しない)。
// plan がノード到達直前(噴射前)の状態 = Δv 導出の基準を得るのに使う。predictTrajectory と
// 同じ刻み系列で積分するので、両者の終端は一致する。
export function propagateState(
  state0: OrbitState,
  t0: number,
  targetT: number,
  ephemeris: Ephemeris,
): OrbitState {
  const state = orbitState(clone(state0.r), clone(state0.v));
  let t = t0;
  while (t < targetT - 1e-6) {
    const dt = Math.min(predictStepDt(len(state.r), targetT - t0), targetT - t);
    if (dt <= 1e-9) break;
    stepPredict(state, t, dt, ephemeris);
    t += dt;
  }
  return state;
}

// samples から時刻 t の状態を二分探索 + 線形補間で求める(範囲外は端にクランプ)。
// ノード直後の強制サンプルにより、ノード通過の瞬間だけ速度が不連続になる区間が
// 生じ得るが、その区間は 1 ステップぶん(数〜数百秒)しかなく、計画ツールの
// 表示・ワープ照準用途では実用上問題にならない。
export function sampleAt(samples: readonly TrajectorySample[], t: number): TrajectorySample | null {
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
