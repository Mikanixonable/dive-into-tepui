import type { KinematicState } from '../../../physics/kinematic-state';
import { DynamicMotion } from '../dynamic-motion';
import type { BulletReaction } from './bullet-reaction';

const BULLET_BCINV = 2e-4; // [m^2/kg]
const BULLET_MASS = 0.1; // [kg]
const BULLET_RADIUS = 0.02; // [m]

// 弾の飛翔・接触形状・寿命境界と、命中後の反応を一体として所有する。
export class BulletMotion extends DynamicMotion {
  // state から飛ぶ弾を、reaction が決める当たる相手と寿命で組む。
  public constructor(
    state: KinematicState,
    public readonly reaction: BulletReaction,
  ) {
    super(state, {
      hasAttitude: false,
      mass: BULLET_MASS,
      radius: BULLET_RADIUS,
      collides: true,
      bcInv: BULLET_BCINV,
      behavior: reaction,
    });
  }
}
