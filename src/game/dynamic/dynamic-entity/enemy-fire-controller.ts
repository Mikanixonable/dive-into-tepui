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

// 敵の射撃判断・バースト進行・弾生成をEnemy本体から分離する。
export class EnemyFireController {
  private lastFireSim?: number;
  private burstLeft?: number;
  private burstDelay?: number;
  private lastBehaviorSim?: number;
  public enabled = true;

  public constructor(private readonly port: EnemyFireControllerPort) {}

  public get isBursting(): boolean { return this.burstLeft !== undefined && this.burstLeft > 0; }

  public restore(burstLeft: number | undefined, burstDelay: number | undefined): void {
    this.burstLeft = burstLeft;
    this.burstDelay = burstDelay;
  }

  public get saveState(): { readonly burstLeft?: number; readonly burstDelay?: number } {
    return { burstLeft: this.burstLeft, burstDelay: this.burstDelay };
  }

  public behave(
    simTime: number, player: Player, registry: EntityRegistry, enemies: readonly Enemy[],
    operable: boolean, celestialBodies: CelestialBodies,
  ): void {
    const behaviorDt = this.lastBehaviorSim === undefined ? 0 : Math.max(0, simTime - this.lastBehaviorSim);
    this.lastBehaviorSim = simTime;
    if (!operable || !this.enabled) return;
    if (!this.port.canFire(enemies)) {
      this.burstLeft = undefined;
      this.burstDelay = undefined;
      return;
    }
    const dist = len(sub(player.motion.state.r, this.port.motion.state.r));
    if (!(dist < ENGAGEMENT_RANGE && dist > ENEMY_AI_MIN_RANGE)) return;

    if (this.isBursting) {
      this.burstDelay = (this.burstDelay ?? 0) - behaviorDt;
      if (this.burstDelay <= 0) {
        this.firePlasma(simTime, player, registry, celestialBodies);
        const burstLeft = this.burstLeft;
        this.burstLeft = burstLeft === undefined ? undefined : burstLeft - 1;
        this.burstDelay = ENEMY_BURST_INTERVAL;
      }
      return;
    }

    if (this.lastFireSim === undefined) this.lastFireSim = simTime - Math.random() * ENEMY_FIRE_INTERVAL;
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
