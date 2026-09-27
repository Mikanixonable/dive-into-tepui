// 中心線を覆う球の列を、剛体の位置・姿勢へ当てて静止球・掃引球との接触を判定する。
// 球列は敵ローカル座標で保持し、判定のたびに姿勢で写す。
import { add, addScaled, lenSq, norm, scale, sub, v3, type Vec3 } from '../../math/vec3';
import { qInvert, qRotate, qSlerp, type Quat } from '../../math/quat';
import { kinematicState, type KinematicState } from '../../physics/kinematic-state';
import { linearSphereContact } from '../../physics/sphere-contact';
import type { SphereHit } from '../../math/triangle-mesh';

/** 判定用の球1個。中心・半径とも敵ローカル座標。 */
export interface CollisionSphere {
  readonly cx: number;
  readonly cy: number;
  readonly cz: number;
  readonly radius: number;
}

/** 球列を敵の位置・姿勢へ当てて接触を返す。個体ごとに作ってよい(球列は共有する)。 */
export class SphereChainCollisionGeometry {
  /** 全球を覆うワールド外接半径 [m]。 */
  public readonly outerRadius: number;

  // 敵ローカルの向きのまま [m] へ直した球列。姿勢を掛けるだけでワールドと比べられる。
  private readonly spheres: readonly CollisionSphere[];

  /** 敵ローカルの球列と、そこからワールドへ掛かる一様倍率を受ける。 */
  public constructor(spheres: readonly CollisionSphere[], rootScale: number) {
    this.spheres = spheres.map((sphere) => ({
      cx: sphere.cx * rootScale,
      cy: sphere.cy * rootScale,
      cz: sphere.cz * rootScale,
      radius: sphere.radius * rootScale,
    }));
    // 原点から最も遠い球面までの距離を外接半径にする
    let outerRadius = 0;
    for (const sphere of this.spheres) {
      outerRadius = Math.max(outerRadius, Math.hypot(sphere.cx, sphere.cy, sphere.cz) + sphere.radius);
    }
    this.outerRadius = outerRadius;
  }

  /** ECI 上の球と、center・att に置いた球列の最深接触を返す。触れていなければ null。 */
  public testSphereCollision(
    sphereCenter: Vec3, sphereRadius: number, center: Vec3, att: Quat,
  ): SphereHit | null {
    const offset = sub(sphereCenter, center);
    const outerReach = this.outerRadius + sphereRadius;
    if (lenSq(offset) > outerReach * outerReach) return null;

    const local = qRotate(qInvert(att), offset);
    let deepest: CollisionSphere | null = null;
    let deepestDepth = 0;
    for (const sphere of this.spheres) {
      const dx = local.x - sphere.cx;
      const dy = local.y - sphere.cy;
      const dz = local.z - sphere.cz;
      const depth = sphere.radius + sphereRadius - Math.hypot(dx, dy, dz);
      if (!(depth > deepestDepth)) continue;
      deepest = sphere;
      deepestDepth = depth;
    }
    if (deepest === null) return null;

    // 法線は球の中心から相手へ向く。中心が重なった相手では向きが定まらず、norm がゼロを返す。
    const localNormal = norm(v3(local.x - deepest.cx, local.y - deepest.cy, local.z - deepest.cz));
    const localPoint = v3(
      deepest.cx + localNormal.x * deepest.radius,
      deepest.cy + localNormal.y * deepest.radius,
      deepest.cz + localNormal.z * deepest.radius,
    );
    return {
      point: add(center, qRotate(att, localPoint)),
      normal: qRotate(att, localNormal),
      depth: deepestDepth,
    };
  }

