import type { KinematicState } from '../../../physics/kinematic-state';
import { DynamicEntity } from './dynamic-entity';
import type { EntityIdAllocators } from './entity-id';
import { NormalBulletView, PlasmaBulletView } from '../../../render/dynamic/dynamic-entity/bullet-view';
import { BulletReaction, type BulletType, type Shooter } from './bullet-reaction';
import { BulletMotion } from './bullet-motion';

export class Bullet extends DynamicEntity {
  public override readonly capKind = 'bullet';

  // shooter が撃った type の弾1発を、state から lifetime [sim s] だけ飛ぶ個体として組む。
  // damage は命中した相手へ与えるダメージ [HP]。
  public constructor(
    state: KinematicState, lifetime: number, shooter: Shooter, type: BulletType, damage: number,
    idAllocators: EntityIdAllocators,
  ) {
    super(
      () => new BulletMotion(
        state,
        new BulletReaction(state.t, lifetime, shooter, type, damage),
      ),
      type === 'plasma' ? new PlasmaBulletView() : new NormalBulletView(),
      idAllocators.entity.next(),
    );
  }
}

// entity を弾へ絞り込む型ガード。
export function isBullet(entity: DynamicEntity): entity is Bullet {
  return entity instanceof Bullet;
}
