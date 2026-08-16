// KinematicState の時系列を Deque で保守するキュー。先頭(peekLeft)が最新、末尾(peekRight)が
// 最古になるよう常に降順で保つ。push は「最新のサンプル」を積む操作で、時刻が逆行/重複した
// push は先頭側の同時刻以降(その push によって計算し直された区間)を破棄してから積み直す)
import { hermiteInterpolate, KinematicState } from './kinematic-state';
import { Deque } from './deque';

export class StateQueue {
  private readonly deque: Deque<KinematicState>;

  // capacity 件分の内部バッファを確保して空のキューを作る。
  constructor(capacity = 8) {
    this.deque = new Deque<KinematicState>(capacity);
  }

  get size(): number { return this.deque.size; }
  get empty(): boolean { return this.deque.empty; }

  // 最新サンプル(補間しない生の値)。空なら null。
  get newest(): KinematicState | null { return this.deque.empty ? null : this.deque.peekLeft(); }

  // 最も古いサンプル(補間しない生の値)。空なら null。
  get oldest(): KinematicState | null { return this.deque.empty ? null : this.deque.peekRight(); }

  // 最も新しい2サンプルの時刻差 [s]。2件未満なら 0。
  get newestGap(): number {
    if (this.deque.size < 2) return 0;
    return this.deque.at(0).t - this.deque.at(1).t;
  }

  // 最も古い2サンプルの時刻差 [s]。2件未満なら 0。列の古い端での間引きの粗さを表し、
  // その端を挟む at() の補間誤差を見積もる基準になる。
  get oldestGap(): number {
    if (this.deque.size < 2) return 0;
    const oldest = this.deque.at(this.deque.size - 1);
    const next = this.deque.at(this.deque.size - 2);
    return next.t - oldest.t;
  }

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

  // 最新サンプルとして1件積む。時刻が既存の最新以下なら、その時刻以降を破棄してから積み直す。
  push(state: KinematicState): void {
    if (this.deque.empty || state.t > this.deque.peekLeft().t) {
      this.deque.pushLeft(state);
      return;
    }
    this.deque.deleteLeftN(this.bisect(state.t));
    this.deque.pushLeft(state);
  }

  // 呼び出し後も at(newest.t - maxAge) が参照できること、かつ minCount 件以上が残っている
  // ことを保証しながら、それ以外の古いサンプルを削除する。
  cleanup(maxAge: number, minCount: number): void {
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

  // 直近 n 件までに切り詰める(古い順から捨てる)。
  capCount(n: number): void {
    if (this.deque.size > n) this.deque.deleteRightN(this.deque.size - n);
  }

  // t 以上のサンプルをすべて捨てる。不連続な差し替え(DynamicTrajectory.reset)で、直前まで
  // 「これから訪れるはずだった未来」として積まれていたサンプルを無効化するために使う。
  discardFrom(t: number): void {
    this.deque.deleteLeftN(this.bisect(t));
  }

  // 最新のサンプル1件だけを捨てる。空なら何もしない。
  discardNewest(): void {
    if (!this.deque.empty) this.deque.deleteLeftN(1);
  }

  // 保持しているサンプルを古い順(= 内部の降順と逆順)の配列で返す。折れ線描画
  // (game/trajectory-line.ts の TrajectoryLine.syncGeometry)は時系列順の配列を要求するため。
  toArrayOldestFirst(): KinematicState[] {
    const out: KinematicState[] = new Array(this.deque.size);
    for (let i = 0; i < this.deque.size; i++) out[i] = this.deque.at(this.deque.size - 1 - i);
    return out;
  }

  // 時刻 t のエルミート補間済み KinematicState。保持範囲(最古 〜 最新)の外は null。
  at(t: number): KinematicState | null {
    if (this.deque.empty) return null;
    const newest = this.deque.peekLeft();
    const oldest = this.deque.peekRight();
    if (t > newest.t || t < oldest.t) return null;

    const idx = this.bisect(t);
    if (idx >= this.deque.size) return oldest; // t === oldest.t

    // bisect の契約から deque.at(idx - 1) は「t 以上で最も古い」サンプル。時刻がちょうど
    // 一致するならそれ自身が答えで、補間する必要がない。
    const newer = this.deque.at(idx - 1);
    if (newer.t === t) return newer;
    return hermiteInterpolate(newer, this.deque.at(idx), t);
  }
}
