// 1変数の単峰関数を最小化する汎用の数値探索。THREE/DOM 非依存の純関数。

// [lo, hi] で f を最小にする位置を黄金分割探索で追い込み、その位置を返す。区間内で f が
// 単峰であることを前提にする。反復回数は呼び出し側が決める — 収束判定にすると回数が
// 実行ごとに変動し、その分だけ結果が揺れるため。
export function goldenSectionMin(lo: number, hi: number, f: (x: number) => number, iterations: number): number {
  const phi = (Math.sqrt(5) - 1) / 2;
  // [lo, hi] 内の2点 x1<x2 を評価し、劣る側を含む半区間を毎回捨てて残りを縮める。
  let x1 = hi - phi * (hi - lo);
  let x2 = lo + phi * (hi - lo);
  let f1 = f(x1);
  let f2 = f(x2);
  for (let i = 0; i < iterations; i++) {
    if (f1 > f2) {
      lo = x1;
      x1 = x2; f1 = f2;
      x2 = lo + phi * (hi - lo);
      f2 = f(x2);
    } else {
      hi = x2;
      x2 = x1; f2 = f1;
      x1 = hi - phi * (hi - lo);
      f1 = f(x1);
    }
  }
  return (lo + hi) / 2;
}
