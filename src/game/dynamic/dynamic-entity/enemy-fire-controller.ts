import { sunGlareSpreadScale } from '../../combat/sun-glare-spread';
import type { CelestialBodies } from '../../celestial/celestial-bodies';
import type { ModularShip } from '../../ship/modular-ship';
import { Bullet } from './bullet';
import type { Enemy } from './enemy';
import type { EntityRegistry } from '../entity-registry';
import type { RunEventSink } from '../../run-events';
import { ENGAGEMENT_RANGE } from '../engagement-zone';
import { add, len, norm, randPerp, rotateAxis, scale, sub, type Vec3 } from '../../../math/vec3';
import { solveLeadTime } from '../../../physics/intercept';
import { kinematicState, type KinematicState } from '../../../physics/kinematic-state';
import type { DynamicMotion } from '../dynamic-motion';
import { MUZZLE_SPEED } from './combat-ship-entity';
import { countAttackingEnemiesInGroup } from './enemy-attack-group';

const PLASMA_BULLET_SPEED = MUZZLE_SPEED * 2 / 3; // プラズマ弾の初速 [m/s]
const PLASMA_LIFETIME = 300; // プラズマ弾の寿命 [sim s]
const ENEMY_FIRE_INTERVAL = 1.0; // 敵の射撃間隔 [s]
const ENEMY_BURST_INTERVAL = 0.08; // 敵のバースト射撃時の連射間隔 [s]
const ENEMY_AI_MIN_RANGE = 50; // 射撃する最短距離 [m]
const ENEMY_MAX_ATTACKERS_PER_GROUP = 3; // 攻撃グループ内で同時にバーストする敵の上限
const ENEMY_ATTACK_CHANCE = 0.6; // 射撃の機会ごとにバーストを始める確率
const ENEMY_BURST_COUNTS = [3, 5, 7, 20]; // バースト1回の弾数の候補
const PLASMA_SPREAD_DEG = 0.05; // 太陽グレアの倍率が 1 のときの、プラズマ弾の散布角の最大 [deg]

// 射撃を行う敵ユニットが、射撃判定および弾丸生成のために提供するインターフェース。
export interface EnemyFireControllerPort {
  readonly motion: DynamicMotion;
  readonly attackGroupId: string;
  canFire(enemies: readonly Enemy[]): boolean;
  muzzlePosition(): Vec3;
  plasmaDamage(): number;
  fired(muzzleState: KinematicState, events: RunEventSink): void;
}

// 射撃判断の途中経過(バーストの残弾と次弾まで、射撃の機会と行動の時刻)の直列化した形。
export interface SerializedEnemyFireController {
  readonly burstLeft: number | null;
  readonly burstDelay: number | null;
  readonly lastFireSim: number | null;
  readonly lastBehaviorSim: number | null;
}

// 敵1体の射撃判断・バースト進行・弾の生成。
export class EnemyFireController {
  // port は撃つ敵。burstLeft・burstDelay はバースト射撃の残弾と次弾までの残り時間 [s] で、未着手なら
  // 両方 null。lastFireSim・lastBehaviorSim は最後に射撃の機会が巡った時刻と最後に行動した
  // 時刻 [sim s] で、まだなら null。
  public constructor(
    private readonly port: EnemyFireControllerPort,
    private burstLeft: number | null = null,
    private burstDelay: number | null = null,
    private lastFireSim: number | null = null,
    private lastBehaviorSim: number | null = null,
  ) {}

  public get isBursting(): boolean { return this.burstLeft !== null && this.burstLeft > 0; }

  // バースト射撃の途中経過と、射撃の機会・行動の時刻の直列化。
  public serialize(): SerializedEnemyFireController {
    return {
      burstLeft: this.burstLeft,
      burstDelay: this.burstDelay,
      lastFireSim: this.lastFireSim,
      lastBehaviorSim: this.lastBehaviorSim,
    };
  }

