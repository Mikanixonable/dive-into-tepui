// 座標型に依存しない、乱数そのものを生成するユーティリティ。

// シード値から [0, 1) の一様乱数列を生成する mulberry32。Math.random を経由しないので、
// 同じシードから常に同じ列を再現できる(セーブ・リプレイ・負荷計測の再現性が要る箇所向け)。
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let x = Math.imul(s ^ (s >>> 15), 1 | s);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

// [-amp, amp] の一様乱数。rand は [0, 1) を返す生成器(既定 Math.random)。
export function randSym(amp: number, rand: () => number = Math.random): number {
  return (rand() * 2 - 1) * amp;
}
