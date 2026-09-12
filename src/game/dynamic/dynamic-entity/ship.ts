import { Attitude } from '../../../physics/attitude';
import { DynamicEntity, type DynamicMotionFactory } from './dynamic-entity';
import { EntityIdAllocator } from './entity-id';
import type { DynamicView } from '../../../render/dynamic/dynamic-view';
import type { DynamicMotionProperties } from '../dynamic-motion';
import { Part, PartType, createPart } from './parts';
import { collisionDamageFraction } from './contact-damage';
import { SHIP_ARROWHEAD_POINTS, triangleHpMarkerSvg } from '../../marker/marker-shapes';
import type {
  ArmorPart,
  CockpitPart,
  RadiatorPart,
  RcsTankPart,
  SolarPanelPart,
  ThrusterPart,
  WeaponPart,
} from './parts';
import { DEFAULT_HISTORY_DURATION } from '../predicted-arc';
import { THROTTLE_LEVELS, MAX_ANG_ACCEL } from '../../player/throttle';

const hpMarkerClipIdAllocator = new EntityIdAllocator('ship-hp-');

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

// 自機の質量 [kg]。既定パーツのスラスター推力はこの質量で THROTTLE_LEVELS の最大値の
// 加速度になるよう決めてあるので、両者を別々に動かすと表示と実挙動がずれる。
export const PLAYER_MASS = 1000;

// 自機の主慣性モーメント(相対値、3軸とも異なる非対称形にしてジャニベコフ効果を起こす)
export const PLAYER_INERTIA_PITCH = 1.0; // ピッチ軸(X)。3軸中の中間値 = 不安定軸
export const PLAYER_INERTIA_YAW = 1.6; // ヨー軸(Y)
export const PLAYER_INERTIA_ROLL = 0.5; // ロール軸(Z、機体前後)。細長い形状に見合って最小

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
const FIRE_INTERVAL = 0.06; // 発射間隔 [s]
const ENEMY_BULLET_DAMAGE = 1; // 既定の機関砲が 1 発で与えるダメージ [HP]。武器部品の damage の初期値

// パーツ式の被弾モデルを持つ艦(自機・敵機)。HP と性能はパーツの合計から求める。
export abstract class Ship extends DynamicEntity {
  public override readonly combatTarget = true;
  // SVG の clipPath は名前変更や同名艦の追加でも衝突しないよう、個体寿命の ID を使う。
  private readonly hpMarkerClipId = hpMarkerClipIdAllocator.next();

  private _hp!: number;
  private _maxHp!: number;
  public parts: Part[] = [];

  public get hp(): number { return this._hp; }
  public set hp(value: number) { this._hp = value; }
  public get maxHp(): number { return this._maxHp; }
  public set maxHp(value: number) { this._maxHp = value; }

  // type 別のパーツ参照。parts を入れ替えたら組み直す。値ではなく参照を持つので、パーツの
  // HP・燃料の変化はそのまま読める。
  private readonly thrusterPartRefs: ThrusterPart[] = [];
  private readonly rcsTankPartRefs: RcsTankPart[] = [];
  private readonly radiatorPartRefs: [RadiatorPart | undefined, RadiatorPart | undefined] = [undefined, undefined];
  private readonly solarPanelPartRefs: [SolarPanelPart | undefined, SolarPanelPart | undefined] = [undefined, undefined];
  private readonly weaponPartRefs: WeaponPart[] = [];
  private readonly armorPartRefs: ArmorPart[] = [];
  private hullPart: Part | undefined;
  private cockpitPart: CockpitPart | undefined;

  // 基底の識別・Motion・View を組み、名前と HP を初期化して既定パーツを積む。
  public constructor(
    name: string,
    hp: number,
    motionFactory: DynamicMotionFactory,
    view: DynamicView,
    id?: string,
  ) {
    super(motionFactory, view, id);
    this.setName(name);
    this.hp = hp;
    this.maxHp = hp;
    this.initDefaultParts();
  }