  // simTime に1回行動し、条件が揃えば player を狙ったプラズマ弾を registry へ加える。mayFire が偽の
  // 間は撃たない。
  public updateBehavior(
    simTime: number, player: ModularShip, registry: EntityRegistry, enemies: readonly Enemy[],
    mayFire: boolean, celestialBodies: CelestialBodies,
  ): void {
    const behaviorDt = this.lastBehaviorSim === null ? 0 : Math.max(0, simTime - this.lastBehaviorSim);
    this.lastBehaviorSim = simTime;
    if (!mayFire) return;
    if (!this.port.canFire(enemies)) {
      this.burstLeft = null;
      this.burstDelay = null;
      return;
    }
    // 近すぎず、交戦距離の内にいる間だけ撃つ
    const dist = len(sub(player.motion.state.r, this.port.motion.state.r));
    if (!(dist < ENGAGEMENT_RANGE && dist > ENEMY_AI_MIN_RANGE)) return;

    // バーストの途中なら、次弾の時刻が来たら続きを撃つ
    if (this.isBursting) {
      this.burstDelay = (this.burstDelay ?? 0) - behaviorDt;
      if (this.burstDelay <= 0) {
        this.firePlasma(simTime, player, registry, celestialBodies);
        const burstLeft = this.burstLeft;
        this.burstLeft = burstLeft === null ? null : burstLeft - 1;
        this.burstDelay = ENEMY_BURST_INTERVAL;
      }
      return;
    }

    // 射撃の機会が巡ったら、攻撃グループの同時発砲数と確率で新しいバーストを始める
    if (this.lastFireSim === null) this.lastFireSim = simTime - Math.random() * ENEMY_FIRE_INTERVAL;
    if (simTime - this.lastFireSim <= ENEMY_FIRE_INTERVAL) return;
    this.lastFireSim = simTime;
    const countInGroup = countAttackingEnemiesInGroup(enemies, this.port.attackGroupId);
    if (countInGroup >= ENEMY_MAX_ATTACKERS_PER_GROUP || Math.random() >= ENEMY_ATTACK_CHANCE) return;
    const burstCount = ENEMY_BURST_COUNTS[Math.floor(Math.random() * ENEMY_BURST_COUNTS.length)] ?? 1;
    this.burstLeft = burstCount - 1;
    this.burstDelay = ENEMY_BURST_INTERVAL;
    this.firePlasma(simTime, player, registry, celestialBodies);
  }

  // player の未来位置を狙ってプラズマ弾を1発撃ち、発砲を記録する。
  private firePlasma(
    simTime: number, player: ModularShip, registry: EntityRegistry, celestialBodies: CelestialBodies,
  ): void {
    const r = this.port.muzzlePosition();
    const v = this.port.motion.state.v;
    const toPlayer = sub(player.motion.state.r, r);
    const relV = sub(player.motion.state.v, v);
    // 相対運動から迎撃時刻を解き、解けなければ直線距離で代える
    let leadTime = solveLeadTime(toPlayer, relV, PLASMA_BULLET_SPEED);
    if (leadTime === null || leadTime < 0) leadTime = len(toPlayer) / PLASMA_BULLET_SPEED;
    const predictedRelPos = add(toPlayer, scale(relV, leadTime));
    const aimDir = norm(predictedRelPos);
    // 太陽の眩しさで広がる散布界を狙いに足す
    const spreadScale = sunGlareSpreadScale(r, aimDir, celestialBodies, simTime);
    const perp = randPerp(aimDir);
    const spreadAng = (Math.random() * PLASMA_SPREAD_DEG * spreadScale * Math.PI) / 180;
    const actualAim = rotateAxis(aimDir, perp, spreadAng);
    const bV = add(v, scale(actualAim, PLASMA_BULLET_SPEED));
    const bullet = Bullet.create(
      kinematicState<'eci'>(simTime, r, bV), PLASMA_LIFETIME, 'enemy', 'plasma',
      this.port.plasmaDamage(), registry.idAllocators,
    );
    this.port.fired(kinematicState<'eci'>(simTime, r, v), registry.events);
    registry.add(bullet);
  }
}
