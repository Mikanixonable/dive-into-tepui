// OrbitState の時系列を Deque で保守するキュー。先頭(peekLeft)が最新、末尾(peekRight)が
// 最古になるよう常に降順で保つ。push は「最新のサンプル」を積む操作で、時刻が逆行/重複した
// push は先頭側の同時刻以降(その push によって計算し直された区間)を破棄してから積み直す)
import { hermiteInterpolate, OrbitState } from './orbital';
import { Deque } from './deque';

export class StateQueue {
  private readonly deque: Deque<OrbitState>;

  constructor(capacity = 8) {
    this.deque = new Deque<OrbitState>(capacity);
  }

  get size(): number { return this.deque.size; }
  get empty(): boolean { return this.deque.empty; }

  // 最新サンプル(補間しない生の値)。空なら null。
  get newest(): OrbitState | null { return this.deque.empty ? null : this.deque.peekLeft(); }

  // t 未満に落ちる最初のインデックスを二分探索で返す([0, size])。先頭から見て
  // 「t 以上のもの」がちょうどこの件数だけ並んでいる、という契約だけで push の
  // 重複区間削除・cleanup の寿命境界・at の補間区間探索のすべてを賄う。
  private bisect(t: number): number {
    let lo = 0;
    let hi = this.deque.size;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.deque.at(mid).t >= t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  push(state: OrbitState): void {
    if (this.deque.empty || state.t > this.deque.peekLeft().t) {
      this.deque.pushLeft(state);
      return;
    }
    this.deque.deleteLeftN(this.bisect(state.t));
    this.deque.pushLeft(state);
  }

  // 最新サンプルから maxAge 秒より古いものを、minCount 件を下回らない範囲で削除する。
  cleanup(maxAge: number, minCount: number): void {
    if (this.deque.empty) return;
    const cutoff = this.deque.peekLeft().t - maxAge;
    const idx = this.bisect(cutoff);
    this.deque.deleteRightN(Math.max(0, this.deque.size - Math.max(idx, minCount)));
  }

  // 直近 n 件までに切り詰める(古い順から捨てる)。
  capCount(n: number): void {
    if (this.deque.size > n) this.deque.deleteRightN(this.deque.size - n);
  }

  // 時刻 t のエルミート補間済み OrbitState。保持範囲(最古 〜 最新)の外は null。
  at(t: number): OrbitState | null {
    if (this.deque.empty) return null;
    const newest = this.deque.peekLeft();
    const oldest = this.deque.peekRight();
    if (t > newest.t || t < oldest.t) return null;

    const idx = this.bisect(t);
    if (idx >= this.deque.size) return oldest; // t === oldest.t

    return hermiteInterpolate(this.deque.at(idx - 1), this.deque.at(idx), t);
  }
}