  // 既定パーツへの HP 配分比。合計 1 になるよう保つ(艦の maxHp をこの比で割り振る)。
  // 放熱板・太陽電池パドルは機体の左右2枚ぶんなので、パーツも side ごとに1枚ずつ持つ。
  private static readonly DEFAULT_PART_HP_RATIO = {
    hull: 0.40, cockpit: 0.10, thruster: 0.08, rcsTank: 0.08,
    radiator: 0.05, solarPanel: 0.03, weapon: 0.08, armor: 0.10,
  } as const;

  // 初期状態として基本的なパーツセットを生成する（サブクラスで上書き可能）。
  // 生成後の全パーツ HP 合計が艦の hp/maxHp の正本になる。
  protected initDefaultParts(): void {
    const R = Ship.DEFAULT_PART_HP_RATIO;
    const share = (ratio: number): number => Math.max(1, Math.round(this.maxHp * ratio));
    const mk = <T extends Parameters<typeof createPart>[0]>(type: T, ratio: number, props: object) =>
      createPart(type, { maxHp: share(ratio), hp: share(ratio), ...props } as never);
    this.parts = [
      mk('hull', R.hull, { name: 'Basic Hull' }),
      mk('cockpit', R.cockpit, { name: 'Cockpit' }),
      mk('thruster', R.thruster, {
        name: 'Standard RCS',
        torque: MAX_ANG_ACCEL * Math.max(PLAYER_INERTIA_PITCH, PLAYER_INERTIA_YAW, PLAYER_INERTIA_ROLL),
        // 既定パーツだけを積んだ自機が、全開で THROTTLE_LEVELS の最大値の加速度になる推力。
        thrust: PLAYER_MASS * THROTTLE_LEVELS[THROTTLE_LEVELS.length - 1]!,
        fuelConsumptionRate: 1,
      }),
      mk('rcs_tank', R.rcsTank, { name: 'Main RCS Tank', maxFuel: 1000, fuel: 1000 }),
      mk('radiator', R.radiator, { name: 'Heat Radiator L', coolingRate: 42 }),
      mk('radiator', R.radiator, { name: 'Heat Radiator R', coolingRate: 42 }),
      mk('solar_panel', R.solarPanel, { name: 'Solar Array L', powerGeneration: 50 }),
      mk('solar_panel', R.solarPanel, { name: 'Solar Array R', powerGeneration: 50 }),
      mk('weapon', R.weapon, {
        name: 'Gatling Gun', weaponType: 'gatling',
        fireRate: 1 / FIRE_INTERVAL, damage: ENEMY_BULLET_DAMAGE, muzzleVelocity: MUZZLE_SPEED,
      }),
      mk('armor', R.armor, { name: 'Light Armor', damageReduction: 0.2 }),
    ];
    // 端数丸めのぶん名目値からずれるので、パーツ側を正本として揃え直す。
    this.refreshFromParts();
  }

  // 部品構成が変わったとき(換装など)に、艦の maxHp と hp を部品側から求め直す。
  public refreshFromParts(): void {
    this.rebuildPartReferences();
    let maxHp = 0;
    for (const p of this.parts) maxHp += p.maxHp;
    this.maxHp = maxHp;
    this.updateOverallHp();
  }

  // parts から type 別のパーツ参照を組み直す。parts を入れ替えたあとに呼ぶ。
  private rebuildPartReferences(): void {
    this.thrusterPartRefs.length = 0;
    this.rcsTankPartRefs.length = 0;
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
        case 'thruster': this.thrusterPartRefs.push(part as ThrusterPart); break;
        case 'rcs_tank': this.rcsTankPartRefs.push(part as RcsTankPart); break;
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
    return triangleHpMarkerSvg(this.hp, this.maxHp);
  }

