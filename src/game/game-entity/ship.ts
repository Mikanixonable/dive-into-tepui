import * as THREE from 'three/webgpu';
import { Attitude } from '../../physics/attitude';
import { KinematicState } from '../../physics/kinematic-state';
import * as C from '../const';
import { GameEntity } from './game-entity';
import { Part, PartType, createPart } from './parts';
import { SHIP_ARROWHEAD_POINTS } from '../marker/marker-shapes';
import type {
  ArmorPart,
  CockpitPart,
  RadiatorPart,
  RcsTankPart,
  SolarPanelPart,
  ThrusterPart,
  WeaponPart,
} from './parts';

export abstract class Ship extends GameEntity {
  override readonly bcInv = C.SHIP_BCINV;
  protected readonly srpCoeff = C.SHIP_SRP_COEFF;
  protected readonly baseHistoryDuration = C.DEFAULT_HISTORY_DURATION;
  protected readonly predictedForGhost = true;
  protected readonly specificHeat = C.SHIP_SPECIFIC_HEAT;
  protected readonly bulkDensity = C.SHIP_BULK_DENSITY;
  protected override get radiatingAreaPerMass(): number { return C.SHIP_RADIATING_AREA_PER_MASS; }

  hp: number;
  maxHp: number;
  parts: Part[] = [];

  // パーツ配列の type 走査は性能取得 getter から毎回行わず、換装・復元時だけ組み直す。
  // HP/fuel はパーツ本体で変化するため、これらはパーツ参照の固定配列であり、値のキャッシュではない。
  private readonly thrusterPartRefs: ThrusterPart[] = [];
  private readonly rcsTankPartRefs: RcsTankPart[] = [];
  private readonly radiatorPartRefs: [RadiatorPart | undefined, RadiatorPart | undefined] = [undefined, undefined];
  private readonly solarPanelPartRefs: [SolarPanelPart | undefined, SolarPanelPart | undefined] = [undefined, undefined];
  private readonly weaponPartRefs: WeaponPart[] = [];
  private readonly armorPartRefs: ArmorPart[] = [];
  private hullPart: Part | undefined;
  private cockpitPart: CockpitPart | undefined;

