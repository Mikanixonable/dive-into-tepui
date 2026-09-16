import type { AnyPart, Part, PartType, ShipPartCollection } from './parts';

// 旧形式の敵船部品を所有する実装。replace はロードアウト復元用の浅い配列コピーで、
// module の split には使わない。split の状態所有権は ShipAssembly が移管する。
export class PartInventory implements ShipPartCollection {
  private items: AnyPart[] = [];

  public get parts(): readonly AnyPart[] { return this.items; }

  public replace(parts: readonly Part[]): void { this.items = [...parts] as AnyPart[]; }
  public has(part: Part): boolean { return this.items.includes(part as AnyPart); }
  public ofType<T extends PartType>(type: T): readonly Extract<AnyPart, { type: T }>[] {
    return this.items.filter(
      (part): part is Extract<AnyPart, { type: T }> => part.type === type,
    );
  }

  public healthySum<T extends PartType>(type: T, valueOf: (part: Extract<AnyPart, { type: T }>) => number): number {
    let total = 0;
    for (const part of this.ofType(type)) if (part.hp > 0) total += valueOf(part);
    return total;
  }

  public totalFuel(): number {
    let total = 0;
    for (const tank of this.ofType('rcs_tank')) if (tank.hp > 0) total += tank.fuel;
    return total;
  }

  public totalMaxFuel(): number {
    let total = 0;
    for (const tank of this.ofType('rcs_tank')) if (tank.hp > 0) total += tank.maxFuel;
    return total;
  }

  public consumeFuel(amount: number): number {
    if (amount <= 0) return 1;
    let remaining = amount;
    let consumed = 0;
    for (const tank of this.ofType('rcs_tank')) {
      if (tank.hp <= 0) continue;
      const fromTank = Math.min(tank.fuel, remaining);
      tank.fuel -= fromTank;
      remaining -= fromTank;
      consumed += fromTank;
      if (remaining <= 0) break;
    }
    return consumed / amount;
  }

  public refuelFuel(amount: number): number {
    if (amount <= 0) return 0;
    let remaining = amount;
    let added = 0;
    for (const tank of this.ofType('rcs_tank')) {
      if (tank.hp <= 0) continue;
      const toTank = Math.min(Math.max(0, tank.maxFuel - tank.fuel), remaining);
      tank.fuel += toTank;
      remaining -= toTank;
      added += toTank;
      if (remaining <= 0) break;
    }
    return added;
  }
  public serialize(): AnyPart[] { return this.items.map((part) => ({ ...part })); }
}
