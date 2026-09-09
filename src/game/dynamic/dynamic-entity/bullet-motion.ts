import type { WorldSfx } from '../../../audio/sfx/world-sfx';
import type { KinematicState } from '../../../physics/kinematic-state';
import { DynamicMotion } from '../dynamic-motion';
import { BulletReaction, type BulletType, type Shooter } from './bullet-reaction';

const BULLET_BCINV = 2e-4;
const BULLET_MASS = 0.1;
const BULLET_RADIUS = 0.02;

// 弾の飛翔・接触形状・寿命境界と、命中後の反応を一体として所有する。
export class BulletMotion extends DynamicMotion {
  public constructor(
    state: KinematicState,
    lifetime: number,
    shooter: Shooter,
    type: BulletType,
    damage: number,
    worldSfx: WorldSfx,
  ) {
    super(state, {
      hasAttitude: false,
      mass: BULLET_MASS,
      radius: BULLET_RADIUS,
      collides: true,
      bcInv: BULLET_BCINV,
      behavior: new BulletReaction(state.t, lifetime, shooter, type, damage, worldSfx),
    });
  }
}
