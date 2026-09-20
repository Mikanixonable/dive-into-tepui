import type { AnyPart, Part, PartType, ShipPartCollection } from './parts';

// 敵船部品を保持・管理するコレクション。replace はロードアウト復元用の浅い配列コピーを提供し、
// 分割時の状態所有権移管は ShipAssembly が担当する。
export class PartInventory implements ShipPartCollection {
  private items: AnyPart[] = [];

  public constructor(parts: readonly Part[] = []) { this.replace(parts); }

  public replace(parts: readonly Part[]): void { this.items = [...parts] as AnyPart[]; }

  public get parts(): readonly AnyPart[] { return this.items; }

  public has(part: Part): boolean { return this.items.includes(part as AnyPart); }

  // 積んでいる部品 part の HP を amount だけ減らす。0 で止まる。積んでいない部品なら何もしない。
  public damage(part: Part, amount: number): void {
    const item = this.items.find((candidate) => candidate === part);
    if (item !== undefined) item.hp = Math.max(0, item.hp - amount);
  }

  // 積んでいる部品 part の HP を amount だけ戻す。最大 HP で止まる。積んでいない部品なら何もしない。
  public repair(part: Part, amount: number): void {
    const item = this.items.find((candidate) => candidate === part);
    if (item !== undefined) item.hp = Math.min(item.maxHp, item.hp + amount);
  }

  // 部品の一覧の直列化。
  public serialize(): AnyPart[] {
    return this.items.map((part) => ({ ...part }));
  }

  // 種別 type の部品。
  public ofType<T extends PartType>(type: T): readonly Extract<AnyPart, { type: T }>[] {
    return this.items.filter(
      (part): part is Extract<AnyPart, { type: T }> => part.type === type,
    );
  }

  // 種別 type の健全な部品について、valueOf の値を合計する。
  public healthySum<T extends PartType>(type: T, valueOf: (part: Extract<AnyPart, { type: T }>) => number): number {
    let total = 0;
    for (const part of this.ofType(type)) if (part.hp > 0) total += valueOf(part);
    return total;
  }

  // 健全なタンクの燃料の合計 [kg]。
  public totalFuel(): number {
    let total = 0;
    for (const tank of this.ofType('rcs_tank')) if (tank.hp > 0) total += tank.fuel;
    return total;
  }

  // 健全なタンクの容量の合計 [kg]。
  public totalMaxFuel(): number {
    let total = 0;
    for (const tank of this.ofType('rcs_tank')) if (tank.hp > 0) total += tank.maxFuel;
    return total;
  }

  // 健全なタンクから amount [kg] を、残量の範囲で順に抜く。
  public consumeFuel(amount: number): number {
    if (amount <= 0) return 1;
    // 並び順に、空になるまで抜いてから次のタンクへ移る
    let remaining = amount;
    let consumed = 0;
    for (const tank of this.ofType('rcs_tank')) {
      if (remaining <= 0) break;
      if (tank.hp <= 0) continue;
      const fromTank = Math.min(tank.fuel, remaining);
      tank.fuel -= fromTank;
      remaining -= fromTank;
      consumed += fromTank;
    }
    return consumed / amount;
  }

  // 健全なタンクへ amount [kg] を、容量の範囲で順に満たす。
  public refuelFuel(amount: number): number {
    if (amount <= 0) return 0;
    // 並び順に、満タンになるまで入れてから次のタンクへ移る
    let remaining = amount;
    let added = 0;
    for (const tank of this.ofType('rcs_tank')) {
      if (remaining <= 0) break;
      if (tank.hp <= 0) continue;
      const toTank = Math.min(Math.max(0, tank.maxFuel - tank.fuel), remaining);
      tank.fuel += toTank;
      remaining -= toTank;
      added += toTank;
    }
    return added;
  }
}
