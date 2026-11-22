// モデル層の外から届いた書き換えを溜める列。DOM のイベントやアプリの組み立てのように、フレームの
// どこから来たか分からない書き込みを、進行の位相の先頭の1か所へ集めるためにある(R3)。
// 積むのは、所有者が公開する命令を呼ぶだけの関数。

export class CommandQueue {
  private pending: (() => void)[] = [];

  // 命令を1件受け付ける。適用は次の applyAll で行う。
  public submit(apply: () => void): void {
    this.pending.push(apply);
  }

  // 命令を受け付け、適用の成否をcompletionへ記録する。失敗しても後続の命令を適用する。
  public submitWithCompletion(apply: () => void, completion: CommandCompletion): void {
    this.submit(() => {
      try {
        apply();
        completion.succeed();
      } catch (error) {
        completion.fail(error);
      }
    });
  }

  // 積まれた命令を、受け付けた順に1度だけ適用する。適用の最中に積まれた命令は次の applyAll へ回る。
  public applyAll(): void {
    const applying = this.pending;
    this.pending = [];
    for (const apply of applying) apply();
  }
}

// 受け付けた命令が適用されるまで、その成否を操作の応答として保持する。
type CommandCompletionState =
  | { readonly kind: 'pending' }
  | { readonly kind: 'succeeded' }
  | { readonly kind: 'failed'; readonly error: unknown };

export class CommandCompletion {
  private value: CommandCompletionState = { kind: 'pending' };

  public get state(): CommandCompletionState { return this.value; }

  // 命令の適用が完了したことを記録する。
  public succeed(): void { this.value = { kind: 'succeeded' }; }

  // 命令の適用で発生したエラーを記録する。
  public fail(error: unknown): void { this.value = { kind: 'failed', error }; }
}
