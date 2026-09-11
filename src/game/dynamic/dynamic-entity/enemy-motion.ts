import type { Attitude } from '../../../physics/attitude';
import type { CelestialBody } from '../../../physics/celestial-body';
import type { KinematicState } from '../../../physics/kinematic-state';
import { DynamicMotion, type DynamicMotionBehavior } from '../dynamic-motion';
import type { DynamicReactionServices } from '../dynamic-simulation-participant';
import type { Contact } from './contact';
import { shipMotionOptions } from './ship';

// 敵機は熱防御を持たないので、自機より低い温度で構造が保たなくなる。
const ENEMY_MAX_TEMP = 500; // [K]
const ENEMY_MASS = 10000; // [kg]

// 敵機の接触・焼失の結果を受け取る先。
interface EnemyMotionReactions {
  receiveEntityContact(
    other: DynamicMotion, contact: Contact, services: DynamicReactionServices,
  ): void;
  receiveSurfaceContact(contact: Contact, services: DynamicReactionServices): void;
  receiveBurnUp(services: DynamicReactionServices): void;
}

// 半径の球に代えて敵機に当てる判定形状。
export type EnemyCollisionShape = Pick<
  DynamicMotionBehavior,
  'testSphereCollision' | 'testSweptSphereCollision'
>;

// 敵機の接触・焼失を reactions へ通知する振る舞い。
class EnemyBehavior implements DynamicMotionBehavior {
  public readonly contactKind = 'enemy';
  public readonly testSphereCollision: DynamicMotionBehavior['testSphereCollision'];
  public readonly testSweptSphereCollision: DynamicMotionBehavior['testSweptSphereCollision'];

  // shape を省くと、判定は Motion の半径の球になる。
  public constructor(
    private readonly reactions: EnemyMotionReactions,
    shape?: EnemyCollisionShape,
  ) {
    this.testSphereCollision = shape?.testSphereCollision;
    this.testSweptSphereCollision = shape?.testSweptSphereCollision;
  }

  // 他の個体との接触を reactions へ渡す。
  public onEntityContact(
    _self: DynamicMotion, other: DynamicMotion, contact: Contact, services: DynamicReactionServices,
  ): void {
    this.reactions.receiveEntityContact(other, contact, services);
  }

  // 天体表面への接触を reactions へ渡す。
  public onSurfaceContact(
    _self: DynamicMotion, _body: CelestialBody, contact: Contact, services: DynamicReactionServices,
  ): void {
    this.reactions.receiveSurfaceContact(contact, services);
  }

  // 温度上限を超えた焼失を reactions へ渡す。
  public onBurnUp(_self: DynamicMotion, services: DynamicReactionServices): void {
    this.reactions.receiveBurnUp(services);
  }
}

// 敵機の軌道・姿勢・物性・判定形状を所有し、ゲーム上の接触結果を注入先へ通知する。
export class EnemyMotion extends DynamicMotion {
  // shape を省くと、判定は半径 radius の球になる。
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
