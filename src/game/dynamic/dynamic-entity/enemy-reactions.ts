// 敵1体が被弾・接触・焼失・離脱したときのゲーム上の帰結。得点・ダメージ・撃破記録・破片と、
// 起きたことの記録をまとめる。
import { kinematicState } from '../../../physics/kinematic-state';
import { enemyDestroyFragments } from './debris-piece';
import type { DynamicMotion } from '../dynamic-motion';
import type { EntityContactParticipant } from '../dynamic-simulation-participant';
import type { EntityRegistry } from '../entity-registry';
import type { StageOutcome, EnemyDeathCause } from '../../stages/stage-outcome';
import { bulletReactionOf, type BulletType } from './bullet-reaction';
import { closingSpeed, type Contact } from './contact';
import { contactDamageSpeed } from './contact-damage';
import type { Vec3 } from '../../../math/vec3';
import type { RunEventSink } from '../../run-events';

// 帰結を受け取る敵1体のインターフェース。ダメージの適用方法と撃破の記録は個体ごとに実装する。
export interface EnemyReactionPort {
  readonly motion: DynamicMotion;
  // 破片と爆散の大きさを決める機体模型の倍率。
  readonly modelScale: number;
  // 弾によるダメージを適用する。部位を持つ個体は impactPoint から被弾部位を判定する。
  applyBulletDamage(damage: number, impactPoint: Vec3, events: RunEventSink): void;
  // 接触の相対速度によるダメージを入れる。ダメージが実際に入ったら true。
  applyImpactDamage(damageSpeed: number): boolean;
  // まだ生き残る体力が残っているか。
  hasHealth(): boolean;
  // 1体が失われたことをステージの戦果へ記録する。
  recordDeath(activeStage: StageOutcome, simTime: number, cause: EnemyDeathCause): void;
}

export class EnemyReactions {
  public constructor(private readonly port: EnemyReactionPort) {}

  // 他の個体と触れたときの帰結。弾なら被弾として、それ以外は接触の相対速度で損傷させる。
  public receiveEntityContact(
    other: EntityContactParticipant, contact: Contact, activeStage: StageOutcome, registry: EntityRegistry,
  ): void {
    if (!this.port.motion.alive) return;
    const bullet = bulletReactionOf(other);
    if (bullet !== null) {
      this.attackedByBullet(bullet.type, bullet.damage, contact.point, contact.selfState.t, activeStage, registry);
      return;
    }
    this.damagedByContact(contactDamageSpeed(other, contact), contact.selfState.t, 'killed', activeStage, registry);
  }

  // 天体の固体表面へ触れたときの帰結。接近速度で損傷させ、落とせたら衝突として記録する。
  public receiveSurfaceContact(
    contact: Contact, activeStage: StageOutcome, registry: EntityRegistry,
  ): void {
    if (!this.port.motion.alive) return;
    this.damagedByContact(closingSpeed(contact), contact.selfState.t, 'collision', activeStage, registry);
  }

  // 大気で焼失したときの帰結。撃破ではなく焼失として戦果へ残す。
  public receiveBurnUp(activeStage: StageOutcome, registry: EntityRegistry): void {
    this.port.motion.kill();
    this.recordDestroy(registry);
    this.port.recordDeath(activeStage, this.port.motion.state.t, 'burnup');
  }

  // 交戦圏を離れて消えるときの帰結。離脱として戦果へ残す。
  public despawn(simTime: number, activeStage: StageOutcome): void {
    if (!this.port.motion.alive) return;
    this.port.motion.kill();
    this.port.recordDeath(activeStage, simTime, 'despawn');
  }

  // 弾が当たったときの帰結。命中を戦果へ数え、体力が尽きれば撃破として落とす。
  private attackedByBullet(
    bulletType: BulletType, damage: number, impactPoint: Vec3,
    simTime: number, activeStage: StageOutcome, registry: EntityRegistry,
  ): void {
    activeStage.recordHit();
    this.port.applyBulletDamage(damage, impactPoint, registry.events);
    if (this.port.hasHealth()) {
      this.recordImpact(bulletType, impactPoint, registry);
      return;
    }
    this.port.motion.kill();
    this.port.recordDeath(activeStage, simTime, 'killed');
    this.recordDestroy(registry);
  }

  // 被弾を、着弾点と機体の速度を持つ出来事として記録する。
  private recordImpact(bulletType: BulletType, impactPoint: Vec3, registry: EntityRegistry): void {
    registry.events.record({
      kind: 'enemyStruckByBullet',
      bullet: bulletType,
      state: kinematicState<'eci'>(
        this.port.motion.state.t, impactPoint, this.port.motion.state.v),
    });
  }

  // 接触で損傷したときの帰結。ダメージが入らなければ何も起きない。cause は落ちたときの死因。
  private damagedByContact(
    damageSpeed: number, simTime: number, cause: EnemyDeathCause,
    activeStage: StageOutcome, registry: EntityRegistry,
  ): void {
    if (!this.port.applyImpactDamage(damageSpeed)) return;
    if (this.port.hasHealth()) {
      registry.events.record({ kind: 'enemyDamagedByContact', state: this.port.motion.state });
      return;
    }
    this.port.motion.kill();
    this.port.recordDeath(activeStage, simTime, cause);
    this.recordDestroy(registry);
  }

  // 爆散を記録し、機体模型の倍率に見合った破片を registry へ足す。
  private recordDestroy(registry: EntityRegistry): void {
    registry.events.record({
      kind: 'shipExploded', state: this.port.motion.state, modelScale: this.port.modelScale,
    });
    for (const piece of enemyDestroyFragments(
      this.port.motion.state, this.port.modelScale, registry.idAllocators,
    )) registry.add(piece);
  }
}