  /**
   * 移動する球が球列を最初に横切る接触と、区間内の割合 toi を返す。始点で既に重なっていれば
   * toi は 0、区間内で横切らなければ null。
   */
  public testSweptSphereCollision(
    previousSphereCenter: Vec3, sphereCenter: Vec3, sphereRadius: number,
    previousSelfState: KinematicState, selfState: KinematicState,
    previousAttitude: Quat, attitude: Quat = previousAttitude,
  ): { readonly hit: SphereHit; readonly toi: number } | null {
    const duration = selfState.t - previousSelfState.t;
    if (!(duration > 0)) return null;

    // 始点で既に重なっているなら、跨ぎは区間の内側に無い。
    const initial = this.testSphereCollision(
      previousSphereCenter, sphereRadius, previousSelfState.r, previousAttitude,
    );
    if (initial !== null) return { hit: initial, toi: 0 };

    // 外接球で、回転しても接触し得ない経路を先に落とす。姿勢が変わるので、球列を
    // 現在姿勢へ戻してから線分距離を測ることはできない。
    const relativeStart = sub(previousSphereCenter, previousSelfState.r);
    const relativeEnd = sub(sphereCenter, selfState.r);
    if (segmentSphereDistanceSq(relativeStart, relativeEnd, { cx: 0, cy: 0, cz: 0, radius: 0 })
      > (this.outerRadius + sphereRadius) ** 2) return null;

    // 姿勢を最短経路で補間し、回転角が大きい区間は分割する。各区間の球中心は
    // 線分として幾何交差を求めるため、固定形状を現在姿勢のみで評価する近似を回避できる。
    const rotationAngle = 2 * Math.acos(Math.min(1, Math.abs(
      previousAttitude.x * attitude.x
      + previousAttitude.y * attitude.y
      + previousAttitude.z * attitude.z
      + previousAttitude.w * attitude.w,
    )));
    const segments = Math.max(1, Math.ceil(rotationAngle / (Math.PI / 12)));

    let nearest: { readonly hit: SphereHit; readonly toi: number } | null = null;
    for (let segment = 0; segment < segments; segment++) {
      const u0 = segment / segments;
      const u1 = (segment + 1) / segments;
      const segmentDuration = duration * (u1 - u0);
      const segmentStartTime = previousSelfState.t + duration * u0;
      const segmentEndTime = previousSelfState.t + duration * u1;
      const rootStart = interpolate(previousSelfState.r, selfState.r, u0);
      const rootEnd = interpolate(previousSelfState.r, selfState.r, u1);
      const otherStart = interpolate(previousSphereCenter, sphereCenter, u0);
      const otherEnd = interpolate(previousSphereCenter, sphereCenter, u1);
      const qStart = qSlerp(previousAttitude, attitude, u0);
      const qEnd = qSlerp(previousAttitude, attitude, u1);
      const sphereVelocity = scale(sub(otherEnd, otherStart), 1 / segmentDuration);
      const sweepStart = kinematicState<'eci'>(segmentStartTime, otherStart, sphereVelocity);
      const sweepEnd = kinematicState<'eci'>(segmentEndTime, otherEnd, sphereVelocity);

      for (const sphere of this.spheres) {
        const offset = v3(sphere.cx, sphere.cy, sphere.cz);
        const centerStartPosition = add(rootStart, qRotate(qStart, offset));
        const centerEndPosition = add(rootEnd, qRotate(qEnd, offset));
        const centerVelocity = scale(sub(centerEndPosition, centerStartPosition), 1 / segmentDuration);
        const centerStart = kinematicState<'eci'>(segmentStartTime, centerStartPosition, centerVelocity);
        const centerEnd = kinematicState<'eci'>(segmentEndTime, centerEndPosition, centerVelocity);
        const reach = sphere.radius + sphereRadius;
        const contact = linearSphereContact(centerStart, centerEnd, sweepStart, sweepEnd, reach);
        // 始点の重なりは上で除いてあるので、跨ぎは必ず外から内への1本。
        if (contact === null || contact.startsInside || contact.crossing === null) continue;
        const { toi, normal } = contact.crossing;
        const globalToi = u0 + (u1 - u0) * toi;
        if (nearest !== null && globalToi >= nearest.toi) continue;
        const center = interpolate(previousSelfState.r, selfState.r, globalToi);
        const hitAttitude = qSlerp(previousAttitude, attitude, globalToi);
        // TOI では2球が接するだけなので、押し戻し量は 0 になる。接触点は
        // 相手の球ではなく、球列側の球面上へ置く。
        nearest = {
          hit: {
            point: addScaled(add(center, qRotate(hitAttitude, offset)), normal, sphere.radius),
            normal,
            depth: 0,
          },
          toi: globalToi,
        };
      }
    }
    return nearest;
  }
}

// 姿勢補間に対応する位置補間。各状態は同じ時間軸上にある。
function interpolate(start: Vec3, end: Vec3, t: number): Vec3 {
  return add(start, scale(sub(end, start), t));
}

// 線分と球の中心の最短距離の2乗。
function segmentSphereDistanceSq(start: Vec3, end: Vec3, sphere: CollisionSphere): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const dz = end.z - start.z;
  const px = sphere.cx - start.x;
  const py = sphere.cy - start.y;
  const pz = sphere.cz - start.z;
  // 球の中心に最も近い線分上の点を、媒介変数 t ∈ [0, 1] で取る
  const lengthSq = dx * dx + dy * dy + dz * dz;
  const t = lengthSq > 0 ? Math.min(1, Math.max(0, (px * dx + py * dy + pz * dz) / lengthSq)) : 0;
  const qx = px - dx * t;
  const qy = py - dy * t;
  const qz = pz - dz * t;
  return qx * qx + qy * qy + qz * qz;
}
