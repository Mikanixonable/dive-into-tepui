import * as THREE from 'three/webgpu';
import { Attitude } from '../../physics/attitude';
import { KinematicState } from '../../physics/kinematic-state';
import * as C from '../const';
import { GameEntity } from './game-entity';
import type { Attractor } from '../../physics/attractor';
import type { FloatingOrigin } from '../floating-origin';
import { Part, PartType, createPart } from './parts';

export abstract class Ship extends GameEntity {
  protected readonly bcInv = C.SHIP_BCINV;
  protected readonly srpCoeff = C.SHIP_SRP_COEFF;
  protected readonly historyDuration = C.SHIP_HISTORY_DURATION;
  readonly predictsFuture = true;

  name: string;
  radius: number; // 被弾判定半径 [m](剛体接触の collideRadius とは別)
  hp: number;
  maxHp: number;
  parts: Part[] = [];

  // 名前・当たり判定半径・HP を初期化し、基底の状態/メッシュ/姿勢を構築する。
  constructor(
    name: string,
    state: KinematicState,
    obj: THREE.Object3D,
    att: Attitude,
    radius: number,
    hp: number,
    scene?: THREE.Scene,
  ) {
    super(state, obj, scene, att);
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
      mk('radiator', R.radiator, { name: 'Heat Radiator L', coolingRate: 25 }),
      mk('radiator', R.radiator, { name: 'Heat Radiator R', coolingRate: 25 }),
      mk('solar_panel', R.solarPanel, { name: 'Solar Array L', powerGeneration: 50 }),
      mk('solar_panel', R.solarPanel, { name: 'Solar Array R', powerGeneration: 50 }),
      mk('weapon', R.weapon, {
        name: 'Gatling Gun', weaponType: 'gatling',
        fireRate: 1 / C.FIRE_INTERVAL, damage: C.ENEMY_HIT_DAMAGE, muzzleVelocity: C.MUZZLE_SPEED,
      }),
      mk('armor', R.armor, { name: 'Light Armor', damageReduction: 0.2 }),
    ];
    // 端数丸めのぶん名目値からずれるので、パーツ側を正本として揃え直す。
    this.refreshFromParts();
  }

  // 部品構成が変わったとき(換装など)に、艦の maxHp と hp を部品側から求め直す。
  refreshFromParts(): void {
    this.maxHp = this.parts.reduce((sum, p) => sum + p.maxHp, 0);
    this.updateOverallHp();
  }

  // セーブされた総HPだけを復元する経路。部品単位のHPまでは保存していない呼び出し元
  // (Enemy — parts構成自体は毎回既定値で組み直す)向けに、既定パーツへ按分して
  // savedHp 相当の残HPへ揃え直す。initDefaultParts() 直後(全パーツ満タン)に呼ぶ想定。
  restoreOverallHp(savedHp: number): void {
    const ratio = this.maxHp > 0 ? Math.max(0, Math.min(1, savedHp / this.maxHp)) : 0;
    for (const p of this.parts) p.hp = p.maxHp * ratio;
    this.updateOverallHp();
  }

  // 接触速度に応じたダメージをパーツへ適用し、ダメージが発生したかを返す。
  protected applyCollisionDamage(speed: number): boolean {
    const span = C.COLLISION_DAMAGE_FULL_SPEED - C.COLLISION_DAMAGE_MIN_SPEED;
    const t = Math.min(1, Math.max(0, (speed - C.COLLISION_DAMAGE_MIN_SPEED) / span));
    if (t <= 0) return false;
    
    const damage = this.maxHp * t;
    this.applyDamageToParts(damage);
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
    const armors = this.parts.filter(p => p.type === 'armor' && p.hp > 0) as import('./parts').ArmorPart[];
    const reduction = armors.length > 0 ? Math.max(...armors.map(a => a.damageReduction)) : 0;
    const effectiveDamage = amount * (1 - reduction);

    const aliveParts = this.parts.filter(p => p.hp > 0);
    const targetParts = aliveParts.length > 0 ? aliveParts : this.parts;
    const target = part ?? targetParts[Math.floor(Math.random() * targetParts.length)];

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
    const hull = this.parts.find(p => p.type === 'hull');
    const cockpit = this.parts.find(p => p.type === 'cockpit');
    const vital = (hull && hull.hp <= 0) || (cockpit && cockpit.hp <= 0);
    this.hp = vital ? 0 : this.parts.reduce((sum, p) => sum + p.hp, 0);
  }

  // 逆三角形を辺中央の切り欠きで分割し、残HPに応じて発光するSVGを生成する。
  // 分割数は3の倍数へ丸めるため、将来HPが12/18になっても多重リングへ拡張しやすい。
  protected hpMarkerSvg(): string {
    const segments = Math.max(3, Math.round(this.maxHp / 3) * 3);
    const lit = Math.max(0, Math.min(segments, Math.round((this.hp / this.maxHp) * segments)));
    // 正三角形のシルエット(辺長18、外接円中心は(12,12))。
    const points: [number, number][] = [[12, 3], [3, 18.588], [21, 18.588]];
    const lines: string[] = [];
    const emit = (i: number, j: number, k: number, a: number, b: number): void => {
      if (b <= a) return;
      const [x1, y1] = points[i]!;
      const [x2, y2] = points[(i + 1) % 3]!;
      const color = (i * k + j) < lit ? 'currentColor' : 'rgba(120,125,130,.2)';
      lines.push(`<line x1="${x1 + (x2 - x1) * a}" y1="${y1 + (y2 - y1) * a}" x2="${x1 + (x2 - x1) * b}" y2="${y1 + (y2 - y1) * b}" stroke="${color}" stroke-width="1.5" stroke-linecap="butt"/>`);
    };
    for (let i = 0; i < 3; i++) {
      const k = segments / 3;
      // 頂点は連続させ、各辺の中央だけを切り欠く。
      for (let j = 0; j < k; j++) {
        const a = j / k;
        const b = (j + 1) / k;
        const notch = 0.09;
        if (a < 0.5 && b > 0.5) {
          emit(i, j, k, a, 0.5 - notch / 2);
          emit(i, j, k, 0.5 + notch / 2, b);
        } else {
          emit(i, j, k, a, b);
        }
      }
    }
    return `<svg viewBox="0 0 24 24" width="24" height="24" aria-label="HP ${Math.max(0, this.hp)} / ${this.maxHp}">${lines.join('')}</svg>`;
  }

  // 進行方向へ回転させても崩れない HP 表現。三角形の外形と、底辺からの塗り高さで
  // 残HP比を示す(hpMarkerSvg の辺ごとの切り欠きは回転すると上下左右の意味が
  // 崩れるため、マップビューの見出しマーカーにはこちらを使う)。
  protected headingHpMarkerSvg(): string {
    const ratio = this.maxHp > 0 ? Math.max(0, Math.min(1, this.hp / this.maxHp)) : 0;
    const apexY = 3;
    const baseY = 18.588;
    const fillTopY = (baseY - ratio * (baseY - apexY)).toFixed(2);
    const clipId = `hpfill-${this.name}`;
    return `<svg viewBox="0 0 24 24" width="24" height="24" aria-label="HP ${Math.max(0, this.hp)} / ${this.maxHp}">` +
      `<clipPath id="${clipId}"><rect x="0" y="${fillTopY}" width="24" height="24"/></clipPath>` +
      `<polygon points="12,${apexY} 3,${baseY} 21,${baseY}" fill="currentColor" fill-opacity="0.35" clip-path="url(#${clipId})"/>` +
      `<polygon points="12,${apexY} 3,${baseY} 21,${baseY}" fill="none" stroke="currentColor" stroke-width="1.5"/>` +
      `</svg>`;
  }

  // パーツベースの性能取得
  get totalTorque(): number {
    return (this.parts.filter(p => p.type === 'thruster' && p.hp > 0) as import('./parts').ThrusterPart[])
      .reduce((sum, p) => sum + p.torque, 0);
  }

  get totalThrust(): number {
    return (this.parts.filter(p => p.type === 'thruster' && p.hp > 0) as import('./parts').ThrusterPart[])
      .reduce((sum, p) => sum + p.thrust, 0);
  }
  
  get totalFuelConsumptionRate(): number {
    return (this.parts.filter(p => p.type === 'thruster' && p.hp > 0) as import('./parts').ThrusterPart[])
      .reduce((sum, p) => sum + p.fuelConsumptionRate, 0);
  }

  get totalFuel(): number {
    return (this.parts.filter(p => p.type === 'rcs_tank' && p.hp > 0) as import('./parts').RcsTankPart[])
      .reduce((sum, p) => sum + p.fuel, 0);
  }

  get totalMaxFuel(): number {
    return (this.parts.filter(p => p.type === 'rcs_tank' && p.hp > 0) as import('./parts').RcsTankPart[])
      .reduce((sum, p) => sum + p.maxFuel, 0);
  }

  // 燃料を消費し、実際に消費できた割合（0.0〜1.0）を返す
  consumeFuel(amount: number): number {
    if (amount <= 0) return 1.0;
    
    let remainingToConsume = amount;
    let actualConsumed = 0;
    
    const tanks = this.parts.filter(p => p.type === 'rcs_tank' && p.hp > 0) as import('./parts').RcsTankPart[];
    for (const tank of tanks) {
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
  get radiatorParts(): readonly (import('./parts').RadiatorPart | undefined)[] {
    const found = this.parts.filter(p => p.type === 'radiator') as import('./parts').RadiatorPart[];
    return [found[0], found[1]];
  }

  get solarParts(): readonly (import('./parts').SolarPanelPart | undefined)[] {
    const found = this.parts.filter(p => p.type === 'solar_panel') as import('./parts').SolarPanelPart[];
    return [found[0], found[1]];
  }

  get totalCoolingRate(): number {
    return (this.parts.filter(p => p.type === 'radiator' && p.hp > 0) as import('./parts').RadiatorPart[])
      .reduce((sum, p) => sum + p.coolingRate, 0);
  }

  get totalPowerGeneration(): number {
    return (this.parts.filter(p => p.type === 'solar_panel' && p.hp > 0) as import('./parts').SolarPanelPart[])
      .reduce((sum, p) => sum + p.powerGeneration, 0);
  }

  private get aliveWeapons(): import('./parts').WeaponPart[] {
    return this.parts.filter(p => p.type === 'weapon' && p.hp > 0) as import('./parts').WeaponPart[];
  }

  // 1発あたりのダメージ。複数積んでいる場合は最も強い武装のものを使う。
  get weaponDamage(): number {
    const weapons = this.aliveWeapons;
    return weapons.length === 0 ? 0 : Math.max(...weapons.map(p => p.damage));
  }

  get totalFireRate(): number {
    return this.aliveWeapons.reduce((sum, p) => sum + p.fireRate, 0);
  }

  // 生存武装の初速平均。武装が全損している場合は 0(呼び出し側は totalFireRate <= 0 で発射不能を判定する)。
  get averageMuzzleVelocity(): number {
    const weapons = this.aliveWeapons;
    if (weapons.length === 0) return 0;
    return weapons.reduce((sum, p) => sum + p.muzzleVelocity, 0) / weapons.length;
  }

  // メッシュ配下のマテリアルを含めて破棄する。
  dispose(): void {
    super.dispose();
    this.obj.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      if (Array.isArray(mesh.material)) mesh.material.forEach((m) => m.dispose());
      else mesh.material.dispose();
    });
  }

  // オーバービュー時の非ターゲット背景描画用
  syncBackgroundOrbitLine(_show: boolean, _fo: FloatingOrigin, _attractors: readonly Attractor[]): void {}
}
