// 対象1つにつき高々1枚のプロパティウィンドウ台帳。既に開いていれば位置へ動かして
// 最前面に出し、閉じた窓は台帳から外す。選択対象・搭載部品・軌道線の3系統で共有する。
import type { PropertyWindow } from './property-window';

export class WindowLedger<A extends string, E extends { readonly win: PropertyWindow<A> }> {
  private readonly entries = new Map<string, E>();

  // key の窓を開く。既に開いていれば (clientX, clientY) へ動かして最前面に出すだけにする。
  // build は新しく開くときの窓と台帳項を組む(組む中で onSelect などを付けてよい)。
  public open(key: string, clientX: number, clientY: number, build: () => E): void {
    const existing = this.entries.get(key);
    if (existing !== undefined) {
      existing.win.moveTo(clientX, clientY);
      existing.win.bringToFront();
      return;
    }
    const entry = build();
    this.entries.set(key, entry);
    entry.win.onClose = () => { this.entries.delete(key); };
  }

  public get(key: string): E | undefined { return this.entries.get(key); }
  public values(): IterableIterator<E> { return this.entries.values(); }
  public entryList(): IterableIterator<[string, E]> { return this.entries.entries(); }

  // key の窓を閉じる。開いていなければ何もしない。
  public close(key: string): void {
    this.entries.get(key)?.win.close();
  }

  // 開いているウィンドウをすべて畳む。
  public closeAll(): void {
    for (const entry of [...this.entries.values()]) entry.win.close();
  }
}
