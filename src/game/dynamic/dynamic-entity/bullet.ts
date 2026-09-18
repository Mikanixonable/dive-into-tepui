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

  // shooter が撃った type の弾1発を、state から lifetime [sim s] だけ飛ぶ個体として組む。
  // damage は命中した相手へ与えるダメージ [HP]。bornSim は発射時刻 [sim s]、passedClose は交戦圏の
  // 中心の近くを通ったことを記録済みか、id は採番器が配った識別子で、省けば state の瞬間に撃った弾になる。
  public constructor(
    state: KinematicState, lifetime: number, shooter: Shooter, type: BulletType, damage: number,
    idAllocators: EntityIdAllocators,
    bornSim = state.t,
    passedClose = false,
    id?: string,
  ) {
    super(
      () => new BulletMotion(
        state,
        new BulletReaction(bornSim, lifetime, shooter, type, damage, passedClose),
      ),
      type === 'plasma' ? new PlasmaBulletView() : new NormalBulletView(),
      idAllocators.entity.next(id),
    );
  }

  // 直列化した弾を、記録した時刻の状態として復元する。
  public static deserialize(serialized: SerializedBullet, registry: EntityRegistry): Bullet {
    const { bornSim, lifetime, shooter, type, damage, passedClose } = serialized.reaction;
    return new Bullet(
      deserializeKinematicState(serialized), lifetime, shooter, type, damage, registry.idAllocators,
      bornSim, passedClose, serialized.id,
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
