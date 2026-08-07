import * as THREE from 'three/webgpu';
import { Attitude } from '../../physics/attitude';
import { OrbitState } from '../../physics/orbital';
import * as C from '../const';
import { GameEntity } from './game-entity';
import type { CentralBodyId } from '../../physics/central-body';
import type { FloatingOrigin } from '../floating-origin';
import { Part, createPart } from './parts';

export abstract class Ship extends GameEntity {
  protected readonly bcInv = C.SHIP_BCINV;
  protected readonly historyDuration = C.SHIP_HISTORY_DURATION;
  readonly predictDuration = C.PREDICT_DURATION;

  name: string;
  radius: number; // 被弾判定半径 [m](剛体接触の collideRadius とは別)
  hp: number;
  maxHp: number;
  parts: Part[] = [];

  // 名前・当たり判定半径・HP を初期化し、基底の状態/メッシュ/姿勢を構築する。
  constructor(
    name: string,
    state: OrbitState,
    obj: THREE.Object3D,
    att: Attitude,
    radius: number,
    hp: number,
    scene?: THREE.Scene,
    predictionCentralBody: CentralBodyId = 'earth',
  ) {
    super(state, obj, scene, att, predictionCentralBody);
    this.name = name;
    this.radius = radius;
    this.hp = hp;
    this.maxHp = hp;
    this.initDefaultParts();
  }

  // 初期状態として基本的なパーツセットを生成する（サブクラスで上書き可能）
  protected initDefaultParts(): void {
    this.parts = [
      createPart('hull', { name: 'Basic Hull', maxHp: this.maxHp, hp: this.maxHp }),
      createPart('cockpit', { name: 'Cockpit', maxHp: 50, hp: 50 }),
      createPart('thruster', { name: 'Standard RCS', maxHp: 30, hp: 30, torque: 50, thrust: 100, fuelConsumptionRate: 1 }),
      createPart('rcs_tank', { name: 'Main RCS Tank', maxHp: 30, hp: 30, maxFuel: 1000, fuel: 1000 }),
      createPart('radiator', { name: 'Heat Radiator', maxHp: 40, hp: 40, coolingRate: 50 }),
      createPart('solar_panel', { name: 'Solar Array', maxHp: 20, hp: 20, powerGeneration: 100 }),
      createPart('weapon', { name: 'Gatling Gun', maxHp: 40, hp: 40, weaponType: 'gatling', fireRate: 10, damage: 1, muzzleVelocity: 1000 }),
      createPart('armor', { name: 'Light Armor', maxHp: 100, hp: 100, damageReduction: 0.2 }),
    ];
  }

  // 接触速度に応じたダメージをパーツへ適用し、ダメージが発生したかを返す。
  // (旧ロジックでは hp 全体を減らしていたが、ランダムなパーツの損耗へ変更)
  protected applyCollisionDamage(speed: number): boolean {
    const span = C.COLLISION_DAMAGE_FULL_SPEED - C.COLLISION_DAMAGE_MIN_SPEED;
    const t = Math.min(1, Math.max(0, (speed - C.COLLISION_DAMAGE_MIN_SPEED) / span));
    if (t <= 0) return false;
    
    const damage = this.maxHp * t;
    this.applyDamageToParts(damage);
    return true;
  }

  // 受けたダメージをランダムなパーツに割り振る（装甲がある場合は軽減する）
  protected applyDamageToParts(amount: number): void {
    if (this.parts.length === 0) {
      this.hp -= amount; // Fallback
      return;
    }
    
    // Calculate armor reduction
    const armors = this.parts.filter(p => p.type === 'armor' && p.hp > 0) as import('./parts').ArmorPart[];
    let reduction = 0;
    if (armors.length > 0) {
      // Just use the highest damage reduction for now
      reduction = Math.max(...armors.map(a => a.damageReduction));
    }
    
    const effectiveDamage = amount * (1 - reduction);
    
    // Pick a random part to damage
    const aliveParts = this.parts.filter(p => p.hp > 0);
    const targetParts = aliveParts.length > 0 ? aliveParts : this.parts;
    const target = targetParts[Math.floor(Math.random() * targetParts.length)];
    
    if (target) {
      target.hp = Math.max(0, target.hp - effectiveDamage);
    }
    
    // Update overall HP based on hull and cockpit (if either is 0, ship dies)
    this.updateOverallHp();
  }

  // すべてのパーツの状態から、機体全体の代表 HP を再計算する
  protected updateOverallHp(): void {
    if (this.parts.length === 0) return;
    
    const hull = this.parts.find(p => p.type === 'hull');
    const cockpit = this.parts.find(p => p.type === 'cockpit');
    
    // If hull or cockpit is destroyed, ship is destroyed
    if ((hull && hull.hp <= 0) || (cockpit && cockpit.hp <= 0)) {
      this.hp = 0;
    } else if (hull) {
      this.hp = hull.hp;
    }
  }

  // 逆三角形を辺中央の切り欠きで分割し、残HPに応じて発光するSVGを生成する。
  // 分割数は3の倍数へ丸めるため、将来HPが12/18になっても多重リングへ拡張しやすい。
  protected hpMarkerSvg(): string {
    const segments = Math.max(3, Math.round(this.maxHp / 3) * 3);
    const lit = Math.max(0, Math.min(segments, Math.round((this.hp / this.maxHp) * segments)));
    // 正三角形のシルエット(辺長18、外接円中心は(12,12))。
    // 旧形状は高さが幅より大きく、画面上で縦長に見えていた。
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

  get totalCoolingRate(): number {
    return (this.parts.filter(p => p.type === 'radiator' && p.hp > 0) as import('./parts').RadiatorPart[])
      .reduce((sum, p) => sum + p.coolingRate, 0);
  }

  get totalPowerGeneration(): number {
    return (this.parts.filter(p => p.type === 'solar_panel' && p.hp > 0) as import('./parts').SolarPanelPart[])
      .reduce((sum, p) => sum + p.powerGeneration, 0);
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
  syncBackgroundOrbitLine(_show: boolean, _fo: FloatingOrigin): void {}
}