  // 進行方向へ回転させても崩れない HP 表現。後部が凹んだ鋭角矢尻の外形と、底辺からの塗り高さで
  // 残HP比を示す。味方・自機は単色塗りつぶし(fill-opacity: 1)、敵機は中抜きスタイル。
  public headingHpMarkerSvg(isEnemy = false): string {
    // 塗りの上端は、底辺から矢尻の頂点までを残 HP 比で内分した高さ。
    const ratio = this.maxHp > 0 ? Math.max(0, Math.min(1, this.hp / this.maxHp)) : 0;
    const apexY = 1.5;
    const baseY = 21;
    const fillTopY = (baseY - ratio * (baseY - apexY)).toFixed(2);
    const clipId = this.hpMarkerClipId;
    const pts = SHIP_ARROWHEAD_POINTS;
    if (isEnemy) {
      return `<svg viewBox="0 0 24 24" width="24" height="24" aria-label="HP ${Math.max(0, this.hp)} / ${this.maxHp}">` +
        `<polygon points="${pts}" fill="none" stroke="currentColor" stroke-width="1.8"/>` +
        `</svg>`;
    }
    return `<svg viewBox="0 0 24 24" width="24" height="24" aria-label="HP ${Math.max(0, this.hp)} / ${this.maxHp}">` +
      `<clipPath id="${clipId}"><rect x="0" y="${fillTopY}" width="24" height="24"/></clipPath>` +
      `<polygon points="${pts}" fill="currentColor" fill-opacity="1" clip-path="url(#${clipId})"/>` +
      `<polygon points="${pts}" fill="none" stroke="currentColor" stroke-width="1.5"/>` +
      `</svg>`;
  }

  // パーツベースの性能取得
  public get totalTorque(): number {
    let total = 0;
    for (const p of this.thrusterPartRefs) if (p.hp > 0) total += p.torque;
    return total;
  }

  // 健全なスラスターの推力の合計 [N]。
  public get totalThrust(): number {
    let total = 0;
    for (const p of this.thrusterPartRefs) if (p.hp > 0) total += p.thrust;
    return total;
  }

  // 健全なスラスターの燃料消費率の合計。
  public get totalFuelConsumptionRate(): number {
    let total = 0;
    for (const p of this.thrusterPartRefs) if (p.hp > 0) total += p.fuelConsumptionRate;
    return total;
  }

  // 健全なタンクの燃料の合計 [kg]。
  public get totalFuel(): number {
    let total = 0;
    for (const p of this.rcsTankPartRefs) if (p.hp > 0) total += p.fuel;
    return total;
  }

  // 健全なタンクの容量の合計 [kg]。
  public get totalMaxFuel(): number {
    let total = 0;
    for (const p of this.rcsTankPartRefs) if (p.hp > 0) total += p.maxFuel;
    return total;
  }

  // 燃料を消費し、実際に消費できた割合（0.0〜1.0）を返す
  public consumeFuel(amount: number): number {
    if (amount <= 0) return 1.0;

    // 健全なタンクから並び順に汲む。
    let remainingToConsume = amount;
    let actualConsumed = 0;
    
    for (const tank of this.rcsTankPartRefs) {
      if (tank.hp <= 0) continue;
      if (tank.fuel > 0) {
        const consumeFromTank = Math.min(tank.fuel, remainingToConsume);
        tank.fuel -= consumeFromTank;
        remainingToConsume -= consumeFromTank;
        actualConsumed += consumeFromTank;
      }
      if (remainingToConsume <= 0) break;
    }
    
    return actualConsumed / amount;
  }

  // 燃料を補給し、実際に追加できた量 [kg] を返す。破損タンクと容量超過は対象外。
  public refuelFuel(amount: number): number {
    if (amount <= 0) return 0;

    // 健全なタンクの空きを並び順に埋める。
    let remainingToAdd = amount;
    let actualAdded = 0;
    for (const tank of this.rcsTankPartRefs) {
      if (tank.hp <= 0) continue;
      const space = Math.max(0, tank.maxFuel - tank.fuel);
      if (space > 0) {
        const addToTank = Math.min(space, remainingToAdd);
        tank.fuel += addToTank;
        remainingToAdd -= addToTank;
        actualAdded += addToTank;
      }
      if (remainingToAdd <= 0) break;
    }
    return actualAdded;
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
