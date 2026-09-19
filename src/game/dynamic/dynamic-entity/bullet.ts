import { deserializeKinematicState, type KinematicState } from '../../../physics/kinematic-state';
import { DynamicEntity, type SerializedDynamicEntityFields } from './dynamic-entity';
import type { EntityIdAllocators } from './entity-id';
import type { EntityRegistry } from '../entity-registry';
import { NormalBulletView, PlasmaBulletView } from '../../../render/dynamic/dynamic-entity/bullet-view';
import {
  BulletReaction, type BulletType, type SerializedBulletReaction, type Shooter,
} from './bullet-reaction';
import { BulletMotion } from './bullet-motion';

// 弾1発の直列化した形。弾は姿勢を持たないので、q・w は意味を持たない。
export interface SerializedBullet extends SerializedDynamicEntityFields {
  readonly kind: 'bullet';
  readonly reaction: SerializedBulletReaction;
}

export class Bullet extends DynamicEntity {
  public static readonly kind = 'bullet';
  public static spawnGate(): null { return null; }

  public override readonly capKind = 'bullet';
  public declare readonly motion: BulletMotion;

  // state から飛ぶ弾1発を、reaction が決める弾種・当たる相手・寿命で組む。id は採番器が配った識別子、
  // alive は生死。
  private constructor(state: KinematicState, reaction: BulletReaction, id: string, alive?: boolean) {
    super(
      () => new BulletMotion(state, reaction, alive),
      reaction.type === 'plasma' ? new PlasmaBulletView() : new NormalBulletView(),
      id,
    );
  }

  // shooter が撃った type の弾1発を、state の瞬間から lifetime [sim s] だけ飛ぶ個体として新しく組む。
  // damage は命中した相手へ与えるダメージ [HP]。
  public static create(
    state: KinematicState, lifetime: number, shooter: Shooter, type: BulletType, damage: number,
    idAllocators: EntityIdAllocators,
  ): Bullet {
    return new Bullet(
      state, new BulletReaction(state.t, lifetime, shooter, type, damage), idAllocators.entity.next(),
    );
  }

  // 直列化した弾を、記録した時刻の状態として復元する。
  public static deserialize(serialized: SerializedBullet, registry: EntityRegistry): Bullet {
    return new Bullet(
      deserializeKinematicState(serialized),
      BulletReaction.deserialize(serialized.reaction),
      registry.idAllocators.entity.next(serialized.id),
      serialized.alive,
    );
  }

  // 運動状態と、当たる相手・寿命の判定に要る値を直列化した形へ変換する。
  public override serialize(): SerializedBullet {
    return {
      ...this.serializeEntityFields(Bullet.kind),
      reaction: this.motion.reaction.serialize(),
    };
  }
}

// entity を弾へ絞り込む型ガード。
export function isBullet(entity: DynamicEntity): entity is Bullet {
  return entity instanceof Bullet;
}
