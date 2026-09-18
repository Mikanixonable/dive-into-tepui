import { sunGlareSpreadScale } from '../../combat/sun-glare-spread';
import type { CelestialBodies } from '../../celestial/celestial-bodies';
import type { Player } from '../../player/player';
import { Bullet } from './bullet';
import type { Enemy } from './enemy';
import type { EntityRegistry } from '../entity-registry';
import type { RunEventSink } from '../../run-events';
import { ENGAGEMENT_RANGE } from '../engagement-zone';
import { add, len, norm, randPerp, rotateAxis, scale, sub, type Vec3 } from '../../../math/vec3';
import { solveLeadTime } from '../../../physics/intercept';
import { kinematicState, type KinematicState } from '../../../physics/kinematic-state';
import type { DynamicMotion } from '../dynamic-motion';
import { MUZZLE_SPEED } from './vessel';
import { countAttackingEnemiesInGroup } from './enemy-attack-group';

const PLASMA_BULLET_SPEED = MUZZLE_SPEED * 2 / 3; // プラズマ弾の初速 [m/s]
const PLASMA_LIFETIME = 300; // プラズマ弾の寿命 [sim s]
const ENEMY_FIRE_INTERVAL = 1.0; // 敵の射撃間隔 [s]
const ENEMY_BURST_INTERVAL = 0.08; // 敵のバースト射撃時の連射間隔 [s]
const ENEMY_AI_MIN_RANGE = 50; // 射撃する最短距離 [m]
const ENEMY_MAX_ATTACKERS_PER_GROUP = 3;
const ENEMY_ATTACK_CHANCE = 0.6;
const ENEMY_BURST_COUNTS = [3, 5, 7, 20];
const PLASMA_SPREAD_DEG = 0.05;

export interface EnemyFireControllerPort {
  readonly motion: DynamicMotion;
  readonly attackGroupId: string;
  canFire(enemies: readonly Enemy[]): boolean;
  muzzlePosition(): Vec3;
  plasmaDamage(): number;
  muzzleEffect(muzzleState: KinematicState, events: RunEventSink): void;
}

// バースト射撃の残弾と次弾までの残り時間 [s](未着手なら両方 null)、最後に射撃の機会が巡った時刻と
// 最後に行動した時刻 [sim s](まだなら null)。
export interface SerializedEnemyFireController {
  readonly burstLeft: number | null;
  readonly burstDelay: number | null;
  readonly lastFireSim: number | null;
  readonly lastBehaviorSim: number | null;
}

// 敵の射撃判断・バースト進行・弾生成をEnemy本体から分離する。
export class EnemyFireController {
  public enabled = true;

  // port は撃つ敵。burstLeft・burstDelay はバースト射撃の残弾と次弾までの残り時間で、未着手なら
  // 両方 null。lastFireSim・lastBehaviorSim は最後に射撃の機会が巡った時刻と最後に行動した
  // 時刻で、まだなら null。
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

  public behave(
    simTime: number, player: Player, registry: EntityRegistry, enemies: readonly Enemy[],
    operable: boolean, celestialBodies: CelestialBodies,
  ): void {
    const behaviorDt = this.lastBehaviorSim === null ? 0 : Math.max(0, simTime - this.lastBehaviorSim);
    this.lastBehaviorSim = simTime;
    if (!operable || !this.enabled) return;
    if (!this.port.canFire(enemies)) {
      this.burstLeft = null;
      this.burstDelay = null;
      return;
    }
    const dist = len(sub(player.motion.state.r, this.port.motion.state.r));
    if (!(dist < ENGAGEMENT_RANGE && dist > ENEMY_AI_MIN_RANGE)) return;

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

  private firePlasma(
    simTime: number, player: Player, registry: EntityRegistry, celestialBodies: CelestialBodies,
  ): void {
    const r = this.port.muzzlePosition();
    const v = this.port.motion.state.v;
    const toPlayer = sub(player.motion.state.r, r);
    const relV = sub(player.motion.state.v, v);
    let leadTime = solveLeadTime(toPlayer, relV, PLASMA_BULLET_SPEED);
    if (leadTime === null || leadTime < 0) leadTime = len(toPlayer) / PLASMA_BULLET_SPEED;
    const predictedRelPos = add(toPlayer, scale(relV, leadTime));
    const aimDir = norm(predictedRelPos);
    const spreadScale = sunGlareSpreadScale(r, aimDir, celestialBodies, simTime);
    const perp = randPerp(aimDir);
    const spreadAng = (Math.random() * PLASMA_SPREAD_DEG * spreadScale * Math.PI) / 180;
    const actualAim = rotateAxis(aimDir, perp, spreadAng);
    const bV = add(v, scale(actualAim, PLASMA_BULLET_SPEED));
    const bullet = new Bullet(
      kinematicState<'eci'>(simTime, r, bV), PLASMA_LIFETIME, 'enemy', 'plasma',
      this.port.plasmaDamage(), registry.idAllocators,
    );
    this.port.muzzleEffect(kinematicState<'eci'>(simTime, r, v), registry.events);
    registry.add(bullet);
  }
}
