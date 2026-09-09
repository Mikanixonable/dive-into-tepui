import type { KinematicState } from '../../../physics/kinematic-state';
import type { WorldSfx } from '../../../audio/sfx/world-sfx';
import { DynamicEntity } from './dynamic-entity';
import { NormalBulletView, PlasmaBulletView } from './bullet-view';
import { BulletReaction, type BulletType, type Shooter } from './bullet-reaction';
import { BulletMotion } from './bullet-motion';

export class Bullet extends DynamicEntity {
  public override readonly capKind = 'bullet';

  public constructor(
    state: KinematicState, lifetime: number, shooter: Shooter, type: BulletType, damage: number,
    worldSfx: WorldSfx,
  ) {
    super(
      state,
      type === 'plasma' ? new PlasmaBulletView() : new NormalBulletView(),
      undefined,
      undefined,
      () => new BulletMotion(
        state,
        new BulletReaction(state.t, lifetime, shooter, type, damage, worldSfx),
      ),
    );
  }
}

export function isBullet(entity: DynamicEntity): entity is Bullet {
  return entity instanceof Bullet;
}
