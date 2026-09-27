// 組み立て型の敵の接触判定。各部品の中心線折れ線を球の列で覆い、静止球・掃引球との接触を
// 球列ジオメトリへ委譲する。失われた部品は判定から取り除く。
import { addScaled, distSq, dot, len, lenSq, sub, type Vec3 } from '../../math/vec3';
import type { Quat } from '../../math/quat';
import type { KinematicState } from '../../physics/kinematic-state';
import type { SphereHit } from '../../math/triangle-mesh';
import {
  SphereChainCollisionGeometry, type CollisionSphere,
} from '../dynamic/sphere-chain-collision';
import type { AssemblyPartDef } from '../../render/assembly/assembly-shape';

// 球を置く間隔(部品の半径に対する比率)。中心線は管を覆うには過密なので間引くが、
// 間隔が球径を超えると中心線の途中が覆われなくなるので、1 未満に取る。
const SPHERE_SPACING_RATIO = 0.8;

export class AssemblyCollision {
  // 生成時の全部品を覆う外接半径 [m]。部品の喪失では変えない。
  public readonly outerRadius: number;

  // part.index 順の、部品ごとの球列(敵ローカル座標)。
  private readonly spheresByPart: readonly (readonly CollisionSphere[])[];
  // part.index 順の、判定から外した部品。
  private readonly excluded: boolean[];
  private geometry: SphereChainCollisionGeometry;

  public constructor(private readonly parts: readonly AssemblyPartDef[]) {
    const spheresByPart: (readonly CollisionSphere[])[] = parts.map(() => []);
    let outerRadius = 0;
    for (const part of parts) {
      spheresByPart[part.index] = spheresAlong(part);
      for (const vertex of part.centerline) {
        outerRadius = Math.max(outerRadius, len(vertex) + part.radius);
      }
    }
    this.spheresByPart = spheresByPart;
    this.excluded = parts.map(() => false);
    this.outerRadius = outerRadius;
    this.geometry = this.buildGeometry();
  }

  // index の部品を判定から恒久的に外す。既に外れた部品へは何もしない。
  public excludePart(index: number): void {
    if (this.excluded[index]) return;
    this.excluded[index] = true;
    this.geometry = this.buildGeometry();
  }

  // ローカル座標の点に最も近い生存部品の index。距離は中心線ではなく管表面までで比べる。
  // 生存部品が無ければ null。
  public partAt(localPoint: Vec3): number | null {
    let nearest: number | null = null;
    let nearestDistance = Infinity;
    for (const part of this.parts) {
      if (this.excluded[part.index]) continue;
      const distance = centerlineDistance(localPoint, part.centerline) - part.radius;
      if (distance < nearestDistance) {
        nearest = part.index;
        nearestDistance = distance;
      }
    }
    return nearest;
  }

  // ECI 上の球と、selfPos・selfAtt に置いたこの敵との最深接触。触れていなければ null。
  public testSphereCollision(
    sphereCenter: Vec3, sphereRadius: number, selfPos: Vec3, selfAtt: Quat,
  ): SphereHit | null {
    return this.geometry.testSphereCollision(sphereCenter, sphereRadius, selfPos, selfAtt);
  }

  // 移動する球が生存部品の球列を最初に横切る接触と、区間内の割合 toi。区間内で横切ら
  // なければ null。
  public testSweptSphereCollision(
    previousSphereCenter: Vec3, sphereCenter: Vec3, sphereRadius: number,
    previousSelfState: KinematicState, selfState: KinematicState,
    previousSelfAttitude: Quat, selfAttitude: Quat,
  ): { readonly hit: SphereHit; readonly toi: number } | null {
    return this.geometry.testSweptSphereCollision(
      previousSphereCenter, sphereCenter, sphereRadius,
      previousSelfState, selfState, previousSelfAttitude, selfAttitude,
    );
  }

  // 生存部品の球を連結した判定ジオメトリ。部品を外すたびに組み直す。
  private buildGeometry(): SphereChainCollisionGeometry {
    const spheres: CollisionSphere[] = [];
    for (const part of this.parts) {
      if (this.excluded[part.index]) continue;
      const chain = this.spheresByPart[part.index];
      if (chain !== undefined) spheres.push(...chain);
    }
    // 部品の座標はすでに物理寸法なので倍率は 1。
    return new SphereChainCollisionGeometry(spheres, 1);
  }
}

// 部品の中心線を覆う球列(敵ローカル座標)。頂点は管を覆うには過密なので、折れ線に沿って
// radius * SPHERE_SPACING_RATIO ごとに間引いて置き、両端は必ず置く。頂点へではなく
// 折れ線上の位置へ置くので、頂点の間隔が大きく開いたところでも中心線が球の内に収まる。
function spheresAlong(part: AssemblyPartDef): CollisionSphere[] {
  const line = part.centerline;
  const first = line[0];
  if (first === undefined) return [];
  const step = part.radius * SPHERE_SPACING_RATIO;
  const centers: Vec3[] = [first];
  let cursor = first; // 折れ線上の現在位置
  let walked = 0;     // 最後に置いた球から cursor までの距離
  for (let i = 1; i < line.length; i += 1) {
    const vertex = line[i]!;
    let span = len(sub(vertex, cursor));
    while (walked + span >= step) {
      // 残り step - walked だけ線分上へ進んで球を置く
      cursor = addScaled(cursor, sub(vertex, cursor), (step - walked) / span);
      centers.push(cursor);
      walked = 0;
      span = len(sub(vertex, cursor));
    }
    walked += span;
    cursor = vertex;
  }
  const end = line[line.length - 1]!;
  if (distSq(centers[centers.length - 1]!, end) > 0) centers.push(end);
  return centers.map((c) => ({ cx: c.x, cy: c.y, cz: c.z, radius: part.radius }));
}

// 点から折れ線への最短距離。
function centerlineDistance(point: Vec3, centerline: readonly Vec3[]): number {
  let distanceSq = Infinity;
  for (let i = 0; i + 1 < centerline.length; i += 1) {
    distanceSq = Math.min(distanceSq, segmentDistanceSq(point, centerline[i]!, centerline[i + 1]!));
  }
  const first = centerline[0];
  if (first !== undefined) distanceSq = Math.min(distanceSq, distSq(point, first));
  return Math.sqrt(distanceSq);
}

// 点と線分の最短距離の2乗。
function segmentDistanceSq(point: Vec3, a: Vec3, b: Vec3): number {
  const ab = sub(b, a);
  const lengthSq = lenSq(ab);
  const t = lengthSq > 0 ? Math.min(1, Math.max(0, dot(sub(point, a), ab) / lengthSq)) : 0;
  return distSq(point, addScaled(a, ab, t));
}
