// 受け付けた命令が適用されるまで、その成否を操作の応答として保持する。
export type CommandCompletionState =
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
