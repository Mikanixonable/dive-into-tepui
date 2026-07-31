// リングバッファによる両端キュー
export class Deque<T> {
    private buffer: (T | undefined)[];
    private start = 0;
    private size_ = 0;

    // 初期容量(2の冪に切り上げ)でバッファを確保する。
    constructor(capacity = 8) {
        capacity = Math.max(2, 1 << Math.ceil(Math.log2(capacity)));
        this.buffer = new Array(capacity);
    }

    // 現在の要素数
    get size() {
        return this.size_;
    }

    // 現在1つ以上の要素があるか
    get empty() {
        return this.size_ === 0;
    }

    // 現在のバッファの長さ(要素数ではなく確保済みの容量)
    private get capacity() {
        return this.buffer.length;
    }

    // 末尾要素の次の論理インデックス
    private get end() {
        return this.start + this.size_;
    }

    // バッファ範囲内にmodで正規化
    private index(i: number) {
        return i & (this.buffer.length - 1);
    }

    // 必要に応じた再確保で1つ以上の空きがあることを保証する
    private ensureCapacity() {
        // オーバーフロー予防のためstartを正規化
        this.start = this.index(this.start);
        if (this.size_ < this.capacity)
            return;

        const next = new Array<T | undefined>(this.capacity * 2);

        for (let i = 0; i < this.size_; i++)
            next[i] = this.buffer[this.index(this.start + i)];

        this.buffer = next;
        this.start = 0;
    }

    // 左端を0とする論理インデックス i の要素を返す。範囲外なら例外。
    at(i: number): T {
        if (i < 0 || i >= this.size_)
            throw new RangeError();

        return this.buffer[this.index(this.start + i)]!;
    }

    // 左端の要素を返す。空なら例外。
    peekLeft(): T {
        return this.at(0);
    }

    // 右端の要素を返す。空なら例外。
    peekRight(): T {
        return this.at(this.size_ - 1);
    }

    // 左端に要素を追加する。
    pushLeft(value: T) {
        this.ensureCapacity();

        this.start--;
        this.buffer[this.index(this.start)] = value;
        this.size_++;
    }

    // 右端に要素を追加する。
    pushRight(value: T) {
        this.ensureCapacity();

        this.buffer[this.index(this.end)] = value;
        this.size_++;
    }

    // 左端の要素を取り除いて返す。空なら例外。
    popLeft(): T {
        if (this.empty)
            throw new RangeError();

        const idx = this.index(this.start);
        const value = this.buffer[idx]!;

        this.buffer[idx] = undefined;

        this.start++;
        this.size_--;

        return value;
    }

    // 右端の要素を取り除いて返す。空なら例外。
    popRight(): T {
        if (this.empty)
            throw new RangeError();

        const idx = this.index(this.end - 1);
        const value = this.buffer[idx]!;

        this.buffer[idx] = undefined;

        this.size_--;

        return value;
    }

    // 左からn要素まとめて削除　clear=falseのときO(1)　clear=trueのときO(n)
    deleteLeftN(n: number, clear = false) {
        if (n < 0 || n > this.size_)
            throw new RangeError();

        if (clear)
            for (let i = 0; i < n; i++)
                this.buffer[this.index(this.start + i)] = undefined;

        this.start += n;
        this.size_ -= n;
    }

    // 右からn要素まとめて削除　clear=falseのときO(1)　clear=trueのときO(n)
    deleteRightN(n: number, clear = false) {
        if (n < 0 || n > this.size_)
            throw new RangeError();

        if (clear)
            for (let i = 0; i < n; i++)
                this.buffer[this.index(this.end - 1 - i)] = undefined;

        this.size_ -= n;
    }

    // 要素を空にする。clearMemory=trueのときO(n)でメモリを解放する。clearMemory=falseのときO(1)
    clear(clearMemory = false) {
        if (clearMemory)
            for (let i = 0; i < this.size_; i++)
                this.buffer[this.index(this.start + i)] = undefined;

        this.start = 0;
        this.size_ = 0;
    }
}