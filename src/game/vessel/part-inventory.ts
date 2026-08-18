// 機体が積んでいる搭載要素の一覧と、そこから合成される HP と性能値。
// HP も推力も冷却能力も、正本はここにある部品の側にある。
import type {
  AnyPart, ArmorPart, CockpitPart, Part, PartType,
  RadiatorPart, RcsTankPart, SolarPanelPart, ThrusterPart, WeaponPart,
} from '../game-entity/parts';

// 自然回復の対象外にする部品種別。外装パネルは機上で直せず、基地ドックの修理を要する。
const SELF_REPAIR_EXCLUDED: readonly PartType[] = ['radiator', 'solar_panel'];

export class PartInventory {
  readonly parts: AnyPart[] = [];
  hp = 0;
  maxHp = 0;

  // type 走査は性能取得のたびに行わず、換装・復元時だけ組み直す。HP と燃料は部品本体で
  // 変化するため、これらは部品参照の固定配列であり、値のキャッシュではない。
  private readonly thrusterRefs: ThrusterPart[] = [];
  private readonly rcsTankRefs: RcsTankPart[] = [];
  private readonly radiatorRefs: [RadiatorPart | undefined, RadiatorPart | undefined] = [undefined, undefined];
  private readonly solarPanelRefs: [SolarPanelPart | undefined, SolarPanelPart | undefined] = [undefined, undefined];
  private readonly weaponRefs: WeaponPart[] = [];
  private readonly armorRefs: ArmorPart[] = [];
  private hullPart: Part | undefined;
  private cockpitPart: CockpitPart | undefined;

  constructor(parts: readonly AnyPart[]) {
    this.replaceAll(parts);
  }

  // 一覧をまるごと差し替える。配列の参照は保つ(換装 UI が同じ配列を握っている)。
  replaceAll(parts: readonly AnyPart[]): void {
    this.parts.splice(0, this.parts.length, ...parts);
    this.refresh();
  }

  // 部品構成が変わったとき(換装など)に、機体の maxHp と hp を部品側から求め直す。
  refresh(): void {
    this.rebuildReferences();
    let maxHp = 0;
    for (const p of this.parts) maxHp += p.maxHp;
    this.maxHp = maxHp;
    this.updateOverallHp();
  }

  private rebuildReferences(): void {
    this.thrusterRefs.length = 0;
    this.rcsTankRefs.length = 0;
    this.weaponRefs.length = 0;
    this.armorRefs.length = 0;
    let radiatorIndex = 0;
    let solarPanelIndex = 0;
    this.radiatorRefs[0] = undefined;
    this.radiatorRefs[1] = undefined;
    this.solarPanelRefs[0] = undefined;
    this.solarPanelRefs[1] = undefined;
    this.hullPart = undefined;
    this.cockpitPart = undefined;

    for (const part of this.parts) {
      switch (part.type) {
        case 'hull': if (!this.hullPart) this.hullPart = part; break;
        case 'cockpit': if (!this.cockpitPart) this.cockpitPart = part; break;
        case 'armor': this.armorRefs.push(part); break;
        case 'thruster': this.thrusterRefs.push(part); break;
        case 'rcs_tank': this.rcsTankRefs.push(part); break;
        case 'radiator':
          if (radiatorIndex < this.radiatorRefs.length) this.radiatorRefs[radiatorIndex] = part;
          radiatorIndex++;
          break;
        case 'solar_panel':
          if (solarPanelIndex < this.solarPanelRefs.length) this.solarPanelRefs[solarPanelIndex] = part;
          solarPanelIndex++;
          break;
        case 'weapon': this.weaponRefs.push(part); break;
        default: break;
      }
    }
  }

  // 全パーツの残 HP 合計を機体の hp に反映する。船体かコックピットを失った時点で
  // 他が無事でも行動不能とみなし 0 にする。
  updateOverallHp(): void {
    if (this.parts.length === 0) return;
    const vital = (this.hullPart && this.hullPart.hp <= 0) || (this.cockpitPart && this.cockpitPart.hp <= 0);
    if (vital) {
      this.hp = 0;
      return;
    }
    let hp = 0;
    for (const p of this.parts) hp += p.hp;
    this.hp = hp;
  }

  // 部品単位の HP まで保存していない機体向けに、総 HP を total へ按分して揃える。
  setOverallHp(total: number): void {
    const ratio = this.maxHp > 0 ? Math.max(0, Math.min(1, total / this.maxHp)) : 0;
    for (const p of this.parts) p.hp = p.maxHp * ratio;
    this.updateOverallHp();
  }

