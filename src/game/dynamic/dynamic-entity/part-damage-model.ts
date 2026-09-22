import { collisionDamageFraction } from './contact-damage';
import type {
  ArmorPart, CockpitPart, Part, PartType, RadiatorPart, AnyPart, SolarPanelPart, WeaponPart,
} from './parts';
import { PartInventory } from './part-inventory';

// 部品式機体の被弾モデル。部品一覧・部品 HP・部品由来の性能をまとめる。
export class PartDamageModel {
  private readonly inventory: PartInventory;
  // 以下は部品一覧から組むキャッシュ(性能と致死判定で使う部品の参照と、装甲値)。
  private readonly radiatorPartRefs: [RadiatorPart | undefined, RadiatorPart | undefined] = [undefined, undefined];
  private readonly solarPanelPartRefs: [SolarPanelPart | undefined, SolarPanelPart | undefined] = [undefined, undefined];
  private readonly weaponPartRefs: WeaponPart[] = [];
  private readonly armorPartRefs: ArmorPart[] = [];
  private hullPart: Part | undefined;
  private cockpitPart: CockpitPart | undefined;
  public readonly maxHp: number;

  // parts を積んだ機体の被弾モデルを組む。
  public constructor(parts: readonly Part[]) {
    this.inventory = new PartInventory(parts);
    this.collectPartReferences();
    this.maxHp = this.parts.reduce((total, part) => total + part.maxHp, 0);
  }

  public get parts(): readonly Part[] { return this.inventory.parts; }

  public hasPart(part: Part): boolean { return this.inventory.has(part); }

  // 性能と致死判定で使う部品を、種別ごとの参照へ振り分ける。
  private collectPartReferences(): void {
    let radiatorIndex = 0;
    let solarPanelIndex = 0;
    for (const part of this.parts) {
      // 船体とコックピットは最初の1つ、放熱板と太陽電池は先頭の2枚まで
      switch (part.type) {
        case 'hull': if (!this.hullPart) this.hullPart = part; break;
        case 'cockpit': if (!this.cockpitPart) this.cockpitPart = part as CockpitPart; break;
        case 'armor': this.armorPartRefs.push(part as ArmorPart); break;
        case 'radiator':
          if (radiatorIndex < this.radiatorPartRefs.length) this.radiatorPartRefs[radiatorIndex] = part as RadiatorPart;
          radiatorIndex++;
          break;
        case 'solar_panel':
          if (solarPanelIndex < this.solarPanelPartRefs.length) this.solarPanelPartRefs[solarPanelIndex] = part as SolarPanelPart;
          solarPanelIndex++;
          break;
        case 'weapon': this.weaponPartRefs.push(part as WeaponPart); break;
      }
    }
  }

  // 接近速度 closingSpeed に応じて、totalHp のその割合のダメージを部品へ入れる。part の扱いは
  // applyDamageToParts と同じ。ダメージが出たかを返す。
  public applyCollisionDamage(closingSpeed: number, totalHp: number, part?: Part): boolean {
    const fraction = collisionDamageFraction(closingSpeed);
    if (fraction <= 0) return false;
    this.applyDamageToParts(totalHp * fraction, part);
    return true;
  }

  // 装甲の軽減を通した amount を部品へ入れる。part を指定するとその部品へ固定し、省くと健全な
  // 部品(無ければ全部品)から無作為に選ぶ。
  public applyDamageToParts(amount: number, part?: Part): void {
    if (this.parts.length === 0) return;

    // 健全な装甲のうち最も大きい軽減率を掛ける
    let reduction = 0;
    let hasArmor = false;
    for (const armor of this.armorPartRefs) {
      if (armor.hp <= 0) continue;
      if (!hasArmor || armor.damageReduction > reduction) reduction = armor.damageReduction;
      hasArmor = true;
    }
    const effectiveDamage = amount * (1 - reduction);
    // ダメージを与える対象パーツを選定する
    let aliveCount = 0;
    for (const current of this.parts) if (current.hp > 0) aliveCount++;
    let target = part;
    if (!target) {
      const targetIndex = Math.floor(Math.random() * (aliveCount > 0 ? aliveCount : this.parts.length));
      if (aliveCount > 0) {
        let aliveIndex = 0;
        for (const current of this.parts) {
          if (current.hp <= 0) continue;
          if (aliveIndex++ === targetIndex) {
            target = current;
            break;
          }
        }
      } else target = this.parts[targetIndex];
    }
    if (target) this.inventory.damage(target, effectiveDamage);
  }

