// 機体が積んでいる搭載要素の一覧と、そこから合成される HP と性能値。
// HP も推力も冷却能力も、正本はここにある部品の側にある。
import * as C from '../const';
import type {
  AnyPart, ArmorPart, BatteryPart, CockpitPart, EnginePart, FlywheelPart, FuelCellPart, Part, PartType,
  PropellantTankPart, RadiatorPart, RcsThrusterPart, RtgPart, SolarPanelPart, WeaponPart,
} from '../game-entity/parts';
import { extraWasteHeatOf, powerDrawOf } from '../game-entity/parts';
import type { PropellantId } from '../economy/propellant-compatibility';
import { propellantTankCapacity } from '../economy/propellant-compatibility';
import { STANDARD_GRAVITY } from '../../physics/tsiolkovsky';

// 自然回復の対象外にする部品種別。外装パネルは機上で直せず、基地ドックの修理を要する。
const SELF_REPAIR_EXCLUDED: readonly PartType[] = ['radiator', 'solar_panel'];

export class PartInventory {
  public readonly parts: AnyPart[] = [];
  public hp = 0;
  public maxHp = 0;

  // type 走査は性能取得のたびに行わず、換装・復元時だけ組み直す。HP と燃料は部品本体で
  // 変化するため、これらは部品参照の固定配列であり、値のキャッシュではない。
  private readonly engineRefs: EnginePart[] = [];
  private readonly rcsThrusterRefs: RcsThrusterPart[] = [];
  private readonly flywheelRefs: FlywheelPart[] = [];
  private readonly batteryRefs: BatteryPart[] = [];
  private readonly fuelCellRefs: FuelCellPart[] = [];
  private readonly rtgRefs: RtgPart[] = [];
  private readonly propellantTankRefs: PropellantTankPart[] = [];
  private readonly radiatorRefs: [RadiatorPart | undefined, RadiatorPart | undefined] = [undefined, undefined];
  private readonly solarPanelRefs: [SolarPanelPart | undefined, SolarPanelPart | undefined] = [undefined, undefined];
  private readonly weaponRefs: WeaponPart[] = [];
  private readonly armorRefs: ArmorPart[] = [];
  private hullPart: Part | undefined;
  private cockpitPart: CockpitPart | undefined;

  public constructor(parts: readonly AnyPart[]) {
    this.replaceAll(parts);
  }

  // 一覧をまるごと差し替える。配列の参照は保つ(換装 UI が同じ配列を握っている)。
  public replaceAll(parts: readonly AnyPart[]): void {
    this.parts.splice(0, this.parts.length, ...parts);
    this.refresh();
  }

  // 部品構成が変わったとき(換装など)に、機体の maxHp と hp を部品側から求め直す。
  public refresh(): void {
    this.rebuildReferences();
    let maxHp = 0;
    for (const p of this.parts) maxHp += p.maxHp;
    this.maxHp = maxHp;
    this.updateOverallHp();
  }

