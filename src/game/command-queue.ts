// モデル層の外から届いた書き換えを溜める列。DOM のイベントやアプリの組み立てのように、フレームの
// どこから来たか分からない書き込みを、進行の位相の先頭の1か所へ集めるためにある(R3)。
// 積むのは、所有者が公開する命令を呼ぶだけの関数。
export class CommandQueue {
  private pending: (() => void)[] = [];

  // 命令を1件受け付ける。適用は次の applyAll で行う。
  public submit(apply: () => void): void {
    this.pending.push(apply);
  }

  // 積まれた命令を、受け付けた順に1度だけ適用する。適用の最中に積まれた命令は次の applyAll へ回る。
  public applyAll(): void {
    const applying = this.pending;
    this.pending = [];
    for (const apply of applying) apply();
  }
}
