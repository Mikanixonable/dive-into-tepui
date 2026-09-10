import type { Attitude } from '../../../physics/attitude';
import type { CelestialBody } from '../../../physics/celestial-body';
import type { KinematicState } from '../../../physics/kinematic-state';
import {
  DynamicMotion,
  type DynamicMotionBehavior,
  type DynamicReactionServices,
} from '../dynamic-motion';
import type { Contact } from './contact';
import { shipMotionOptions } from './ship';

const ENEMY_MAX_TEMP = 500; // [K]
const ENEMY_MASS = 10000; // [kg]

interface EnemyMotionReactions {
  receiveEntityContact(
    other: DynamicMotion, contact: Contact, context: DynamicReactionServices,
  ): void;
  receiveSurfaceContact(contact: Contact, context: DynamicReactionServices): void;
  receiveBurnUp(context: DynamicReactionServices): void;
}

export type EnemyCollisionShape = Pick<
  DynamicMotionBehavior,
  'testSphereCollision' | 'testSweptSphereCollision'
>;

class EnemyBehavior implements DynamicMotionBehavior {
  public readonly contactKind = 'enemy';
  public readonly testSphereCollision: DynamicMotionBehavior['testSphereCollision'];
  public readonly testSweptSphereCollision: DynamicMotionBehavior['testSweptSphereCollision'];

  public constructor(
    private readonly reactions: EnemyMotionReactions,
    shape?: EnemyCollisionShape,
  ) {
    this.testSphereCollision = shape?.testSphereCollision;
    this.testSweptSphereCollision = shape?.testSweptSphereCollision;
  }

  public onEntityContact(
    _self: DynamicMotion, other: DynamicMotion, contact: Contact, context: DynamicReactionServices,
  ): void {
    this.reactions.receiveEntityContact(other, contact, context);
  }

  public onSurfaceContact(
    _self: DynamicMotion, _body: CelestialBody, contact: Contact, context: DynamicReactionServices,
  ): void {
    this.reactions.receiveSurfaceContact(contact, context);
  }

  public onBurnUp(_self: DynamicMotion, context: DynamicReactionServices): void {
    this.reactions.receiveBurnUp(context);
  }
}

// 敵機の軌道・姿勢・物性・判定形状を所有し、ゲーム上の接触結果だけを注入先へ通知する。
export class EnemyMotion extends DynamicMotion {
  public constructor(
    state: KinematicState,
    attitude: Attitude,
    radius: number,
    reactions: EnemyMotionReactions,
    shape?: EnemyCollisionShape,
  ) {
    super(state, shipMotionOptions(attitude, radius, {
      mass: ENEMY_MASS,
      collides: true,
      preciseReentry: true,
      maxTemperature: ENEMY_MAX_TEMP,
      behavior: new EnemyBehavior(reactions, shape),
    }));
  }
}
