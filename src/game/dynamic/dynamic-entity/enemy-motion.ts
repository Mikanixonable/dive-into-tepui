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

// アセット座標を物理寸法へ直す倍率。描画も同じ値を読むが、物理形状の正本はこのモジュールに置く。
export const ENEMY_MODEL_SCALE = 20;

// 各金属機体モデルを ENEMY_MODEL_SCALE 倍したときの外接球半径 [m]。描画テストでアセットの
// bounds と一致することを固定し、実行時の物理構築が THREE のモデル生成へ依存しないようにする。
const DRIFTING_COLLISION_RADIUS = 67.1935257886386;
const TYPED_COLLISION_RADII = [
  93.8906797184146,
  91.58602476518524,
  86.22292463258124,
] as const;

export function metalEnemyCollisionRadius(typeIndex: number | null): number {
  if (typeIndex === null) return DRIFTING_COLLISION_RADIUS;
  return TYPED_COLLISION_RADII[typeIndex] ?? TYPED_COLLISION_RADII[0];
}

export interface EnemyMotionReactions {
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
