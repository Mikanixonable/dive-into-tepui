import type { AnyPart, Part, PartType } from './parts';

// 船体へ搭載されている部品の正本。外部へ可変配列を渡さず、所属判定と種別ごとの集計を公開する。
export class PartInventory {
  private readonly items: readonly AnyPart[];

  // parts を積んだ構成で組む。
  public constructor(parts: readonly Part[]) {
    this.items = [...parts] as AnyPart[];
  }

  public get parts(): readonly AnyPart[] { return this.items; }

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
}
