// スコアが最大の要素から取り出す二分ヒープ。スコアは float、要素は int に固定してあり型引数を
// 取らない — 要素を任意型にすると保持側が型付き配列でなくなり、容量を生成時に一度だけ確保する
// 利点が失われる。容量を超える push と空の pop はエラーにする。
export class MaxHeap {
  private readonly scores: Float64Array;
  private readonly values: Int32Array;
  private count = 0;

  // capacity は同時に保持できる要素数の上限。
  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 0) {
      throw new RangeError(`MaxHeap: capacity must be a non-negative integer, got ${capacity}`);
    }
    this.scores = new Float64Array(capacity);
    this.values = new Int32Array(capacity);
  }

  get size(): number {
    return this.count;
  }

  get capacity(): number {
    return this.scores.length;
  }

  // 最大スコア。空のときは -Infinity を返すので、「スコアが閾値を超える要素が残っているか」は
  // 空かどうかを別に調べずに書ける。
  get topScore(): number {
    return this.count > 0 ? this.scores[0]! : -Infinity;
  }

  // 要素をスコア付きで積む。容量を超えるとエラー。
  push(score: number, value: number): void {
    if (this.count >= this.scores.length) {
      throw new RangeError(`MaxHeap: capacity ${this.scores.length} exceeded`);
    }
    let i = this.count++;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.scores[parent]! >= score) break;
      this.scores[i] = this.scores[parent]!;
      this.values[i] = this.values[parent]!;
      i = parent;
    }
    this.scores[i] = score;
    this.values[i] = value;
  }

  // スコアが最大の要素を取り出す。同スコアの要素どうしの順序は決めていない。空ならエラー。
  pop(): number {
    if (this.count === 0) throw new RangeError('MaxHeap: pop from an empty heap');
    const top = this.values[0]!;
    const n = --this.count;
    const score = this.scores[n]!, value = this.values[n]!;
    let i = 0;
    for (;;) {
      const left = i * 2 + 1;
      if (left >= n) break;
      const right = left + 1;
      const child = right < n && this.scores[right]! > this.scores[left]! ? right : left;
      if (this.scores[child]! <= score) break;
      this.scores[i] = this.scores[child]!;
      this.values[i] = this.values[child]!;
      i = child;
    }
    if (n > 0) {
      this.scores[i] = score;
      this.values[i] = value;
    }
    return top;
  }

  clear(): void {
    this.count = 0;
  }
}