  private rebuildReferences(): void {
    this.engineRefs.length = 0;
    this.rcsThrusterRefs.length = 0;
    this.flywheelRefs.length = 0;
    this.batteryRefs.length = 0;
    this.fuelCellRefs.length = 0;
    this.rtgRefs.length = 0;
    this.propellantTankRefs.length = 0;
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
        case 'engine': this.engineRefs.push(part); break;
        case 'rcs_thruster': this.rcsThrusterRefs.push(part); break;
        case 'flywheel': this.flywheelRefs.push(part); break;
        case 'battery': this.batteryRefs.push(part); break;
        case 'fuel_cell': this.fuelCellRefs.push(part); break;
        case 'rtg': this.rtgRefs.push(part); break;
        case 'oxidizer_tank': case 'reductant_tank': case 'rcs_tank':
          this.propellantTankRefs.push(part); break;
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
  public updateOverallHp(): void {
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
  public setOverallHp(total: number): void {
    const ratio = this.maxHp > 0 ? Math.max(0, Math.min(1, total / this.maxHp)) : 0;
    for (const p of this.parts) p.hp = p.maxHp * ratio;
    this.updateOverallHp();
  }

  // 受けたダメージを健全なパーツ1つへ無作為に割り振る。装甲があれば最も高い軽減率で
  // 減衰させる。part を指定すると割り振り先をそのパーツに固定する(被弾位置から
  // 当たったパーツが判っている場合)。
  public applyDamage(amount: number, part?: Part): void {
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
  public selfRepair(amount: number): void {
    const targets = this.parts.filter(
      (p) => p.hp > 0 && p.hp < p.maxHp && !SELF_REPAIR_EXCLUDED.includes(p.type));
    if (targets.length === 0) return;
    const share = amount / targets.length;
    for (const p of targets) p.hp = Math.min(p.maxHp, p.hp + share);
    this.updateOverallHp();
  }

  // 姿勢トルク [N·m]。健全なフライホイールの最大トルクの合計を、向きによらない1つの値として答える。
  public get totalTorque(): number {
    let total = 0;
    for (const p of this.flywheelRefs) if (p.hp > 0) total += p.maxTorque;
    return total;
  }

  // 主機の推力の合計 [N]。並進 RCS は主機に数えない(§6-5)。
  public get totalThrust(): number {
    let total = 0;
    for (const p of this.engineRefs) if (p.hp > 0) total += p.thrust;
    return total;
  }

  // 並進 RCS スラスタの推力の合計 [N]。
  public get totalRcsThrust(): number {
    let total = 0;
    for (const p of this.rcsThrusterRefs) if (p.hp > 0) total += p.thrust;
    return total;
  }

  // 主機の質量流量 [kg/s] を、推進剤ごとに集計する。複数の主機が別々の推進剤を積んでいてもよい。
  public engineFuelConsumptionRates(): ReadonlyMap<PropellantId, number> {
    const rates = new Map<PropellantId, number>();
    for (const p of this.engineRefs) {
      if (p.hp <= 0) continue;
      rates.set(p.propellant, (rates.get(p.propellant) ?? 0) + p.fuelConsumptionRate);
    }
    return rates;
  }

  // 並進 RCS スラスタの質量流量 [kg/s] を、推進剤ごとに集計する。
  public rcsFuelConsumptionRates(): ReadonlyMap<PropellantId, number> {
    const rates = new Map<PropellantId, number>();
    for (const p of this.rcsThrusterRefs) {
      if (p.hp <= 0 || p.specificImpulse <= 0) continue;
      rates.set(p.propellant, (rates.get(p.propellant) ?? 0) + p.thrust / (p.specificImpulse * STANDARD_GRAVITY));
    }
    return rates;
  }

  // rates の推進剤それぞれを rate × scale だけ消費し、実際に消費できた割合の最小値を返す
  // (いずれか1つの推進剤が尽きれば、その割合で出力全体を絞る)。
  public consumeFuelByRates(rates: ReadonlyMap<PropellantId, number>, scale: number): number {
    let minRatio = 1.0;
    for (const [propellant, rate] of rates) {
      const ratio = this.consumeFuel(propellant, rate * scale);
      if (ratio < minRatio) minRatio = ratio;
    }
    return minRatio;
  }

  // その推進剤を積んだ健全なタンクの現在量の合計 [kg]。
  public fuelOf(propellant: PropellantId): number {
    let total = 0;
    for (const p of this.propellantTankRefs) if (p.hp > 0 && p.propellant === propellant) total += p.fuel;
    return total;
  }

  // その推進剤を積んだ健全なタンクの容量の合計 [kg]。容量はタンクの volume と推進剤の密度から出る。
  public maxFuelOf(propellant: PropellantId): number {
    let total = 0;
    for (const p of this.propellantTankRefs) {
      if (p.hp > 0 && p.propellant === propellant) total += propellantTankCapacity(propellant, p.volume);
    }
    return total;
  }

  // 積んでいる健全な推進剤タンクを、推進剤ごとに現在量・容量の対へ集計する。HUD の
  // 燃料表示など、機体の推進剤は1種類とは限らない前提で読む側がこれを使う。
  public propellantSummary(): readonly { readonly propellant: PropellantId; readonly fuel: number; readonly capacity: number }[] {
    const order: PropellantId[] = [];
    const fuel = new Map<PropellantId, number>();
    const capacity = new Map<PropellantId, number>();
    for (const p of this.propellantTankRefs) {
      if (p.hp <= 0) continue;
      if (!fuel.has(p.propellant)) {
        order.push(p.propellant);
        fuel.set(p.propellant, 0);
        capacity.set(p.propellant, 0);
      }
      fuel.set(p.propellant, fuel.get(p.propellant)! + p.fuel);
      capacity.set(p.propellant, capacity.get(p.propellant)! + propellantTankCapacity(p.propellant, p.volume));
    }
    return order.map((propellant) => ({ propellant, fuel: fuel.get(propellant)!, capacity: capacity.get(propellant)! }));
  }

  // propellant を amount [kg] 消費し、実際に消費できた割合(0.0〜1.0)を返す。
  // どの推進剤を燃やすかは呼び出し側(噴射する部品)が知っていることで、タンクの側の問題ではない。
  public consumeFuel(propellant: PropellantId, amount: number): number {
    if (amount <= 0) return 1.0;
    let remaining = amount;
    let consumed = 0;
    for (const tank of this.propellantTankRefs) {
      if (tank.hp <= 0 || tank.propellant !== propellant) continue;
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

  // propellant を積んだタンクへ amount [kg] 戻す。満タンを超える分は入らない。
  public refuel(propellant: PropellantId, amount: number): void {
    let remaining = amount;
    for (const tank of this.propellantTankRefs) {
      if (remaining <= 0) break;
      if (tank.propellant !== propellant) continue;
      const room = Math.max(0, propellantTankCapacity(propellant, tank.volume) - tank.fuel);
      const filled = Math.min(room, remaining);
      tank.fuel += filled;
      remaining -= filled;
    }
  }

  public get solarParts(): readonly (SolarPanelPart | undefined)[] {
    return this.solarPanelRefs;
  }

  // 放熱能力。放熱板の面積と効率の積の合計で、有効放熱面積 [m^2] にあたる。
  public get totalCoolingRate(): number {
    let total = 0;
    for (const p of this.radiatorRefs) if (p && p.hp > 0) total += p.area * p.efficiency;
    return total;
  }

  // 発電量 [W]。太陽電池パドル・燃料電池・原子力電池の出力の合計(§6-5)。
  // パドルの出力は地球軌道の太陽定数を正対で受けたときの値で、入射角と日照は電力系が掛ける。
  public get totalPowerGeneration(): number {
    let total = 0;
    for (const p of this.solarPanelRefs) {
      if (p && p.hp > 0) total += C.SOLAR_CONSTANT * p.area * p.efficiency;
    }
    for (const p of this.fuelCellRefs) if (p.hp > 0) total += p.ratedOutput;
    for (const p of this.rtgRefs) if (p.hp > 0) total += p.ratedOutput;
    return total;
  }

  // 蓄電容量 [J]。バッテリーの容量の合計。
  public get totalEnergyStorage(): number {
    let total = 0;
    for (const p of this.batteryRefs) if (p.hp > 0) total += p.capacity;
    return total;
  }

  // 全搭載要素の消費電力の合計 [W]。
  public get totalPowerDraw(): number {
    let total = 0;
    for (const p of this.parts) total += powerDrawOf(p);
    return total;
  }

  // 廃熱 [W]。電力は最終的にすべて熱になるので消費電力の合計を土台にし、
  // 電照農場と生命維持装置が別に出す熱を足す(§6-5)。
  public get totalWasteHeat(): number {
    let total = 0;
    for (const p of this.parts) total += powerDrawOf(p) + extraWasteHeatOf(p);
    return total;
  }

  // その推進剤を収める健全なタンクの容積の合計 [m³]。
  public propellantVolume(propellant: PropellantId): number {
    let total = 0;
    for (const p of this.parts) {
      if (p.hp <= 0) continue;
      if (p.type !== 'oxidizer_tank' && p.type !== 'reductant_tank' && p.type !== 'rcs_tank') continue;
      if (p.propellant !== propellant) continue;
      total += p.volume;
    }
    return total;
  }

  // 1発あたりのダメージ。複数積んでいる場合は最も強い武装のものを使う。
  public get weaponDamage(): number {
    let damage = 0;
    let hasWeapon = false;
    for (const p of this.weaponRefs) {
      if (p.hp <= 0) continue;
      if (!hasWeapon || p.damage > damage) damage = p.damage;
      hasWeapon = true;
    }
    return damage;
  }

  public get totalFireRate(): number {
    let total = 0;
    for (const p of this.weaponRefs) if (p.hp > 0) total += p.fireRate;
    return total;
  }

  // 生存武装の初速平均。武装が全損している場合は 0。
  public get averageMuzzleVelocity(): number {
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