  // 名前・剛体接触半径・HP を初期化し、基底の状態/メッシュ/姿勢を構築する。
  public constructor(
    name: string,
    state: KinematicState,
    renderObject: THREE.Object3D,
    att: Attitude,
    radius: number,
    hp: number,
    scene?: THREE.Scene,
    id?: string,
  ) {
    super(state, renderObject, scene, att, id);
    this.name = name;
    this.radius = radius;
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
        torque: C.MAX_ANG_ACCEL * Math.max(C.PLAYER_INERTIA_PITCH, C.PLAYER_INERTIA_YAW, C.PLAYER_INERTIA_ROLL),
        // 既定パーツだけを積んだ自機が、全開で THROTTLE_LEVELS の最大値の加速度になる推力。
        thrust: C.PLAYER_MASS * C.THROTTLE_LEVELS[C.THROTTLE_LEVELS.length - 1]!,
        fuelConsumptionRate: 1,
      }),
      mk('rcs_tank', R.rcsTank, { name: 'Main RCS Tank', maxFuel: 1000, fuel: 1000 }),
      mk('radiator', R.radiator, { name: 'Heat Radiator L', coolingRate: 42 }),
      mk('radiator', R.radiator, { name: 'Heat Radiator R', coolingRate: 42 }),
      mk('solar_panel', R.solarPanel, { name: 'Solar Array L', powerGeneration: 50 }),
      mk('solar_panel', R.solarPanel, { name: 'Solar Array R', powerGeneration: 50 }),
      mk('weapon', R.weapon, {
        name: 'Gatling Gun', weaponType: 'gatling',
        fireRate: 1 / C.FIRE_INTERVAL, damage: C.ENEMY_BULLET_DAMAGE, muzzleVelocity: C.MUZZLE_SPEED,
      }),
      mk('armor', R.armor, { name: 'Light Armor', damageReduction: 0.2 }),
    ];
    // 端数丸めのぶん名目値からずれるので、パーツ側を正本として揃え直す。
    this.refreshFromParts();
  }

  // 部品構成が変わったとき(換装など)に、艦の maxHp と hp を部品側から求め直す。
  refreshFromParts(): void {
    this.rebuildPartReferences();
    let maxHp = 0;
    for (const p of this.parts) maxHp += p.maxHp;
    this.maxHp = maxHp;
    this.updateOverallHp();
  }

  // パーツの換装・セーブ復元後にだけ呼ぶ type 別参照を再構築する。parts 配列は
  // BaseView/Player の換装経路で splice され、その直後に refreshFromParts が呼ばれる。
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

  // 既定パーツ構成のまま、総HPを total へ按分して揃える。部品単位のHPまでは持たない
  // 呼び出し元(Enemy)向けで、initDefaultParts() 直後(全パーツ満タン)に呼ぶ想定。
  protected setOverallHp(total: number): void {
    const ratio = this.maxHp > 0 ? Math.max(0, Math.min(1, total / this.maxHp)) : 0;
    for (const p of this.parts) p.hp = p.maxHp * ratio;
    this.updateOverallHp();
  }

  // 接触の重み付き接近速度に応じたダメージをパーツへ適用し、ダメージが発生したかを返す。
  // part を指定すると割り振り先をそのパーツに固定する。
  protected applyCollisionDamage(closingSpeed: number, part?: Part): boolean {
    const span = C.COLLISION_DAMAGE_FULL_CLOSING_SPEED - C.COLLISION_DAMAGE_MIN_CLOSING_SPEED;
    const t = Math.min(1, Math.max(0, (closingSpeed - C.COLLISION_DAMAGE_MIN_CLOSING_SPEED) / span));
    if (t <= 0) return false;

    const damage = this.maxHp * t;
    this.applyDamageToParts(damage, part);
    return true;
  }

  // 受けたダメージを健全なパーツ1つへ無作為に割り振る。装甲があれば最も高い軽減率で
  // 減衰させる。part を指定すると割り振り先をそのパーツに固定する(被弾位置から
  // 当たったパーツが判っている場合)。
  applyDamageToParts(amount: number, part?: Part): void {
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

  // 自然回復の対象外にする部品種別。外装パネルは機上で直せず、基地ドックの修理を要する。
  private static readonly SELF_REPAIR_EXCLUDED: readonly PartType[] = ['radiator', 'solar_panel'];

  // amount [HP] を自然回復できる損傷部品へ均等に配る。全損した部品は対象外で、
  // 復旧にはドックでの修理が要る。
  selfRepair(amount: number): void {
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

  // 正三角形を辺中央の切り欠きで分割し、残HPに応じて発光するSVGを生成する。
  // 分割数は3の倍数へ丸めるため、将来HPが12/18になっても多重リングへ拡張しやすい。
  public hpMarkerSvg(): string {
    const segments = Math.max(3, Math.round(this.maxHp / 3) * 3);
    const lit = Math.max(0, Math.min(segments, Math.round((this.hp / this.maxHp) * segments)));
    // 正三角形のシルエット(辺長18、外接円中心は(12,12))。
    const points: [number, number][] = [[12, 3], [21, 18.588], [3, 18.588]];
    const lines: string[] = [];
    const emit = (i: number, j: number, k: number, a: number, b: number): void => {
      if (b <= a) return;
      const [x1, y1] = points[i]!;
      const [x2, y2] = points[(i + 1) % 3]!;
      const color = (i * k + j) < lit ? 'currentColor' : C.COLOR_MARKER_HP_EMPTY;
      lines.push(`<line x1="${x1 + (x2 - x1) * a}" y1="${y1 + (y2 - y1) * a}" x2="${x1 + (x2 - x1) * b}" y2="${y1 + (y2 - y1) * b}" stroke="${color}" stroke-width="1.5" stroke-linecap="butt"/>`);
    };
    for (let i = 0; i < 3; i++) {
      const k = segments / 3;
      const notch = 0.09;
      const notchStart = 0.5 - notch / 2;
      const notchEnd = 0.5 + notch / 2;
      // 頂点は連続させ、各辺の中央だけを切り欠く(境界がちょうど0.5に重なる分割数でも欠ける)。
      for (let j = 0; j < k; j++) {
        const a = j / k;
        const b = (j + 1) / k;
        if (a < notchEnd && b > notchStart) {
          if (a < notchStart) emit(i, j, k, a, notchStart);
          if (b > notchEnd) emit(i, j, k, notchEnd, b);
        } else {
          emit(i, j, k, a, b);
        }
      }
    }
    return `<svg viewBox="0 0 24 24" width="24" height="24" aria-label="HP ${Math.max(0, this.hp)} / ${this.maxHp}">${lines.join('')}</svg>`;
  }

  // 進行方向へ回転させても崩れない HP 表現。後部が凹んだ鋭角矢尻の外形と、底辺からの塗り高さで
  // 残HP比を示す。味方・自機は単色塗りつぶし(fill-opacity: 1)、敵機は中抜きスタイル。
  public headingHpMarkerSvg(isEnemy = false): string {
    const ratio = this.maxHp > 0 ? Math.max(0, Math.min(1, this.hp / this.maxHp)) : 0;
    const apexY = 1.5;
    const baseY = 21;
    const fillTopY = (baseY - ratio * (baseY - apexY)).toFixed(2);
    const clipId = `hpfill-${this.name}`;
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
  get totalTorque(): number {
    let total = 0;
    for (const p of this.thrusterPartRefs) if (p.hp > 0) total += p.torque;
    return total;
  }

  get totalThrust(): number {
    let total = 0;
    for (const p of this.thrusterPartRefs) if (p.hp > 0) total += p.thrust;
    return total;
  }
  
  get totalFuelConsumptionRate(): number {
    let total = 0;
    for (const p of this.thrusterPartRefs) if (p.hp > 0) total += p.fuelConsumptionRate;
    return total;
  }

  get totalFuel(): number {
    let total = 0;
    for (const p of this.rcsTankPartRefs) if (p.hp > 0) total += p.fuel;
    return total;
  }

  get totalMaxFuel(): number {
    let total = 0;
    for (const p of this.rcsTankPartRefs) if (p.hp > 0) total += p.maxFuel;
    return total;
  }

  // 燃料を消費し、実際に消費できた割合（0.0〜1.0）を返す
  consumeFuel(amount: number): number {
    if (amount <= 0) return 1.0;
    
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

  // 機体左右2枚の放熱板・太陽電池パドルに対応するパーツ。並び順が side に対応し、
  // 先頭が 'up'(左)、次が 'down'(右)。枚数が足りなければ undefined になる。
  get radiatorParts(): readonly (RadiatorPart | undefined)[] {
    return this.radiatorPartRefs;
  }

  get solarParts(): readonly (SolarPanelPart | undefined)[] {
    return this.solarPanelPartRefs;
  }

  get totalCoolingRate(): number {
    let total = 0;
    for (const p of this.radiatorPartRefs) if (p && p.hp > 0) total += p.coolingRate;
    return total;
  }

  get totalPowerGeneration(): number {
    let total = 0;
    for (const p of this.solarPanelPartRefs) if (p && p.hp > 0) total += p.powerGeneration;
    return total;
  }

  // 1発あたりのダメージ。複数積んでいる場合は最も強い武装のものを使う。
  get weaponDamage(): number {
    let damage = 0;
    let hasWeapon = false;
    for (const p of this.weaponPartRefs) {
      if (p.hp <= 0) continue;
      if (!hasWeapon || p.damage > damage) damage = p.damage;
      hasWeapon = true;
    }
    return damage;
  }

  get totalFireRate(): number {
    let total = 0;
    for (const p of this.weaponPartRefs) if (p.hp > 0) total += p.fireRate;
    return total;
  }

  // 生存武装の初速平均。武装が全損している場合は 0(呼び出し側は totalFireRate <= 0 で発射不能を判定する)。
  get averageMuzzleVelocity(): number {
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
