// 結節体の接触判定。索の球列・結節ノードの球・駆動中核の球を剛体の位置・姿勢へ
// 当て、静止球・掃引球との接触を球列ジオメトリへ委譲する。失われた部位は判定
// から取り除く(組み立て型の AssemblyCollision と同じ構え)。
import type { Vec3 } from '../../math/vec3';
import {
  SphereChainCollisionGeometry, type CollisionSphere,
} from '../dynamic/sphere-chain-collision';
import type { Quat } from '../../math/quat';
import type { KinematicState } from '../../physics/kinematic-state';
import type { SphereHit } from '../../math/triangle-mesh';
import type { KnotHitTarget, KnotShape } from './knot-shape';

export class KnotCollision {
  // 生成時の全体を覆う外接半径 [m]。部位の喪失では変えない。
  public readonly outerRadius: number;

  // segment.index 順の、セグメントごとの球列(敵ローカル座標)。
  private readonly spheresBySegment: readonly (readonly CollisionSphere[])[];
  // node.index 順の、ノードの球。
  private readonly nodeSpheres: readonly CollisionSphere[];
  private readonly coreSphere: CollisionSphere;
  private readonly excludedSegments: boolean[];
  private readonly excludedNodes: boolean[];
  private geometry: SphereChainCollisionGeometry;

  public constructor(private readonly shape: KnotShape) {
    this.spheresBySegment = shape.segments.map((segment) => {
      const spheres: CollisionSphere[] = [];
      for (let i = 0; i < segment.sphereCount; i += 1) {
        const sphere = shape.spheres[segment.sphereStart + i]!;
        spheres.push({
          cx: sphere.center[0], cy: sphere.center[1], cz: sphere.center[2], radius: sphere.radius,
        });
      }
      return spheres;
    });
    this.nodeSpheres = shape.nodes.map((node) => ({
      cx: node.position[0], cy: node.position[1], cz: node.position[2], radius: node.radius,
    }));
    this.coreSphere = {
      cx: shape.core.position[0], cy: shape.core.position[1], cz: shape.core.position[2],
      radius: shape.core.radius,
    };
    this.excludedSegments = shape.segments.map(() => false);
    this.excludedNodes = shape.nodes.map(() => false);
    this.outerRadius = shape.outerRadius;
    this.geometry = this.buildGeometry();
  }

  // index のセグメントを判定から恒久的に外す。既に外れたセグメントへは何もしない。
  public excludeSegment(index: number): void {
    if (this.excludedSegments[index]) return;
    this.excludedSegments[index] = true;
    this.geometry = this.buildGeometry();
  }

  // index の結節ノードを判定から恒久的に外す。
  public excludeNode(index: number): void {
    if (this.excludedNodes[index]) return;
    this.excludedNodes[index] = true;
    this.geometry = this.buildGeometry();
  }

  // ローカル座標の点に最も近い部位。距離は部位の表面までで比べる。着弾点を
  // セグメント・ノード・中核の HP へ割り当てるために使う。部位が無ければ null。
  public targetAt(localPoint: Vec3): KnotHitTarget | null {
    let target: KnotHitTarget | null = null;
    let nearest = Infinity;
    const consider = (candidate: KnotHitTarget, distance: number): void => {
      if (distance < nearest) {
        nearest = distance;
        target = candidate;
      }
    };
    for (const segment of this.shape.segments) {
      if (this.excludedSegments[segment.index]) continue;
      const chain = this.spheresBySegment[segment.index];
      if (chain === undefined) continue;
      for (const sphere of chain) {
        const distance = Math.hypot(
          localPoint.x - sphere.cx, localPoint.y - sphere.cy, localPoint.z - sphere.cz,
        ) - sphere.radius;
        consider({ part: 'segment', index: segment.index }, distance);
      }
    }
    for (const node of this.shape.nodes) {
      if (this.excludedNodes[node.index]) continue;
      const sphere = this.nodeSpheres[node.index]!;
      const distance = Math.hypot(
        localPoint.x - sphere.cx, localPoint.y - sphere.cy, localPoint.z - sphere.cz,
      ) - sphere.radius;
      consider({ part: 'node', index: node.index }, distance);
    }
    {
      const sphere = this.coreSphere;
      const distance = Math.hypot(
        localPoint.x - sphere.cx, localPoint.y - sphere.cy, localPoint.z - sphere.cz,
      ) - sphere.radius;
      consider({ part: 'core' }, distance);
    }
    return target;
  }

  // ECI 上の球と、selfPos・selfAtt に置いたこの敵との最深接触。触れていなければ null。
  public testSphereCollision(
    sphereCenter: Vec3, sphereRadius: number, selfPos: Vec3, selfAtt: Quat,
  ): SphereHit | null {
    return this.geometry.testSphereCollision(sphereCenter, sphereRadius, selfPos, selfAtt);
  }

  // 移動する球が生存部位の球列を最初に横切る接触と、区間内の割合 toi。区間内で
  // 横切らなければ null。
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

  // 生存部位の球を連結した判定ジオメトリ。部位を外すたびに組み直す。中核の球は
  // 常に含む — 索が手前にある間は索の球が先に当たることで遮蔽が生まれる。
  private buildGeometry(): SphereChainCollisionGeometry {
    const spheres: CollisionSphere[] = [];
    for (const segment of this.shape.segments) {
      if (this.excludedSegments[segment.index]) continue;
      const chain = this.spheresBySegment[segment.index];
      if (chain !== undefined) spheres.push(...chain);
    }
    for (const node of this.shape.nodes) {
      if (this.excludedNodes[node.index]) continue;
      spheres.push(this.nodeSpheres[node.index]!);
    }
    spheres.push(this.coreSphere);
    // 形状の座標はすでに物理寸法なので倍率は 1。
    return new SphereChainCollisionGeometry(spheres, 1);
  }
}
