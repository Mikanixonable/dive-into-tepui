import type { Attitude } from '../../../physics/attitude';
import type { CelestialBody } from '../../../physics/celestial-body';
import type { KinematicState } from '../../../physics/kinematic-state';
import { DynamicMotion, type DynamicMotionBehavior, type DynamicMotionThermal } from '../dynamic-motion';
import type { DynamicReactionServices, EntityContactParticipant } from '../dynamic-simulation-participant';
import type { Contact } from './contact';
import { shipMotionProperties } from './combat-ship-entity';

// 現在の敵機が共通して使う物性。質量 [kg]、構造が保たれる上限温度 [K]。
const ENEMY_MOTION_PROFILE = Object.freeze({
  mass: 10000,
  maxTemperature: 500,
});

// 敵機の接触・焼失の結果を受け取る先。
interface EnemyMotionReactions {
  receiveEntityContact(
    other: EntityContactParticipant, contact: Contact, services: DynamicReactionServices,
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

  // shape が null なら、判定は Motion の半径の球になる。
  public constructor(
    private readonly reactions: EnemyMotionReactions,
    shape: EnemyCollisionShape | null,
  ) {
    this.testSphereCollision = shape?.testSphereCollision;
    this.testSweptSphereCollision = shape?.testSweptSphereCollision;
  }

  // 他の個体との接触を reactions へ渡す。
  public onEntityContact(
    _self: DynamicMotion, other: EntityContactParticipant, contact: Contact, services: DynamicReactionServices,
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
  // shape が null なら、判定は半径 radius の球になる。thermal は熱の状態で、省くと環境温度から始める。
  // alive は生死で、省くと生きた機体として始める。
  public constructor(
    state: KinematicState,
    attitude: Attitude,
    radius: number,
    reactions: EnemyMotionReactions,
    shape: EnemyCollisionShape | null,
    thermal?: DynamicMotionThermal,
    alive?: boolean,
  ) {
    super(state, shipMotionProperties(attitude, radius, {
      alive,
      mass: ENEMY_MOTION_PROFILE.mass,
      collides: true,
      preciseReentry: true,
      ...thermal,
      maxTemperature: ENEMY_MOTION_PROFILE.maxTemperature,
      behavior: new EnemyBehavior(reactions, shape),
    }));
  }
}
