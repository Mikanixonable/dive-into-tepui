// エンティティ id の採番。`${prefix}${連番}` で発番し、復元 id を渡された場合はそれを
// そのまま採用しつつ、以後の新規発番と衝突しないようカウンタをその番号の次まで進める。
export class EntityIdAllocator {
  private counter = 0;

  constructor(private readonly prefix: string) {}

  // restoredId を渡せばそれを採用し、省略時は新規に発番する。
  next(restoredId?: string): string {
    if (restoredId !== undefined) {
      this.reserve(restoredId);
      return restoredId;
    }
    return `${this.prefix}${this.counter++}`;
  }

  // id がこのカウンタの採番済み連番を追い越していれば、次の発番と衝突しないよう
  // カウンタをその次まで進める。
  private reserve(id: string): void {
    if (!id.startsWith(this.prefix)) return;
    const n = Number(id.slice(this.prefix.length));
    if (Number.isFinite(n) && n >= this.counter) this.counter = n + 1;
  }
}
