import { qInvert, qRotate } from '../../../math/quat';
import type { Ray } from '../../../math/ray';
import { add, len, sub, type Vec3 } from '../../../math/vec3';
import type { Attitude } from '../../../physics/attitude';
import type { KinematicState } from '../../../physics/kinematic-state';
import type { SphereHit } from '../../../math/triangle-mesh';
import { DEFAULT_HISTORY_DURATION } from '../predicted-arc';
import { DynamicMotion, type DynamicMotionBehavior } from '../dynamic-motion';
import { BASE_COLLISION_RADIUS, baseRaycast, baseSphereCollide } from './base-collision';

const BASE_THRUST = 4e8; // 総推力 [N]
const BASE_MAX_FUEL = 50000; // 最大燃料 [kg]

class BaseCollisionBehavior implements DynamicMotionBehavior {
  public readonly contactKind = 'base';

  // 基地は接触で押されない。
  public contactMass(_self: DynamicMotion): number {
    return Infinity;
  }

  // 外接球を通ったレイを基地の衝突メッシュで絞り込む。
  public hitBodyByRay(self: DynamicMotion, ray: Ray, pos: Vec3): boolean {
    const toLocal = qInvert(self.att.q);
    const reach = len(sub(pos, ray.origin)) + self.radius;
    return baseRaycast(
      qRotate(toLocal, sub(ray.origin, pos)), qRotate(toLocal, ray.dir), reach,
    ) !== null;
  }

  // ワールド座標の球と基地の衝突メッシュとの接触を返す。
  public testSphereCollision(
    self: DynamicMotion,
    sphereCenter: Vec3,
    sphereRadius: number,
    selfState: KinematicState,
  ): SphereHit | null {
    const toLocal = qInvert(self.att.q);
    const hit = baseSphereCollide(
      qRotate(toLocal, sub(sphereCenter, selfState.r)), sphereRadius,
    );
    return hit === null ? null : {
      point: add(selfState.r, qRotate(self.att.q, hit.point)),
      normal: qRotate(self.att.q, hit.normal),
      depth: hit.depth,
    };
  }
}

// 基地の軌道、姿勢、剛体形状、推進剤を管理する。
export class BaseMotion extends DynamicMotion {
  private fuelValue: number;

  public constructor(state: KinematicState, attitude: Attitude, fuel = BASE_MAX_FUEL) {
    super(state, {
      attitude,
      mass: 3e6,
      radius: BASE_COLLISION_RADIUS,
      collides: true,
      engagementAnchor: true,
      historyDuration: DEFAULT_HISTORY_DURATION,
      predictedForGhost: true,
      behavior: new BaseCollisionBehavior(),
    });
    this.fuelValue = fuel;
  }

  public get fuel(): number { return this.fuelValue; }
  public get maxFuel(): number { return BASE_MAX_FUEL; }
  public get maximumAcceleration(): number { return BASE_THRUST / this.mass; }

  // 要求量を残量の範囲で消費し、満たせた割合を返す。
  public consumeFuel(amount: number): number {
    if (amount <= 0) return 1;
    const consumed = Math.min(this.fuelValue, amount);
    this.fuelValue -= consumed;
    return consumed / amount;
  }
}
