// 離散サンプルの節点列から、節点間を3次エルミート(両端の位置を通り、両端の接線を持つ)で埋めた
// 曲線を組む。
import type { CurveKnots, CurveSampler } from './curve';

// 節点列から組んだ曲線。ts は間引いたあとの節点のパラメータ列(昇順、先頭 0・末尾 1)。
export interface HermiteCurve {
  readonly sample: CurveSampler;
  readonly ts: ArrayLike<number>;
}

// knots の節点間を3次エルミートで埋めた曲線を組む。節点が maxCount 個を超えるぶんは元の並びの
// 上で等間隔に間引く(両端は残すので定義域は縮まない)。節点が2個未満か、パラメータが昇順で
// なければ例外を投げる。
export function buildHermiteCurve(knots: CurveKnots, maxCount: number): HermiteCurve {
  const source = knots.ts;
  if (source.length < 2) throw new Error(`Curve: 節点が ${source.length} 個では曲線にならない`);
  const last = source.length - 1;
  const count = Math.min(source.length, maxCount);
  const ts = new Float64Array(count);
  const positions = new Float64Array(count * 3);
  const tangents = new Float64Array(count * 3);
  for (let i = 0; i < count; i++) {
    const j = count === source.length ? i : Math.round((i * last) / (count - 1));
    ts[i] = source[j]!;
    if (i > 0 && ts[i]! <= ts[i - 1]!) throw new Error(`Curve: 節点のパラメータが昇順でない (i=${j})`);
    for (let k = 0; k < 3; k++) {
      positions[i * 3 + k] = knots.positions[j * 3 + k]!;
      tangents[i * 3 + k] = knots.tangents[j * 3 + k]!;
    }
  }

  // 節点区間の両端の位置と接線から、区間内を3次エルミートで埋める。
  const sample: CurveSampler = (t, out) => {
    // t を含む区間 [i, i+1] を二分探索で引く。両端の外は端の区間へ寄せる。
    let lo = 0, hi = count - 2;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ts[mid]! <= t) lo = mid; else hi = mid - 1;
    }
    const h = ts[lo + 1]! - ts[lo]!;
    const s = Math.max(0, Math.min(1, (t - ts[lo]!) / h));
    const s2 = s * s, s3 = s2 * s;
    const w0 = 2 * s3 - 3 * s2 + 1, w1 = (s3 - 2 * s2 + s) * h;
    const w2 = -2 * s3 + 3 * s2, w3 = (s3 - s2) * h;
    const a = lo * 3, b = a + 3;
    out.set(
      w0 * positions[a]! + w1 * tangents[a]! + w2 * positions[b]! + w3 * tangents[b]!,
      w0 * positions[a + 1]! + w1 * tangents[a + 1]! + w2 * positions[b + 1]! + w3 * tangents[b + 1]!,
      w0 * positions[a + 2]! + w1 * tangents[a + 2]! + w2 * positions[b + 2]! + w3 * tangents[b + 2]!,
    );
  };
  return { sample, ts };
}