  // 受けたダメージを健全なパーツ1つへ無作為に割り振る。装甲があれば最も高い軽減率で
  // 減衰させる。part を指定すると割り振り先をそのパーツに固定する(被弾位置から
  // 当たったパーツが判っている場合)。
  applyDamage(amount: number, part?: Part): void {
    if (this.parts.length === 0) {
      this.hp -= amount;
      return;
    }

    // 装甲は複数積んでも最も高い軽減率のものだけが効く。
    let reduction = 0;
    let hasArmor = false;
    for (const armor of this.armorRefs) {
      if (armor.hp <= 0) continue;
      if (!hasArmor || armor.damageReduction > reduction) reduction = armor.damageReduction;
      hasArmor = true;
    }
    const effectiveDamage = amount * (1 - reduction);

    let aliveCount = 0;
    for (const p of this.parts) if (p.hp > 0) aliveCount++;
    let target = part;
    if (!target) {
      const targetIndex = Math.floor(Math.random() * (aliveCount > 0 ? aliveCount : this.parts.length));
      if (aliveCount > 0) {
        let aliveIndex = 0;
        for (const p of this.parts) {
          if (p.hp <= 0) continue;
          if (aliveIndex++ === targetIndex) {
            target = p;
            break;
          }
        }
      } else {
        target = this.parts[targetIndex];
      }
    }

    if (target) target.hp = Math.max(0, target.hp - effectiveDamage);
    this.updateOverallHp();
  }

  // amount [HP] を自然回復できる損傷部品へ均等に配る。全損した部品は対象外で、
  // 復旧にはドックでの修理が要る。
  selfRepair(amount: number): void {
    const targets = this.parts.filter(
      (p) => p.hp > 0 && p.hp < p.maxHp && !SELF_REPAIR_EXCLUDED.includes(p.type));
    if (targets.length === 0) return;
    const share = amount / targets.length;
    for (const p of targets) p.hp = Math.min(p.maxHp, p.hp + share);
    this.updateOverallHp();
  }

  get totalTorque(): number {
    let total = 0;
    for (const p of this.thrusterRefs) if (p.hp > 0) total += p.torque;
    return total;
  }

  get totalThrust(): number {
    let total = 0;
    for (const p of this.thrusterRefs) if (p.hp > 0) total += p.thrust;
    return total;
  }

  get totalFuelConsumptionRate(): number {
    let total = 0;
    for (const p of this.thrusterRefs) if (p.hp > 0) total += p.fuelConsumptionRate;
    return total;
  }

  get totalFuel(): number {
    let total = 0;
    for (const p of this.rcsTankRefs) if (p.hp > 0) total += p.fuel;
    return total;
  }

  get totalMaxFuel(): number {
    let total = 0;
    for (const p of this.rcsTankRefs) if (p.hp > 0) total += p.maxFuel;
    return total;
  }

  // 燃料を消費し、実際に消費できた割合(0.0〜1.0)を返す。
  consumeFuel(amount: number): number {
    if (amount <= 0) return 1.0;
    let remaining = amount;
    let consumed = 0;
    for (const tank of this.rcsTankRefs) {
      if (tank.hp <= 0) continue;
      if (tank.fuel > 0) {
        const fromTank = Math.min(tank.fuel, remaining);
        tank.fuel -= fromTank;
        remaining -= fromTank;
        consumed += fromTank;
      }
      if (remaining <= 0) break;
    }
    return consumed / amount;
  }

  // タンクへ燃料を戻す。満タンを超える分は入らない。
  refuel(amount: number): void {
    let remaining = amount;
    for (const tank of this.rcsTankRefs) {
      if (remaining <= 0) break;
      const room = Math.max(0, tank.maxFuel - tank.fuel);
      const filled = Math.min(room, remaining);
      tank.fuel += filled;
      remaining -= filled;
    }
  }

  // 機体左右2枚の放熱板・太陽電池パドルに対応するパーツ。並び順が side に対応し、
  // 先頭が 'up'(左)、次が 'down'(右)。枚数が足りなければ undefined になる。
  get radiatorParts(): readonly (RadiatorPart | undefined)[] {
    return this.radiatorRefs;
  }

  get solarParts(): readonly (SolarPanelPart | undefined)[] {
    return this.solarPanelRefs;
  }

  get totalCoolingRate(): number {
    let total = 0;
    for (const p of this.radiatorRefs) if (p && p.hp > 0) total += p.coolingRate;
    return total;
  }

  get totalPowerGeneration(): number {
    let total = 0;
    for (const p of this.solarPanelRefs) if (p && p.hp > 0) total += p.powerGeneration;
    return total;
  }

  // 1発あたりのダメージ。複数積んでいる場合は最も強い武装のものを使う。
  get weaponDamage(): number {
    let damage = 0;
    let hasWeapon = false;
    for (const p of this.weaponRefs) {
      if (p.hp <= 0) continue;
      if (!hasWeapon || p.damage > damage) damage = p.damage;
      hasWeapon = true;
    }
    return damage;
  }

  get totalFireRate(): number {
    let total = 0;
    for (const p of this.weaponRefs) if (p.hp > 0) total += p.fireRate;
    return total;
  }

  // 生存武装の初速平均。武装が全損している場合は 0。
  get averageMuzzleVelocity(): number {
    let total = 0;
    let count = 0;
    for (const p of this.weaponRefs) {
      if (p.hp <= 0) continue;
      total += p.muzzleVelocity;
      count++;
    }
    return count === 0 ? 0 : total / count;
  }
}
