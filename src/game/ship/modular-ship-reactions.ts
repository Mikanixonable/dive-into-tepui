// モジュール船の接触・被弾・構造喪失・焼失の帰結を所有する。船体の構造と寿命を持つ
// ModularShip から、接触結果を assembly と演出へ適用する状態機械を分離する。
import { bulletReactionOf, type BulletType } from '../dynamic/dynamic-entity/bullet-reaction';
import { closingSpeed, type Contact } from '../dynamic/dynamic-entity/contact';
import { collisionDamageFraction, contactDamageSpeed } from '../dynamic/dynamic-entity/contact-damage';
import type { DynamicReactionServices, EntityContactParticipant } from '../dynamic/dynamic-simulation-participant';
import type { ModularShipMotion } from './modular-ship-motion';
import type { ShipAssembly } from './ship-assembly';
import type { PlayerEffects } from '../player/player-effects';

const RADIATOR_BULLET_DAMAGE = 0.25;
const BULLET_IMPACT_HEAT = 3.0e5;

export interface ModularShipReactionPort {
  readonly motion: ModularShipMotion;
  readonly assembly: ShipAssembly;
  readonly effects: PlayerEffects;
  syncAfterDamage(): void;
}

export class ModularShipReactions {
  public constructor(private readonly port: ModularShipReactionPort) {}

  public receiveEntityContact(
    other: EntityContactParticipant, contact: Contact, _services: DynamicReactionServices,
  ): void {
    if (!this.port.motion.alive) return;
    const bullet = bulletReactionOf(other);
    if (bullet !== null) {
      this.attackedByBullet(bullet.type, bullet.damage, contact.point);
      return;
    }
    this.damagedByContact(contactDamageSpeed(other, contact), null);
  }

  public receiveSurfaceContact(
    _body: unknown, contact: Contact, _services: DynamicReactionServices,
  ): void {
    if (!this.port.motion.alive) return;
    this.damagedByContact(closingSpeed(contact), null);
  }

  public receiveRadiatorContact(
    moduleId: string, other: EntityContactParticipant, contact: Contact, _services: DynamicReactionServices,
  ): void {
    if (!this.port.motion.alive) return;
    const bullet = bulletReactionOf(other);
    if (bullet !== null) {
      this.attackedByBullet(bullet.type, bullet.damage, contact.point, moduleId);
      return;
    }
    this.damagedByContact(contactDamageSpeed(other, contact), moduleId);
  }

  public receiveStructuralLoss(services: DynamicReactionServices): void {
    if (!this.port.motion.alive) return;
    this.lose('動圧が構造限界を超え、機体は空力的に分解した', services);
  }

  public receiveBurnUp(services: DynamicReactionServices): void {
    this.lose(
      this.port.motion.aero.heatingAerodynamically
        ? '断熱圧縮による加熱で熱防御が飽和し、機体は焼失した'
        : '排熱が追いつかず、機体は熱で機能不全に陥った',
      services,
    );
  }

  private attackedByBullet(
    bulletType: BulletType, damage: number, impactPoint: Contact['point'], radiatorId: string | null = null,
  ): void {
    this.port.motion.absorbHeat(BULLET_IMPACT_HEAT / Math.max(this.port.motion.mass, 1e-9));
    const radiator = radiatorId === null ? null : this.port.assembly.module(radiatorId);
    const targetId = radiator?.kind === 'radiator' ? radiator.id : null;
    this.damageAssembly(radiatorId === null ? damage : RADIATOR_BULLET_DAMAGE, targetId);
    this.breakRadiatorIfDestroyed(radiatorId, radiator);
    this.port.effects.impact(bulletType, this.port.motion.state, impactPoint);
  }

  private damagedByContact(damageSpeed: number, radiatorId: string | null): void {
    const fraction = collisionDamageFraction(damageSpeed);
    if (fraction <= 0) return;
    const radiator = radiatorId === null ? null : this.port.assembly.module(radiatorId);
    const targetId = radiator?.kind === 'radiator' ? radiator.id : null;
    this.damageAssembly(this.port.assembly.maxHp * fraction, targetId);
    this.breakRadiatorIfDestroyed(radiatorId, radiator);
    this.port.effects.contact(this.port.motion.state);
  }

  private damageAssembly(amount: number, targetModuleId: string | null): void {
    this.port.assembly.damage(amount, Math.floor(Math.random() * 0x1_0000_0000), targetModuleId);
    this.port.syncAfterDamage();
  }

  private breakRadiatorIfDestroyed(
    radiatorId: string | null, radiator: ReturnType<ShipAssembly['module']>,
  ): void {
    if (radiatorId === null || radiator?.kind !== 'radiator') return;
    if ((this.port.assembly.module(radiator.id)?.hp ?? 0) <= 0) {
      const tip = this.port.motion.radiator.tipWorldPosition(
        radiator.id, this.port.motion.state.r, this.port.motion.att,
      );
      this.port.effects.radiatorBreak(this.port.motion.state, tip);
    }
  }

  private lose(reason: string, services: DynamicReactionServices): void {
    this.port.motion.kill();
    this.port.effects.destroy(this.port.motion.state);
    services.activeStage.recordPlayerLost(reason);
  }
}