  // 損傷した部品へ amount を均等に配って回復させる。放熱板と太陽電池は対象から外れる。
  public selfRepair(amount: number): void {
    const targets = this.parts.filter(
      part => part.hp > 0 && part.hp < part.maxHp && !PartDamageModel.SELF_REPAIR_EXCLUDED.includes(part.type),
    );
    if (targets.length === 0) return;
    const share = amount / targets.length;
    for (const part of targets) this.inventory.repair(part, share);
  }

  // 部品の一覧の直列化。
  public serialize(): AnyPart[] {
    return this.inventory.serialize();
  }

  // 機体全体の残 HP。船体かコックピットを失っていれば、他の部品が無事でも 0。
  public overallHp(): number {
    if (this.parts.length === 0) return 0;
    if ((this.hullPart && this.hullPart.hp <= 0) || (this.cockpitPart && this.cockpitPart.hp <= 0)) return 0;
    return this.parts.reduce((total, part) => total + part.hp, 0);
  }

  public get totalTorque(): number { return this.inventory.healthySum('thruster', part => part.torque); }
  public get totalThrust(): number { return this.inventory.healthySum('thruster', part => part.thrust); }
  public get totalFuelConsumptionRate(): number { return this.inventory.healthySum('thruster', part => part.fuelConsumptionRate); }
  public get totalFuel(): number { return this.inventory.totalFuel(); }
  public get totalMaxFuel(): number { return this.inventory.totalMaxFuel(); }
  public consumeFuel(amount: number): void { this.inventory.consumeFuel(amount); }
  public refuelFuel(amount: number): void { this.inventory.refuelFuel(amount); }

  public get radiatorParts(): readonly (RadiatorPart | undefined)[] { return this.radiatorPartRefs; }
  public get solarParts(): readonly (SolarPanelPart | undefined)[] { return this.solarPanelPartRefs; }
  // 健全な放熱板の実効放熱面積の合計 [m^2]。
  public get totalCoolingRate(): number {
    return this.radiatorPartRefs.reduce((total, part) => total + (part && part.hp > 0 ? part.coolingRate : 0), 0);
  }
  // 健全な太陽電池の発電量の合計 [W]。
  public get totalPowerGeneration(): number {
    return this.solarPanelPartRefs.reduce((total, part) => total + (part && part.hp > 0 ? part.powerGeneration : 0), 0);
  }
  // 健全な武装のうち最大の、命中1回あたりのダメージ。
  public get weaponDamage(): number {
    let damage = 0;
    for (const part of this.weaponPartRefs) if (part.hp > 0) damage = Math.max(damage, part.damage);
    return damage;
  }
  // 健全な武装の発射レートの合計 [rounds/s]。
  public get totalFireRate(): number {
    return this.weaponPartRefs.reduce((total, part) => total + (part.hp > 0 ? part.fireRate : 0), 0);
  }
  // 健全な武装の初速の平均 [m/s]。武装が残っていなければ 0。
  public get averageMuzzleVelocity(): number {
    const healthy = this.weaponPartRefs.filter(part => part.hp > 0);
    return healthy.length === 0
      ? 0
      : healthy.reduce((total, part) => total + part.muzzleVelocity, 0) / healthy.length;
  }

  private static readonly SELF_REPAIR_EXCLUDED: readonly PartType[] = ['radiator', 'solar_panel'];
}
