import type { AnyPart, Part, PartType, SerializedPart } from './parts';

// 部品の欄を書ける形。積んでいる部品の HP と燃料を、このモジュールが書き換えるのに使う。
type Writable<T> = T extends unknown ? { -readonly [K in keyof T]: T[K] } : never;
type WritablePart = Writable<AnyPart>;

// 船体へ搭載されている部品の正本。部品の所属判定と、種別ごとの集計・HP と燃料の出し入れを担う。
export class PartInventory {
  private readonly items: readonly WritablePart[];

  // parts の写しを積んだ構成で組む。以後、部品として答えるのは写しのほう。
  public constructor(parts: readonly Part[]) {
    this.items = parts.map((part) => ({ ...part }) as WritablePart);
  }

  public get parts(): readonly AnyPart[] { return this.items; }

  public has(part: Part): boolean { return this.items.some((item) => item === part); }

  // 積んでいる部品 part の HP を amount だけ減らす。0 で止まる。積んでいない部品なら何もしない。
  public damage(part: Part, amount: number): void {
    const item = this.writable(part);
    if (item !== null) item.hp = Math.max(0, item.hp - amount);
  }

  // 積んでいる部品 part の HP を amount だけ戻す。最大 HP で止まる。積んでいない部品なら何もしない。
  public repair(part: Part, amount: number): void {
    const item = this.writable(part);
    if (item !== null) item.hp = Math.min(item.maxHp, item.hp + amount);
  }

  // 部品の一覧の直列化。
  public serialize(): SerializedPart[] {
    return this.items.map((part) => ({ ...part }));
  }

  // part が積んでいる部品なら、その書ける形。
  private writable(part: Part): WritablePart | null {
    return this.items.find((item) => item === part) ?? null;
  }

  // 種別 type の部品の書ける形。
  private writableOfType<T extends PartType>(type: T): Extract<WritablePart, { type: T }>[] {
    return this.items.filter(
      (part): part is Extract<WritablePart, { type: T }> => part.type === type,
    );
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

  // 健全なタンクから amount [kg] を順に抜き、要求に対して賄えた割合 [0, 1] を返す。
  public consumeFuel(amount: number): number {
    if (amount <= 0) return 1;
    // 並び順に、空になるまで抜いてから次のタンクへ移る
    let remaining = amount;
    let consumed = 0;
    for (const tank of this.writableOfType('rcs_tank')) {
      if (tank.hp <= 0) continue;
      const fromTank = Math.min(tank.fuel, remaining);
      tank.fuel -= fromTank;
      remaining -= fromTank;
      consumed += fromTank;
      if (remaining <= 0) break;
    }
    return consumed / amount;
  }

  // 健全なタンクへ amount [kg] を順に満たし、実際に入った量 [kg] を返す。
  public refuelFuel(amount: number): number {
    if (amount <= 0) return 0;
    // 並び順に、満タンになるまで入れてから次のタンクへ移る
    let remaining = amount;
    let added = 0;
    for (const tank of this.writableOfType('rcs_tank')) {
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
