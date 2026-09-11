// 噴射の揺らぎに使う乱数の種。個体・表示時刻・ノズルの組が同じなら常に同じ値を返し、
// ポーズ中や再同期でも見た目を保つ。

// id は個体、displayTime は表示時刻 [s]、nozzleIndex はその個体の何番目のノズルか。
export function plumeNoiseSeed(id: string, displayTime: number, nozzleIndex: number): number {
  // 表示時刻はマイクロ秒まで整数へ落として混ぜる。桁が溢れても混ざり方が変わるだけ。
  let seed = Math.imul(Math.trunc(displayTime * 1e6), 0x9e3779b1) + nozzleIndex;
  for (let i = 0; i < id.length; i++) seed = Math.imul(seed ^ id.charCodeAt(i), 0x01000193);
  return seed >>> 0;
}
