// 時刻 t をキーにした固定長リングと、その照合の累計。キーが厳密に一致したときだけ保持値を
// 返し、一致しなければ呼び出し側が計算し直す — 同じ t には常に同じ参照が返り、どの順に
// 呼んでも返る値は変わらない(呼び出し順に依存する隠れた制約を作らない)。

// 時刻キャッシュの保持段数。1フレームには t と t + dt/2 の交互参照、対象ごとの先端時刻、
// 近点・遠点・ノードなどの単発時刻が流入するので、主要経路の段がそれらに押し出されない
// 段数を持たせる。照合はこの段数ぶんの数値比較で、ミス1回の再計算に比べれば無視できる。
const TIME_CACHE_SLOTS = 32;

// 時刻キャッシュのヒット/ミスの累計。
export interface TimeCacheStats {
  readonly hits: number;
  readonly misses: number;
}

// 時刻キャッシュを1つも持たない層が返す空の累計。
export const NO_TIME_CACHE: TimeCacheStats = { hits: 0, misses: 0 };

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
  // 直近に当たった段。積分の内側は同じ時刻を連続で引くので、走査の前にここだけを見る。
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

  // t をキーに value を最古の段へ書き、その value をそのまま返す。
  put(t: number, value: T): T {
    this.keys[this.next] = t;
    this.values[this.next] = value;
    this.next = (this.next + 1) % TIME_CACHE_SLOTS;
    return value;
  }
}
