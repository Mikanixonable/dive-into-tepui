// 軌道標識の台帳: 1ランが持つ標識の正本。id の採番・追加・削除・列挙・改名と、
// 直列化/復元を担う。航行指令が標識を id で参照するため、視点ではなく進行に置く(R4)。
import { EntityIdAllocator } from '../dynamic/dynamic-entity/entity-id';
import { OrbitSlot, type OrbitSlotOrbit, type SerializedOrbitSlot } from './orbit-slot';

// 台帳の直列化した形。nameSeq は既定名「軌道標識 N」の次に使う番号。
export interface SerializedOrbitSlotRegistry {
  readonly slots: readonly SerializedOrbitSlot[];
  readonly idAllocator: number;
  readonly nameSeq: number;
}

export class OrbitSlotRegistry {
  private readonly slots: OrbitSlot[];

  private constructor(
    slots: readonly OrbitSlot[] = [],
    private readonly idAllocator = new EntityIdAllocator('orbit-slot-'),
    private nameSeq = 1,
  ) {
    this.slots = [...slots];
    // 復元した id と以後の発番が衝突しないよう、既存の id を採番器へ教える。
    for (const slot of this.slots) this.idAllocator.next(slot.id);
  }

  // 空の台帳を新規に組む。
  public static create(): OrbitSlotRegistry {
    return new OrbitSlotRegistry();
  }

  // 直列化した台帳から復元する。記録が無ければ(null)空の台帳。
  public static deserialize(serialized: SerializedOrbitSlotRegistry | null): OrbitSlotRegistry {
    if (serialized === null) return new OrbitSlotRegistry();
    return new OrbitSlotRegistry(
      serialized.slots.map((slot) => OrbitSlot.deserialize(slot)),
      new EntityIdAllocator('orbit-slot-', serialized.idAllocator),
      serialized.nameSeq,
    );
  }

  // 台帳を直列化した形へ畳む。
  public serialize(): SerializedOrbitSlotRegistry {
    return {
      slots: this.slots.map((slot) => slot.serialize()),
      idAllocator: this.idAllocator.serialize(),
      nameSeq: this.nameSeq,
    };
  }

  // 全標識を追加順に返す(読み取り専用)。
  public all(): readonly OrbitSlot[] { return this.slots; }

  // id の標識。無ければ null。
  public find(id: string): OrbitSlot | null {
    return this.slots.find((slot) => slot.id === id) ?? null;
  }

  // 参照軌道 orbit の標識を1件追加し、採番した標識を返す。name が空欄なら
  // 「軌道標識 N」の既定名を付ける。
  public add(orbit: OrbitSlotOrbit, name?: string): OrbitSlot {
    const trimmed = name?.trim() ?? '';
    const seq = this.nameSeq++;
    const slot = new OrbitSlot(this.idAllocator.next(), trimmed !== '' ? trimmed : `軌道標識 ${seq}`, orbit);
    this.slots.push(slot);
    return slot;
  }

  // id の標識を台帳から外す。外せたかを返す。
  public remove(id: string): boolean {
    const index = this.slots.findIndex((slot) => slot.id === id);
    if (index < 0) return false;
    this.slots.splice(index, 1);
    return true;
  }

  // id の標識の名前を差し替える。空欄や存在しない id では何も起きない。
  public rename(id: string, name: string): void {
    this.find(id)?.rename(name);
  }
}
