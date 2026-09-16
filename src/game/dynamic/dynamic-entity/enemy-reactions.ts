import { kinematicState } from '../../../physics/kinematic-state';
import { enemyDestroyFragments } from './debris-piece';
import type { DynamicMotion } from '../dynamic-motion';
import type { EntityRegistry } from '../entity-registry';
import type { StageOutcome, EnemyDeathCause } from '../../stages/stage-outcome';
import { bulletReactionOf, type BulletType } from './bullet-reaction';
import { closingSpeed, type Contact } from './contact';
import { contactDamageSpeed } from './contact-damage';
import type { Vec3 } from '../../../math/vec3';
import type { RunEventSink } from '../../run-events';

export interface EnemyReactionPort {
  readonly motion: DynamicMotion;
  readonly modelScale: number;
  applyBulletDamage(damage: number, impactPoint: Vec3, events: RunEventSink): void;
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
    this.recordDestroy(registry);
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
    this.port.applyBulletDamage(damage, impactPoint, registry.events);
    if (this.port.hasHealth()) {
      this.recordImpact(bulletType, impactPoint, registry);
      return;
    }
    this.port.motion.alive = false;
    this.port.recordDeath(activeStage, simTime, 'killed');
    this.recordDestroy(registry);
  }

  private recordImpact(bulletType: BulletType, impactPoint: Vec3, registry: EntityRegistry): void {
    registry.events.record({
      kind: 'enemyStruckByBullet',
      bullet: bulletType,
      state: kinematicState<'eci'>(
        this.port.motion.state.t, impactPoint, this.port.motion.state.v),
    });
  }

  private damagedByContact(
    damageSpeed: number, simTime: number, cause: EnemyDeathCause,
    activeStage: StageOutcome, registry: EntityRegistry,
  ): void {
    if (!this.port.applyImpactDamage(damageSpeed)) return;
    if (this.port.hasHealth()) {
      registry.events.record({ kind: 'enemyDamagedByContact', state: this.port.motion.state });
      return;
    }
    this.port.motion.alive = false;
    this.port.recordDeath(activeStage, simTime, cause);
    this.recordDestroy(registry);
  }

  private recordDestroy(registry: EntityRegistry): void {
    registry.events.record({
      kind: 'shipExploded', state: this.port.motion.state, modelScale: this.port.modelScale,
    });
    for (const piece of enemyDestroyFragments(
      this.port.motion.state, this.port.modelScale, registry.idAllocators,
    )) registry.add(piece);
  }
}
