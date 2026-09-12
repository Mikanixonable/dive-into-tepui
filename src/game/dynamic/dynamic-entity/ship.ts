import { Attitude } from '../../../physics/attitude';
import { DynamicEntity, type DynamicMotionFactory } from './dynamic-entity';
import type { DynamicView } from '../../../render/dynamic/dynamic-view';
import type { DynamicMotionProperties } from '../dynamic-motion';
import { Part, PartType } from './parts';
import { collisionDamageFraction } from './contact-damage';
import type {
  ArmorPart,
  CockpitPart,
  RadiatorPart,
  SolarPanelPart,
  WeaponPart,
} from './parts';
import { DEFAULT_HISTORY_DURATION } from '../predicted-arc';
import { PartInventory } from './part-inventory';
import { ShipMarkerRenderer } from '../../marker/ship-marker-renderer';

// 艦の材質・空力。大気抵抗は弾道係数の逆数 Cd·A/m [m^2/kg]、太陽輻射圧は輻射圧係数 ×
// 断面積質量比 C_R·A/m [m^2/kg] で表す。
export const SHIP_BCINV = 3.3e-3; // Cd≈2.2, A≈12m², m≈8t
export const SHIP_SRP_COEFF = 1.56e-2; // C_R≈1.3, A≈12m², m=PLAYER_MASS
// 宇宙機の実効密度で、曲率半径 0.6 m を与える値。
const SHIP_BULK_DENSITY = 833; // [kg/m^3]
// PLAYER_MASS と掛けて外殻の熱容量 0.1 MJ/K。射撃・被弾の発熱量はこれを基準に決めてある。
const SHIP_SPECIFIC_HEAT = 100; // [J/(kg·K)]
// 艦体自体の放熱面積 70 m² を PLAYER_MASS で割った値。放熱板の展開ぶんはこれに上乗せする。
export const SHIP_RADIATING_AREA_PER_MASS = 0.07; // [m^2/kg]
export const MAX_HULL_TEMP = 1300; // 超過で熱防御飽和 → 機体喪失 [K]

// 艦の物性を既定にした Motion の設定。overrides の項目で上書きする。
export function shipMotionOptions(
  attitude: Attitude, radius: number, overrides: DynamicMotionProperties = {},
): DynamicMotionProperties {
  return {
    attitude,
    radius,
    bcInv: SHIP_BCINV,
    srpCoeff: SHIP_SRP_COEFF,
    // 過去線を保持し、予測も引く
    historyDuration: DEFAULT_HISTORY_DURATION,
    predictedForGhost: true,
    // 熱の物性
    specificHeat: SHIP_SPECIFIC_HEAT,
    bulkDensity: SHIP_BULK_DENSITY,
    radiatingAreaPerMass: SHIP_RADIATING_AREA_PER_MASS,
    ...overrides,
  };
}

export const MUZZLE_SPEED = 1000; // 機関砲初速 [m/s]

// パーツ式の被弾モデルを持つ艦(自機・敵機)。HP と性能はパーツの合計から求める。
export abstract class Ship extends DynamicEntity {
  public override readonly combatTarget = true;
  private readonly markerRenderer = new ShipMarkerRenderer();

  private _hp!: number;
  private _maxHp!: number;
  private readonly inventory = new PartInventory();
  protected get parts(): readonly Part[] { return this.inventory.parts; }

  public get hp(): number { return this._hp; }
  public set hp(value: number) { this._hp = value; }
  public get maxHp(): number { return this._maxHp; }
  public set maxHp(value: number) { this._maxHp = value; }

  // type 別のパーツ参照。parts を入れ替えたら組み直す。値ではなく参照を持つので、パーツの
  // HP・燃料の変化はそのまま読める。
  private readonly radiatorPartRefs: [RadiatorPart | undefined, RadiatorPart | undefined] = [undefined, undefined];
  private readonly solarPanelPartRefs: [SolarPanelPart | undefined, SolarPanelPart | undefined] = [undefined, undefined];
  private readonly weaponPartRefs: WeaponPart[] = [];
  private readonly armorPartRefs: ArmorPart[] = [];
  private hullPart: Part | undefined;
  private cockpitPart: CockpitPart | undefined;

