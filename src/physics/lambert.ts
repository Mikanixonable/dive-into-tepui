// ランベルト問題: 中心天体の重力定数 mu のまわりで、位置 r1 から位置 r2 へ飛行時間 tof で
// 結ぶ円錐曲線軌道を求める。解法は Izzo (2015) の無次元化で、x の方程式は関数が単調である
// ことを利用した保護付き二分法で解く — 初期値依存の Householder 反復より遅いが、
// 「解ける/解けない」と収束値が入力だけで決まる(決定性)のでこちらを採る。
// THREE/DOM 非依存。
import { addScaled, cross, dot, len, norm, scale, sub, type Vec3 } from '../math/vec3';

export interface LambertSolution {
  readonly v1: Vec3; // r1 での遷移軌道速度(中心天体相対) [m/s]
  readonly v2: Vec3; // r2 での遷移軌道速度 [m/s]
  readonly revolutions: number; // 途中の完全周回数
  readonly a: number; // 遷移軌道の半長軸 [m] (双曲線では負)
}

// 無次元飛行時間 T(x, N)。Izzo の変数 x(半長軸が a = s/(2(1−x²)) と対応)で、
// 扇形公式 α = 2 arccos x、β = 2 arccos y、y = √(1−λ²(1−x²)) のもと
//   T = [ (α − sin α) − (β − sin β) + 2πN ] / ( 2(1−x²)^{3/2} )    (|x|<1, 楕円)
// 双曲線枝(x>1、N=0 のみ)は解析接続で α=2 arccosh x、β=2 arccosh y。
// N=0 では x→−1 で +∞、x→1(放物線)で T=(2/3)(1−λ³) の単調減少。N≥1 は両端 +∞ の
// 内部に最小値を持つ。
function tofND(x: number, lam: number, revs: number): number {
  const xx = x * x;
  if (x > 1) {
    const y = Math.sqrt(1 + lam * lam * (xx - 1));
    const alpha = 2 * Math.acosh(x);
    const beta = 2 * Math.acosh(y);
    const num = (Math.sinh(alpha) - alpha) - (Math.sinh(beta) - beta);
    return num / (2 * Math.pow(xx - 1, 1.5));
  }
  const omx2 = 1 - xx; // 0 < omx2 ≤ 1
  const y = Math.sqrt(Math.max(0, 1 - lam * lam * omx2));
  const alpha = 2 * Math.acos(Math.max(-1, Math.min(1, x)));
  const beta = 2 * Math.acos(Math.max(-1, Math.min(1, y)));
  const num = (alpha - Math.sin(alpha)) - (beta - Math.sin(beta)) + 2 * Math.PI * revs;
  return num / (2 * Math.pow(omx2, 1.5));
}

// f(x)=tofND(x)−target の零点を (lo,hi) の内部で探す。f(lo)・f(hi) が異符号を
// 前提に二分法で絞る。反復回数は誤差が倍精度へ収まる 200 回。
function bisectT(target: number, lam: number, revs: number, lo: number, hi: number): number | null {
  let fLo = tofND(lo, lam, revs) - target;
  if (!(fLo * (tofND(hi, lam, revs) - target) <= 0)) return null;
  let a = lo, b = hi;
  for (let i = 0; i < 200; i++) {
    const mid = (a + b) / 2;
    const fMid = tofND(mid, lam, revs) - target;
    if (fMid === 0) return mid;
    if (fLo * fMid < 0) { b = mid; } else { a = mid; fLo = fMid; }
  }
  return (a + b) / 2;
}

const X_EDGE = 1 - 1e-9;

