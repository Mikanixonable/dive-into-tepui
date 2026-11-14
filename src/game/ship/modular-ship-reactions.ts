// モジュール船の接触・被弾・構造喪失・焼失の帰結を所有する。船体の構造と寿命を持つ
// ModularShip から、接触結果を assembly と演出へ適用する状態機械を分離する。
import { bulletReactionOf, type BulletType } from '../dynamic/dynamic-entity/bullet-reaction';
import type { Contact } from '../dynamic/dynamic-entity/contact';
import { collisionDamageFraction, contactDamageSpeed } from '../dynamic/dynamic-entity/contact-damage';
import type { DynamicReactionServices, EntityContactParticipant } from '../dynamic/dynamic-simulation-participant';
import type { ModularShipMotion } from './modular-ship-motion';
import type { ShipAssembly } from './ship-assembly';
import type { PlayerEffects } from '../player/player-effects';
import type { PlayerLossCause } from '../stages/stage-outcome';

// 展開中の放熱板に当たった1発が放熱板パーツへ与えるダメージ [HP]。薄く大きい構造物なので
// 船体への直撃より軽い。
const RADIATOR_BULLET_DAMAGE = 0.25;
// 被弾の着弾熱 [J]。
const BULLET_IMPACT_HEAT = 3.0e5;

export interface ModularShipReactionPort {
  readonly motion: ModularShipMotion;
  readonly assembly: ShipAssembly;
  readonly effects: PlayerEffects;
  syncAfterDamage(): void;
}

export class ModularShipReactions {
  public constructor(private readonly port: ModularShipReactionPort) {}

  // 他実体との接触を受け取り、被弾と衝突へ振り分ける。死後の接触は捨てる。
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

  // 天体の固体表面への到達は、接近速度によらず機体喪失(ORBIT.md「接触判定」)。
  public receiveSurfaceContact(
    _body: unknown, _contact: Contact, services: DynamicReactionServices,
  ): void {
    if (!this.port.motion.alive) return;
    this.lose('天体の地表へ到達し機体は失われた', 'surface', services);
  }

  // 展開中の放熱板パーツへの接触を受け取り、被弾と衝突へ振り分ける。死後の接触は捨てる。
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

  // 構造限界超過の通知を受け、機体喪失として処理する。死後の通知は捨てる。
  public receiveStructuralLoss(services: DynamicReactionServices): void {
    if (!this.port.motion.alive) return;
    this.lose('動圧が構造限界を超え、機体は空力的に分解した', 'structural', services);
  }

  // 焼失の通知を受け、機体喪失として処理する。原因は空力加熱か排熱不足かで分ける。
  public receiveBurnUp(services: DynamicReactionServices): void {
    const aerodynamic = this.port.motion.aero.heatingAerodynamically;
    this.lose(
      aerodynamic
        ? '断熱圧縮による加熱で熱防御が飽和し、機体は焼失した'
        : '排熱が追いつかず、機体は熱で機能不全に陥った',
      aerodynamic ? 'heatSaturated' : 'heatOverload',
      services,
    );
  }

  // 被弾の帰結: 着弾熱の吸収、assembly へのダメージ、放熱板の破断と着弾演出。
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

  // 衝突速度に応じた割合ぶんのダメージを assembly へ与え、接触演出を出す。
  private damagedByContact(damageSpeed: number, radiatorId: string | null): void {
    const fraction = collisionDamageFraction(damageSpeed);
    if (fraction <= 0) return;
    const radiator = radiatorId === null ? null : this.port.assembly.module(radiatorId);
    const targetId = radiator?.kind === 'radiator' ? radiator.id : null;
    this.damageAssembly(this.port.assembly.maxHp * fraction, targetId);
    this.breakRadiatorIfDestroyed(radiatorId, radiator);
    this.port.effects.contact(this.port.motion.state);
  }

  // assembly へ damage を与えて派生状態を同期する。対象は targetModuleId か乱択。
  private damageAssembly(amount: number, targetModuleId: string | null): void {
    this.port.assembly.damage(amount, Math.floor(Math.random() * 0x1_0000_0000), targetModuleId);
    this.port.syncAfterDamage();
  }

  // 対象の放熱板が破壊されていれば、先端での破断演出を出す。
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

  // 機体を失わせ、原因を添えて周回の敗北として記録する。
  private lose(reason: string, cause: PlayerLossCause, services: DynamicReactionServices): void {
    this.port.motion.kill();
    this.port.effects.destroy(this.port.motion.state);
    services.activeStage.recordPlayerLost(reason, cause);
  }
}