  // 基底の識別・Motion・View を組み、名前と HP を初期化する。ロードアウトは呼び出し側が渡す。
  public constructor(
    name: string,
    hp: number,
    motionFactory: DynamicMotionFactory,
    view: DynamicView,
    id?: string,
    initialParts?: readonly Part[],
  ) {
    super(motionFactory, view, id);
    this.setName(name);
    this.hp = hp;
    this.maxHp = hp;
    if (initialParts && initialParts.length > 0) this.replaceParts(initialParts);
  }
  // 部品構成を所有者の操作として置き換え、参照表と HP を同時に更新する。
  public replaceParts(parts: readonly Part[]): void {
    this.inventory.replace(parts);
    this.rebuildPartReferences();
    let maxHp = 0;
    for (const p of this.parts) maxHp += p.maxHp;
    this.maxHp = maxHp;
    this.updateOverallHp();
  }

  public hasPart(part: Part): boolean { return this.inventory.has(part); }

  // parts から type 別のパーツ参照を組み直す。parts を入れ替えたあとに呼ぶ。
  private rebuildPartReferences(): void {
    this.weaponPartRefs.length = 0;
    this.armorPartRefs.length = 0;
    let radiatorIndex = 0;
    let solarPanelIndex = 0;
    this.radiatorPartRefs[0] = undefined;
    this.radiatorPartRefs[1] = undefined;
    this.solarPanelPartRefs[0] = undefined;
    this.solarPanelPartRefs[1] = undefined;
    this.hullPart = undefined;
    this.cockpitPart = undefined;

    // 船体とコックピットは最初の1つ、放熱板と太陽電池パドルは左右の2枚までを取る。
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

  // 既定パーツ構成のまま、総 HP を total へ按分して揃える。全パーツ満タンの状態から呼ぶこと。
  protected setOverallHp(total: number): void {
    const ratio = this.maxHp > 0 ? Math.max(0, Math.min(1, total / this.maxHp)) : 0;
    for (const p of this.parts) p.hp = p.maxHp * ratio;
    this.updateOverallHp();
  }

  // 接触の重み付き接近速度に応じたダメージをパーツへ適用し、ダメージが発生したかを返す。
  // part を指定すると割り振り先をそのパーツに固定する。
  protected applyCollisionDamage(closingSpeed: number, part?: Part): boolean {
    const t = collisionDamageFraction(closingSpeed);
    if (t <= 0) return false;

    const damage = this.maxHp * t;
    this.applyDamageToParts(damage, part);
    return true;
  }

  // 受けたダメージを健全なパーツ1つへ無作為に割り振る。装甲があれば最も高い軽減率で
  // 減衰させる。part を指定すると割り振り先をそのパーツに固定する(被弾位置から
  // 当たったパーツが判っている場合)。
  protected applyDamageToParts(amount: number, part?: Part): void {
    if (this.parts.length === 0) {
      this.hp -= amount;
      return;
    }

    // 装甲は複数積んでも最も高い軽減率のものだけが効く。
    let reduction = 0;
    let hasArmor = false;
    for (const armor of this.armorPartRefs) {
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

  // 自然回復の対象外にする部品種別。外装パネルは機上で直せず、いまは直す手段がない。
  private static readonly SELF_REPAIR_EXCLUDED: readonly PartType[] = ['radiator', 'solar_panel'];

  // amount [HP] を自然回復できる損傷部品へ均等に配る。全損した部品は対象外で、復旧しない。
  protected selfRepair(amount: number): void {
    const targets = this.parts.filter(
      p => p.hp > 0 && p.hp < p.maxHp && !Ship.SELF_REPAIR_EXCLUDED.includes(p.type));
    if (targets.length === 0) return;
    const share = amount / targets.length;
    for (const p of targets) p.hp = Math.min(p.maxHp, p.hp + share);
    this.updateOverallHp();
  }

  // 全パーツの残 HP 合計を機体の hp に反映する。船体かコックピットを失った時点で
  // 他が無事でも行動不能とみなし 0 にする。
  protected updateOverallHp(): void {
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

  // 残 HP 比を塗りで示す三角の HP マーカーの SVG。
  public hpMarkerSvg(): string {
    return this.markerRenderer.hpMarker(this.hp, this.maxHp);
  }

  // 進行方向へ回転させても崩れない HP 表現。後部が凹んだ鋭角矢尻の外形と、底辺からの塗り高さで
  // 残HP比を示す。味方・自機は単色塗りつぶし(fill-opacity: 1)、敵機は中抜きスタイル。
  public headingHpMarkerSvg(isEnemy = false): string {
    return this.markerRenderer.headingHpMarker(this.hp, this.maxHp, isEnemy);
  }

  // パーツベースの性能取得
  public get totalTorque(): number {
    return this.inventory.healthySum('thruster', p => p.torque);
  }

  // 健全なスラスターの推力の合計 [N]。
  public get totalThrust(): number {
    return this.inventory.healthySum('thruster', p => p.thrust);
  }

  // 健全なスラスターの燃料消費率の合計。
  public get totalFuelConsumptionRate(): number {
    return this.inventory.healthySum('thruster', p => p.fuelConsumptionRate);
  }

  // 健全なタンクの燃料の合計 [kg]。
  public get totalFuel(): number {
    return this.inventory.totalFuel();
  }

  // 健全なタンクの容量の合計 [kg]。
  public get totalMaxFuel(): number {
    return this.inventory.totalMaxFuel();
  }

  // 燃料を消費し、実際に消費できた割合（0.0〜1.0）を返す
  public consumeFuel(amount: number): number {
    return this.inventory.consumeFuel(amount);
  }

  // 燃料を補給し、実際に追加できた量 [kg] を返す。破損タンクと容量超過は対象外。
  public refuelFuel(amount: number): number {
    return this.inventory.refuelFuel(amount);
  }

  // 機体左右2枚の放熱板・太陽電池パドルに対応するパーツ。並び順が side に対応し、
  // 先頭が 'up'(左)、次が 'down'(右)。枚数が足りなければ undefined になる。
  public get radiatorParts(): readonly (RadiatorPart | undefined)[] {
    return this.radiatorPartRefs;
  }

  // 左右2枚の太陽電池パドルに対応するパーツ。並びは radiatorParts と同じく side 順。
  public get solarParts(): readonly (SolarPanelPart | undefined)[] {
    return this.solarPanelPartRefs;
  }

  // 健全な放熱板の冷却率の合計。
  public get totalCoolingRate(): number {
    let total = 0;
    for (const p of this.radiatorPartRefs) if (p && p.hp > 0) total += p.coolingRate;
    return total;
  }

  // 健全な太陽電池パドルの発電量の合計。
  public get totalPowerGeneration(): number {
    let total = 0;
    for (const p of this.solarPanelPartRefs) if (p && p.hp > 0) total += p.powerGeneration;
    return total;
  }

  // 1発あたりのダメージ。複数積んでいる場合は最も強い武装のものを使う。
  public get weaponDamage(): number {
    let damage = 0;
    let hasWeapon = false;
    for (const p of this.weaponPartRefs) {
      if (p.hp <= 0) continue;
      if (!hasWeapon || p.damage > damage) damage = p.damage;
      hasWeapon = true;
    }
    return damage;
  }

  // 健全な武装の発射レートの合計 [発/s]。
  public get totalFireRate(): number {
    let total = 0;
    for (const p of this.weaponPartRefs) if (p.hp > 0) total += p.fireRate;
    return total;
  }

  // 生存武装の初速平均 [m/s]。武装が全損している場合は 0。
  public get averageMuzzleVelocity(): number {
    let total = 0;
    let count = 0;
    for (const p of this.weaponPartRefs) {
      if (p.hp <= 0) continue;
      total += p.muzzleVelocity;
      count++;
    }
    return count === 0 ? 0 : total / count;
  }
}
