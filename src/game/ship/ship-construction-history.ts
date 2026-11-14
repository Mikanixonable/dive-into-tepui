// 建造セッションの取り消し履歴。「操作の名前 + 操作直後の船体の写し」の列と現在位置を持つ
// 純粋な状態で、モデルは書かない — 戻す先の写しを返すだけで、適用は呼び手が命令として行う。
import type { SerializedShipAssembly } from './ship-assembly-serialization';

// 履歴1件。assembly は操作直後(先頭は開始時)の船体の直列化。
interface ConstructionHistoryEntry {
  readonly name: string;
  readonly assembly: SerializedShipAssembly;
}

export class ConstructionHistory {
  // 履歴の保持上限。超えたら古い操作から捨てる。先頭の開始時の写しだけは捨てない。
  public static readonly LIMIT = 100;

  private readonly entries: ConstructionHistoryEntry[] = [];
  private index = 0;

  // 開始時の写しを先頭に持って始める。
  public constructor(start: SerializedShipAssembly) {
    this.entries.push({ name: '建造を開始', assembly: start });
  }

  public get entriesView(): readonly ConstructionHistoryEntry[] { return this.entries; }
  public get position(): number { return this.index; }
  public get canUndo(): boolean { return this.index > 0; }
  public get canRedo(): boolean { return this.index < this.entries.length - 1; }

  public get names(): readonly string[] { return this.entries.map(entry => entry.name); }

  // 成功した操作を現在位置の次へ積む。取り消し済みの末尾(やり直し分)は捨てる。
  public record(name: string, assembly: SerializedShipAssembly): void {
    this.entries.length = this.index + 1;
    this.entries.push({ name, assembly });
    this.index = this.entries.length - 1;
    while (this.entries.length > ConstructionHistory.LIMIT) {
      this.entries.splice(1, 1);
      this.index -= 1;
    }
  }

  // index の時点の写しを返す。取り消し・やり直し・任意位置・全取り消し(0)の戻す先。
  // 位置は動かさない — 適用の成功を見てから呼び手が moveTo で確定する。
  public target(index: number): SerializedShipAssembly | null {
    return this.entries[index]?.assembly ?? null;
  }

  // 戻す先への適用が成功したあと、現在位置を確定する。
  public moveTo(index: number): void {
    if (index < 0 || index >= this.entries.length) return;
    this.index = index;
  }
}
