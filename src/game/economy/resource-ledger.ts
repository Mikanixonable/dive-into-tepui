// 在庫の帳簿。資源 id ごとの質量[kg]を保持し、増減と参照を提供する。
import { ResourceId } from './resource';

export class ResourceLedger {
  private readonly massById = new Map<ResourceId, number>();

  // 在庫に載っている資源 id を、載った順に返す。残量が 0 になった資源は含まれない。
  public get storedIds(): readonly ResourceId[] {
    return [...this.massById.keys()];
  }

  // 在庫量[kg]。一度も入れていない資源は 0。
  public amountOf(id: ResourceId): number {
    return this.massById.get(id) ?? 0;
  }

  // 在庫を増やす。mass は 0 以上の有限値でなければならず、それ以外は例外になる。
  public add(id: ResourceId, mass: number): void {
    if (!Number.isFinite(mass) || mass < 0) throw new Error(`ResourceLedger.add: 不正な質量: ${id} ${mass}`);
    if (mass === 0) return;
    this.massById.set(id, this.amountOf(id) + mass);
  }

  // 在庫から取り出す。足りなければ何も減らさず false を返す。
  // mass は 0 以上の有限値でなければならず、それ以外は例外になる。
  public take(id: ResourceId, mass: number): boolean {
    if (!Number.isFinite(mass) || mass < 0) throw new Error(`ResourceLedger.take: 不正な質量: ${id} ${mass}`);
    const stored = this.amountOf(id);
    if (stored < mass) return false;
    const rest = stored - mass;
    if (rest === 0) this.massById.delete(id);
    else this.massById.set(id, rest);
    return true;
  }

  // 全資源の在庫を空にする。
  public clear(): void {
    this.massById.clear();
  }
}
