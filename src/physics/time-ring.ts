// 時刻 t をキーにした固定長リングと、その照合統計。キーが厳密に一致したときだけ保持値を
// 返し、不一致なら undefined を返す。同一の t に対しては常に同じ参照が返り、
// 参照順序による結果の変動は生じない。

// 時刻キャッシュの保持スロット数。1フレーム中の t と t + dt/2 の交互参照、対象ごとの先端時刻、
// 近点・遠点・ノードなどの単発時刻の流入によって主要エントリが押し出されないよう
// 十分なスロット数を持たせる。照合はこのスロット数分の数値比較であり、再計算コストに比べ軽微。
const TIME_CACHE_SLOTS = 32;

// 時刻キャッシュのヒット/ミスの累計。
export interface TimeCacheStats {
  readonly hits: number;
  readonly misses: number;
}

// 2つの累計の和。
export function addTimeCacheStats(a: TimeCacheStats, b: TimeCacheStats): TimeCacheStats {
  return { hits: a.hits + b.hits, misses: a.misses + b.misses };
}

export class TimeRing<T> {
  private readonly keys: number[] = new Array(TIME_CACHE_SLOTS).fill(NaN);
  private readonly values: (T | undefined)[] = new Array(TIME_CACHE_SLOTS).fill(undefined);
  private next = 0;
  private hits = 0;
  private misses = 0;
  // 直近でヒットしたスロット。積分の内側は同じ時刻を連続で参照するため、線形走査の前にここを照合する。
  private lastHit = 0;

  // get の照合の累計。返る値には影響しない。
  get stats(): TimeCacheStats {
    return { hits: this.hits, misses: this.misses };
  }

  // t に一致する保持値。無ければ undefined。
  get(t: number): T | undefined {
    if (this.keys[this.lastHit] === t) {
      this.hits++;
      return this.values[this.lastHit];
    }
    for (let i = 0; i < TIME_CACHE_SLOTS; i++) {
      if (this.keys[i] === t) {
        this.hits++;
        this.lastHit = i;
        return this.values[i];
      }
    }
    this.misses++;
    return undefined;
  }

  // t をキーに value を最古のスロットへ書き、その value をそのまま返す。
  put(t: number, value: T): T {
    this.keys[this.next] = t;
    this.values[this.next] = value;
    this.next = (this.next + 1) % TIME_CACHE_SLOTS;
    return value;
  }
}
