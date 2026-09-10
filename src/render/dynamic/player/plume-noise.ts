// 噴射の揺らぎに使う乱数の種。同じ個体・同じ表示時刻・同じノズルからは必ず同じ値になり、
// フレーム番号や sync の回数には依らない — ポーズ中や再同期で見た目が変わらないようにする。

// id は個体、displayTime は表示時刻 [s]、nozzleIndex はその個体の何番目のノズルか。
export function plumeNoiseSeed(id: string, displayTime: number, nozzleIndex: number): number {
  // 表示時刻はマイクロ秒まで整数へ落として混ぜる。桁が溢れても混ざり方が変わるだけ。
  let seed = Math.imul(Math.trunc(displayTime * 1e6), 0x9e3779b1) + nozzleIndex;
  for (let i = 0; i < id.length; i++) seed = Math.imul(seed ^ id.charCodeAt(i), 0x01000193);
  return seed >>> 0;
}
