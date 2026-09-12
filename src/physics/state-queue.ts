// KinematicState の時系列を保持し、保持範囲内の任意時刻をエルミート補間で引けるキュー。
// push は最新のサンプルを積む操作で、時刻が逆行/重複した push はその時刻以降
// (その push によって計算し直された区間)を破棄してから積み直す。
import { hermiteInterpolate, KinematicState } from './kinematic-state';
import { Deque } from '../math/deque';

export class StateQueue {
  // 先頭(添字 0)が最新、末尾が最古の降順。
  private readonly deque: Deque<KinematicState>;

  // capacity 件分の内部バッファを確保して空のキューを作る。
  public constructor(capacity = 8) {
    this.deque = new Deque<KinematicState>(capacity);
  }

  public get size(): number { return this.deque.size; }
  public get empty(): boolean { return this.deque.empty; }

  // 最新サンプル(補間しない生の値)。空なら null。
  public get newest(): KinematicState | null { return this.deque.empty ? null : this.deque.peekLeft(); }

  // 最も古いサンプル(補間しない生の値)。空なら null。
  public get oldest(): KinematicState | null { return this.deque.empty ? null : this.deque.peekRight(); }

  // 最も新しい2サンプルの時刻差 [s]。2件未満なら 0。
  public get newestGap(): number {
    if (this.deque.size < 2) return 0;
    return this.deque.at(0).t - this.deque.at(1).t;
  }

  // 最も古い2サンプルの時刻差 [s]。2件未満なら 0。列の古い端での間引きの粗さを表し、
  // その端を挟む at() の補間誤差を見積もる基準になる。
  public get oldestGap(): number {
    if (this.deque.size < 2) return 0;
    const oldest = this.deque.at(this.deque.size - 1);
    const next = this.deque.at(this.deque.size - 2);
    return next.t - oldest.t;
  }

  // 時刻が t 未満になる最初の添字([0, size])。先頭からちょうどこの件数だけ、時刻が t 以上の
  // サンプルが並ぶ。
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

  // 最新サンプルとして1件積む。時刻が既存の最新以下なら、その時刻以降を破棄してから積み直す。
  public push(state: KinematicState): void {
    if (this.deque.empty || state.t > this.deque.peekLeft().t) {
      this.deque.pushLeft(state);
      return;
    }
    this.deque.deleteLeftN(this.bisect(state.t));
    this.deque.pushLeft(state);
  }

  // 呼び出し後も at(newest.t - maxAge) が参照できること、かつ minCount 件以上が残っている
  // ことを保証しながら、それ以外の古いサンプルを削除する。
  public cleanup(maxAge: number, minCount: number): void {
    if (this.deque.empty) return;
    if (maxAge === 0) {
      this.deque.deleteRightN(Math.max(0, this.deque.size - minCount));
      return;
    }
    const cutoff = this.deque.peekLeft().t - maxAge;
    const idx = this.bisect(cutoff);
    const keep = Math.min(this.deque.size, idx + 1);
    this.deque.deleteRightN(Math.max(0, this.deque.size - Math.max(keep, minCount)));
  }

  // 最新のサンプル1件だけを捨てる。空なら何もしない。
  public discardNewest(): void {
    if (!this.deque.empty) this.deque.deleteLeftN(1);
  }

  // 保持しているサンプルを古い順に並べた新しい配列。
  public toArrayOldestFirst(): KinematicState[] {
    const out: KinematicState[] = new Array(this.deque.size);
    for (let i = 0; i < this.deque.size; i++) out[i] = this.deque.at(this.deque.size - 1 - i);
    return out;
  }

  // 時刻 t のエルミート補間済み KinematicState。保持範囲(最古 〜 最新)の外は null。
  public at(t: number): KinematicState | null {
    if (this.deque.empty) return null;
    const newest = this.deque.peekLeft();
    const oldest = this.deque.peekRight();
    if (t > newest.t || t < oldest.t) return null;

    const idx = this.bisect(t);
    if (idx >= this.deque.size) return oldest; // t === oldest.t

    // deque.at(idx - 1) は時刻が t 以上で最も古いサンプル。
    const newer = this.deque.at(idx - 1);
    if (newer.t === t) return newer;
    return hermiteInterpolate(newer, this.deque.at(idx), t);
  }
}
