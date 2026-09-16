import { kinematicState } from '../../../physics/kinematic-state';
import type { FlashEffects } from '../../vfx/flash-effects';
import { enemyDestroyFragments } from './debris-piece';
import type { WorldSfx } from '../../../audio/sfx/world-sfx';
import type { DynamicMotion } from '../dynamic-motion';
import type { EntityRegistry } from '../entity-registry';
import type { StageOutcome, EnemyDeathCause } from '../../stages/stage-outcome';
import { bulletReactionOf, type BulletType } from './bullet-reaction';
import { closingSpeed, type Contact } from './contact';
import { contactDamageSpeed } from './contact-damage';
import type { Vec3 } from '../../../math/vec3';

export interface EnemyReactionPort {
  readonly motion: DynamicMotion;
  readonly worldSfx: WorldSfx;
  readonly effects: FlashEffects;
  readonly modelScale: number;
  applyBulletDamage(damage: number, impactPoint: Vec3): void;
  applyImpactDamage(damageSpeed: number): boolean;
  hasHealth(): boolean;
  recordDeath(activeStage: StageOutcome, simTime: number, cause: EnemyDeathCause): void;
}

// 敵の被弾・接触・焼失に伴うゲーム結果と演出をEnemyの識別・AIから分離する。
export class EnemyReactions {
  public constructor(private readonly port: EnemyReactionPort) {}

  public receiveEntityContact(
    other: DynamicMotion, contact: Contact, activeStage: StageOutcome, registry: EntityRegistry,
  ): void {
    if (!this.port.motion.alive) return;
    const bullet = bulletReactionOf(other);
    if (bullet !== null) {
      this.attackedByBullet(bullet.type, bullet.damage, contact.point, contact.selfState.t, activeStage, registry);
      return;
    }
    this.damagedByContact(contactDamageSpeed(other, contact), contact.selfState.t, 'killed', activeStage, registry);
  }

  public receiveSurfaceContact(
    contact: Contact, activeStage: StageOutcome, registry: EntityRegistry,
  ): void {
    if (!this.port.motion.alive) return;
    this.damagedByContact(closingSpeed(contact), contact.selfState.t, 'collision', activeStage, registry);
  }

  public receiveBurnUp(activeStage: StageOutcome, registry: EntityRegistry): void {
    this.port.motion.alive = false;
    this.destroyEffect(registry);
    this.port.recordDeath(activeStage, this.port.motion.state.t, 'burnup');
  }

  public despawn(simTime: number, activeStage: StageOutcome): void {
    if (!this.port.motion.alive) return;
    this.port.motion.alive = false;
    this.port.recordDeath(activeStage, simTime, 'despawn');
  }

  private attackedByBullet(
    bulletType: BulletType, damage: number, impactPoint: Vec3,
    simTime: number, activeStage: StageOutcome, registry: EntityRegistry,
  ): void {
    activeStage.scoreCounter.recordHit();
    this.port.applyBulletDamage(damage, impactPoint);
    if (this.port.hasHealth()) {
      this.impactEffect(bulletType, impactPoint);
      return;
    }
    this.port.motion.alive = false;
    this.port.recordDeath(activeStage, simTime, 'killed');
    this.destroyEffect(registry);
  }

  private impactEffect(bulletType: BulletType, impactPoint: Vec3): void {
    this.port.worldSfx.enemyHit();
    const state = kinematicState<'eci'>(this.port.motion.state.t, impactPoint, this.port.motion.state.v);
    if (bulletType === 'plasma') this.port.effects.spawnPlasmaFlash(state);
    else this.port.effects.spawnBulletFlash(state);
    this.port.effects.spawnGasPuff(state);
  }

  private damagedByContact(
    damageSpeed: number, simTime: number, cause: EnemyDeathCause,
    activeStage: StageOutcome, registry: EntityRegistry,
  ): void {
    if (!this.port.applyImpactDamage(damageSpeed)) return;
    if (this.port.hasHealth()) {
      this.port.worldSfx.clank();
      this.port.effects.spawnGasPuff(this.port.motion.state);
      return;
    }
    this.port.motion.alive = false;
    this.port.recordDeath(activeStage, simTime, cause);
    this.destroyEffect(registry);
  }

  private destroyEffect(registry: EntityRegistry): void {
    this.port.worldSfx.explosion();
    this.port.effects.spawnEnemyDestroyFlash(this.port.motion.state, this.port.modelScale);
    for (const piece of enemyDestroyFragments(
      this.port.motion.state, this.port.modelScale, this.port.worldSfx, this.port.effects,
    )) registry.add(piece);
  }
}