// 指定周回数での x の解。0周は(−1,1)内に1つ(T≥(2/3)(1−λ³))か双曲線枝に1つ(T<その値)。
// N≥1 は T(x) が内部に最小値を1つ持ち、T≥T_min で左右2解、T=T_min で重解、
// T<T_min で解なし。
function solveX(target: number, lam: number, revs: number): number[] {
  if (revs === 0) {
    const tParab = (2 / 3) * (1 - lam * lam * lam);
    if (target >= tParab) {
      const x = bisectT(target, lam, 0, -X_EDGE, X_EDGE);
      return x === null ? [] : [x];
    }
    // 双曲線枝: T(1)=(2/3)(1−λ³) で x→∞ へ単調減少。上限は T が target を
    // 下回るまで伸ばす。
    let hi = 2;
    while (tofND(hi, lam, 0) > target && hi < 1e9) hi *= 4;
    if (tofND(hi, lam, 0) > target) return [];
    const x = bisectT(target, lam, 0, 1 + 1e-9, hi);
    return x === null ? [] : [x];
  }

  // 内部の最小値 x_min を三分探索で求める(T は (−1,1) で両端 +∞ の単峰)。
  let lo = -X_EDGE, hi = X_EDGE;
  for (let i = 0; i < 200; i++) {
    const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3;
    if (tofND(m1, lam, revs) < tofND(m2, lam, revs)) hi = m2; else lo = m1;
  }
  const xMin = (lo + hi) / 2;
  const tMin = tofND(xMin, lam, revs);
  if (target < tMin) return [];
  if (Math.abs(target - tMin) / tMin < 1e-12) return [xMin];
  const out: number[] = [];
  const xl = bisectT(target, lam, revs, -X_EDGE, xMin);
  const xr = bisectT(target, lam, revs, xMin, X_EDGE);
  if (xl !== null) out.push(xl);
  if (xr !== null && xr !== xl) out.push(xr);
  return out;
}

// r1→r2 を tof [s] で結ぶ円錐曲線の解をすべて返す。
// - prograde: 移動方向が r1×r2 の向きと一致(短い方の弧)。false なら反対回り。
// - maxRevs: 途中で完全周回する解を何周まで許すか。
// 解なし(飛行時間が短すぎる等)は空配列。r1,r2 は中心天体相対の位置。
export function solveLambert(
  r1: Vec3, r2: Vec3, tof: number, mu: number,
  opts: { prograde?: boolean; maxRevs?: number } = {},
): LambertSolution[] {
  const { prograde = true, maxRevs = 0 } = opts;
  const r1m = len(r1), r2m = len(r2);
  if (!(r1m > 0) || !(r2m > 0) || !(tof > 0) || !(mu > 0)) return [];

  const chord = sub(r2, r1);
  const c = len(chord);
  const s = (r1m + r2m + c) / 2;
  if (!(c > 0) || !(s >= c)) return []; // 縮退配置は lambda が定まらない(180°は面が不定)

  // λ² = 1 − c/s。転移角 θ<π なら λ>0。逆行・長回りでは λ の符号を反転する。
  const lam2 = 1 - c / s;
  const lamBase = Math.sqrt(Math.max(0, lam2));
  const r1h = norm(r1), r2h = norm(r2);
  const hVec = cross(r1, r2);
  if (len(hVec) < 1e-12 * r1m * r2m) return [];
  const h = norm(hVec);
  const lam = prograde ? lamBase : -lamBase;

  const T = Math.sqrt((2 * mu) / (s * s * s)) * tof;
  const out: LambertSolution[] = [];

  for (let revs = 0; revs <= maxRevs; revs++) {
    for (const x of solveX(T, lam, revs)) {
      const y = Math.sqrt(Math.max(0, 1 - lam * lam * (1 - x * x)));
      const rho = (r1m - r2m) / c;
      const sigma = Math.sqrt(Math.max(0, 1 - rho * rho));
      const gamma = Math.sqrt((mu * s) / 2);

      const vr1 = (gamma * ((lam * y - x) - rho * (lam * y + x))) / r1m;
      const vr2 = (-gamma * ((lam * y - x) + rho * (lam * y + x))) / r2m;
      const vt = (gamma * sigma * (y + lam * x));

      // 接線方向の単位ベクトル。prograde では進行側が h×r̂、逆行ではその逆。
      const t1 = prograde ? norm(cross(h, r1h)) : norm(cross(r1h, h));
      const t2 = prograde ? norm(cross(h, r2h)) : norm(cross(r2h, h));
      const v1 = addScaled(scale(r1h, vr1), t1, vt / r1m);
      const v2 = addScaled(scale(r2h, vr2), t2, vt / r2m);
      const energy = dot(v1, v1) / 2 - mu / r1m;
      const a = Math.abs(energy) > 1e-12 ? -mu / (2 * energy) : Infinity;
      out.push({ v1, v2, revolutions: revs, a });
    }
  }
  return out;
}
