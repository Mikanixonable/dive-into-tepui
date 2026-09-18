import { collisionDamageFraction } from './contact-damage';
import type {
  ArmorPart, CockpitPart, Part, PartType, RadiatorPart, SolarPanelPart, WeaponPart,
} from './parts';
import { PartInventory } from './part-inventory';

// 部品式機体が共有する、部品一覧・部品HP・部品由来の性能をまとめるモデル。
// 機体の寿命や敵AIは持たず、Shipと部品式の敵から同じように利用する。
export class PartDamageModel {
  private readonly inventory: PartInventory;
  // 以下は部品一覧から組むキャッシュ(性能と致死判定で使う参照、装甲値)。
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

  public applyCollisionDamage(closingSpeed: number, totalHp: number, part?: Part): boolean {
    const fraction = collisionDamageFraction(closingSpeed);
    if (fraction <= 0) return false;
    this.applyDamageToParts(totalHp * fraction, part);
    return true;
  }

  public applyDamageToParts(amount: number, part?: Part): void {
    if (this.parts.length === 0) return;

    let reduction = 0;
    let hasArmor = false;
    for (const armor of this.armorPartRefs) {
      if (armor.hp <= 0) continue;
      if (!hasArmor || armor.damageReduction > reduction) reduction = armor.damageReduction;
      hasArmor = true;
    }
    const effectiveDamage = amount * (1 - reduction);
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
    if (target) target.hp = Math.max(0, target.hp - effectiveDamage);
  }

  public selfRepair(amount: number): void {
    const targets = this.parts.filter(
      part => part.hp > 0 && part.hp < part.maxHp && !PartDamageModel.SELF_REPAIR_EXCLUDED.includes(part.type),
    );
    if (targets.length === 0) return;
    const share = amount / targets.length;
    for (const part of targets) part.hp = Math.min(part.maxHp, part.hp + share);
  }

  // 船体かコックピットを失った時点で、他の部品が無事でも機体を全損とする。
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
  public consumeFuel(amount: number): number { return this.inventory.consumeFuel(amount); }
  public refuelFuel(amount: number): number { return this.inventory.refuelFuel(amount); }

  public get radiatorParts(): readonly (RadiatorPart | undefined)[] { return this.radiatorPartRefs; }
  public get solarParts(): readonly (SolarPanelPart | undefined)[] { return this.solarPanelPartRefs; }
  public get totalCoolingRate(): number {
    return this.radiatorPartRefs.reduce((total, part) => total + (part && part.hp > 0 ? part.coolingRate : 0), 0);
  }
  public get totalPowerGeneration(): number {
    return this.solarPanelPartRefs.reduce((total, part) => total + (part && part.hp > 0 ? part.powerGeneration : 0), 0);
  }
  public get weaponDamage(): number {
    let damage = 0;
    for (const part of this.weaponPartRefs) if (part.hp > 0) damage = Math.max(damage, part.damage);
    return damage;
  }
  public get totalFireRate(): number {
    return this.weaponPartRefs.reduce((total, part) => total + (part.hp > 0 ? part.fireRate : 0), 0);
  }
  public get averageMuzzleVelocity(): number {
    const healthy = this.weaponPartRefs.filter(part => part.hp > 0);
    return healthy.length === 0
      ? 0
      : healthy.reduce((total, part) => total + part.muzzleVelocity, 0) / healthy.length;
  }

  private static readonly SELF_REPAIR_EXCLUDED: readonly PartType[] = ['radiator', 'solar_panel'];
}
