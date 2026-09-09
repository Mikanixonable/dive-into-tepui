import type * as THREE from 'three/webgpu';
import type { KinematicState } from '../../../physics/kinematic-state';
import type { WorldSfx } from '../../../audio/sfx/world-sfx';
import { DynamicEntity } from './dynamic-entity';
import { BulletView } from './bullet-view';
import type { BulletType, Shooter } from './bullet-reaction';
import { BulletMotion } from './bullet-motion';

export class Bullet extends DynamicEntity {
  public override readonly capKind = 'bullet';

  public constructor(
    state: KinematicState, lifetime: number, shooter: Shooter, type: BulletType, damage: number,
    worldSfx: WorldSfx, _scene?: THREE.Scene,
  ) {
    super(
      state,
      new BulletView(type === 'plasma'),
      undefined,
      undefined,
      () => new BulletMotion(state, lifetime, shooter, type, damage, worldSfx),
    );
  }
}

export function isBullet(entity: DynamicEntity): entity is Bullet {
  return entity instanceof Bullet;
}
