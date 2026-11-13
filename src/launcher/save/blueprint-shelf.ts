// アクティブなセーブデータの設計図の棚。ランへ読み取り専用の面として渡し、
// 設計図の記録(改名・削除)を受けてセーブデータへ書き戻す。
import type { SaveSlots } from './save-slots';
import type { ShipBlueprint, ShipBlueprintShelf } from '../../game/ship/ship-blueprint';

export class BlueprintShelf implements ShipBlueprintShelf {
  private list: ShipBlueprint[] = [];

  // アクティブなセーブデータの一覧で始める。
  public constructor(private readonly slots: SaveSlots) {
    this.reload();
  }

  // アクティブなセーブデータの一覧を読み直す。セーブデータが切り替わったあとや、
  // 棚を通さない書き換えのあとに呼ぶ。
  public reload(): void {
    const slotId = this.slots.activeSlotId;
    this.list = slotId === null ? [] : [...this.slots.blueprints(slotId)];
  }

  // 設計図の一覧。新しく記録したものから並ぶ。
  public get blueprints(): readonly ShipBlueprint[] {
    return this.list;
  }

  // 設計図を一覧の先頭へ足して記録する。同名または同じ識別子の設計図が既にある、
  // または書き込めなければ一覧を変えず false。
  public add(blueprint: ShipBlueprint): boolean {
    if (this.list.some((b) => b.name === blueprint.name || b.id === blueprint.id)) return false;
    return this.record([blueprint, ...this.list]);
  }

  // id の設計図の名前を変えて記録する。無い id では false。
  public rename(id: string, name: string): boolean {
    if (!this.list.some((b) => b.id === id)) return false;
    return this.record(this.list.map((b) => (b.id === id ? { ...b, name } : b)));
  }

  // id の設計図を一覧から外して記録する。無い id では false。
  public delete(id: string): boolean {
    if (!this.list.some((b) => b.id === id)) return false;
    return this.record(this.list.filter((b) => b.id !== id));
  }

  // 一覧を next へ置き換えて記録する。記録先が無い、または書き込めなければ一覧も変えず false。
  private record(next: ShipBlueprint[]): boolean {
    const slotId = this.slots.activeSlotId;
    if (slotId === null) return false;
    if (!this.slots.writeBlueprints(slotId, next)) return false;
    this.list = next;
    return true;
  }
}
