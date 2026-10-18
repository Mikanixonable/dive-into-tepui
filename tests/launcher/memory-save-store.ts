// 索引と記録をメモリ上の JSON 文字列として持つ SaveStore。ブラウザの保存先と同じく、書いた値は
// 文字列を経て読み戻る。
import { parseBlueprintList } from '../../src/launcher/save/save-store';
import { BLUEPRINT_LIST_VERSION } from '../../src/launcher/save/save-store';
import type { SavedGame } from '../../src/launcher/save/save-store';
import type { SaveStore } from '../../src/launcher/save/save-store';
import type { SaveIndex } from '../../src/launcher/save/slot-data';
import type { ShipBlueprint } from '../../src/game/ship/ship-blueprint';

export class MemorySaveStore implements SaveStore {
  private index: string | null = null;
  private readonly snapshots = new Map<string, string>();
  private readonly blueprintLists = new Map<string, string>();

  // 書いた索引。まだ書いていなければ null。
  public readIndex(): SaveIndex | null {
    return this.index === null ? null : JSON.parse(this.index) as SaveIndex;
  }

  // 索引を index へ置き換える。
  public writeIndex(index: SaveIndex): void {
    this.index = JSON.stringify(index);
  }

  // id の記録。書いていない id では null。形は確かめずに読む。
  public readSnapshot(id: string): SavedGame | null {
    const raw = this.snapshots.get(id);
    return raw === undefined ? null : JSON.parse(raw) as SavedGame;
  }

  // id の記録を data へ置き換える。
  public writeSnapshot(id: string, data: SavedGame): void {
    this.writeRawSnapshot(id, data);
  }

  // id の記録を、いまの形式に限らない JSON の値 data へ置き換える。
  public writeRawSnapshot(id: string, data: unknown): void {
    this.snapshots.set(id, JSON.stringify(data));
  }

  // id の記録を消す。書いていない id では何もしない。
  public deleteSnapshot(id: string): void {
    this.snapshots.delete(id);
  }

  // いま置いてある記録の id。
  public snapshotIds(): readonly string[] {
    return [...this.snapshots.keys()];
  }

  // slotId の設計図の一覧。書いていない slotId では空。
  public readBlueprints(slotId: string): readonly ShipBlueprint[] {
    return parseBlueprintList(this.blueprintLists.get(slotId) ?? null);
  }

  // slotId の設計図の一覧を blueprints へ置き換える。
  public writeBlueprints(slotId: string, blueprints: readonly ShipBlueprint[]): void {
    this.blueprintLists.set(slotId, JSON.stringify({ version: BLUEPRINT_LIST_VERSION, blueprints }));
  }

  // slotId の設計図の一覧を、いまの形式に限らない JSON の値 data へ置き換える。
  public writeRawBlueprints(slotId: string, data: unknown): void {
    this.blueprintLists.set(slotId, JSON.stringify(data));
  }

  // slotId の設計図の一覧を消す。書いていない slotId では何もしない。
  public deleteBlueprints(slotId: string): void {
    this.blueprintLists.delete(slotId);
  }
}
