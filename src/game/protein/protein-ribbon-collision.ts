// 固定リボンの BVH を使い、外接球で絞った静止球・掃引球との接触を判定する。
import * as THREE from 'three/webgpu';
import { add, cross, dot, len, lenSq, norm, scale, sub, type Vec3, v3 } from '../../math/vec3';
import {
  type BVHNode, type SphereHit, type Triangle,
  buildBVH, sphereCollideTriangles,
} from '../../math/triangle-mesh';
import { qInvert, qRotate, type Quat } from '../../math/quat';

export class ProteinRibbonCollisionGeometry {
  readonly outerRadius: number;
  private readonly bvh: BVHNode | null;
  private readonly rootScale: number;

  /** タグ付き Ribbon Mesh を root-local BVH へ変換する。 */
  constructor(renderRoot: THREE.Object3D, rootScale: number) {
    this.rootScale = rootScale;
    const triangles = collectRibbonTriangles(renderRoot);
    this.bvh = buildBVH(triangles);

    let radiusSq = 0;
    for (const triangle of triangles) {
      radiusSq = Math.max(radiusSq, lenSq(triangle.a), lenSq(triangle.b), lenSq(triangle.c));
    }
    this.outerRadius = Math.sqrt(radiusSq) * rootScale;
  }

  /** ECI 上の球と現在姿勢の Ribbon の最深接触を返す。 */
  testSphereCollision(
    sphereCenter: Vec3, sphereRadius: number, center: Vec3, att: Quat,
  ): SphereHit | null {
    const distance = len(sub(sphereCenter, center));
    if (distance > this.outerRadius + sphereRadius) return null;

    // 球を固定 BVH のローカル座標へ移してから三角形接触を求める。
    const inverseAttitude = qInvert(att);
    const localCenter = scale(qRotate(inverseAttitude, sub(sphereCenter, center)), 1 / this.rootScale);
    const localRadius = sphereRadius / this.rootScale;
    const localHit = sphereCollideTriangles(localCenter, localRadius, this.bvh);
    if (localHit === null) return null;

    return {
      point: add(center, qRotate(att, scale(localHit.point, this.rootScale))),
      normal: norm(qRotate(att, localHit.normal)),
      depth: localHit.depth * this.rootScale,
    };
  }

  /** 移動する球が Ribbon を最初に横切る時刻を近似 CCD で返す。 */
  testSweptSphereCollision(
    previousSphereCenter: Vec3, sphereCenter: Vec3, sphereRadius: number,
    previousSelfState: { readonly r: Vec3 }, selfState: { readonly r: Vec3 }, att: Quat,
  ): { readonly hit: SphereHit; readonly toi: number } | null {
    const interval = segmentSphereInterval(
      sub(previousSphereCenter, previousSelfState.r),
      sub(sphereCenter, selfState.r),
      this.outerRadius + sphereRadius,
    );
    if (interval === null) return null;

    // 外接球との交差区間を等分し、最初の三角形接触を探索する。
    const samples = 48;
    let previousT = interval.start;
    let previousHit = this.testSphereCollision(
      positionAt(previousSphereCenter, sphereCenter, previousT), sphereRadius,
      positionAt(previousSelfState.r, selfState.r, previousT), att,
    );
    if (previousHit !== null) return { hit: previousHit, toi: previousT };

    for (let sample = 1; sample <= samples; sample++) {
      const t = interval.start + (interval.end - interval.start) * (sample / samples);
      const hit = this.testSphereCollision(
        positionAt(previousSphereCenter, sphereCenter, t), sphereRadius,
        positionAt(previousSelfState.r, selfState.r, t), att,
      );
      if (hit === null) {
        previousT = t;
        continue;
      }

      // 未接触と接触の境界を二分して返却時刻を面へ寄せる。
      let low = previousT;
      let high = t;
      let firstHit = hit;
      for (let iteration = 0; iteration < 7; iteration++) {
        const middle = (low + high) * 0.5;
        const middleHit = this.testSphereCollision(
          positionAt(previousSphereCenter, sphereCenter, middle), sphereRadius,
          positionAt(previousSelfState.r, selfState.r, middle), att,
        );
        if (middleHit === null) low = middle;
        else { high = middle; firstHit = middleHit; }
      }
      return { hit: firstHit, toi: high };
    }
    return null;
  }
}

/** 2状態間の線形補間位置を返す。 */
function positionAt(previous: Vec3, current: Vec3, t: number): Vec3 {
  return v3(
    previous.x + (current.x - previous.x) * t,
    previous.y + (current.y - previous.y) * t,
    previous.z + (current.z - previous.z) * t,
  );
}

/** 線分が原点中心球の内部にある正規化時刻区間を返す。 */
function segmentSphereInterval(start: Vec3, end: Vec3, radius: number): { start: number; end: number } | null {
  // |start + t direction|² = radius² の二次方程式を [0, 1] へ制限する。
  const direction = sub(end, start);
  const a = dot(direction, direction);
  const b = 2 * dot(start, direction);
  const c = dot(start, start) - radius * radius;
  if (c <= 0) return { start: 0, end: 1 };
  if (!(a > 0)) return null;
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return null;
  const root = Math.sqrt(discriminant);
  const startT = Math.max(0, (-b - root) / (2 * a));
  const endT = Math.min(1, (-b + root) / (2 * a));
  return startT <= endT ? { start: startT, end: endT } : null;
}

/** 専用 Ribbon としてタグ付けされた三角形を root-local 座標へそろえる。 */
function collectRibbonTriangles(renderRoot: THREE.Object3D): Triangle[] {
  renderRoot.updateMatrixWorld(true);
  const rootInverse = renderRoot.matrixWorld.clone().invert();
  const triangles: Triangle[] = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();

  // 子 Mesh の変換を root-local 行列へ合成し、BVH 用の三角形を列挙する。
  renderRoot.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || mesh.userData.proteinRibbon !== true || !mesh.geometry) return;
    const positions = mesh.geometry.getAttribute('position');
    if (!positions) return;
    const index = mesh.geometry.index;
    const localMatrix = rootInverse.clone().multiply(mesh.matrixWorld);
    const indexAt = (i: number): number => index ? index.getX(i) : i;

    for (let i = 0; i + 2 < (index?.count ?? positions.count); i += 3) {
      a.fromBufferAttribute(positions, indexAt(i)).applyMatrix4(localMatrix);
      b.fromBufferAttribute(positions, indexAt(i + 1)).applyMatrix4(localMatrix);
      c.fromBufferAttribute(positions, indexAt(i + 2)).applyMatrix4(localMatrix);
      const va = v3(a.x, a.y, a.z);
      const vb = v3(b.x, b.y, b.z);
      const vc = v3(c.x, c.y, c.z);
      const normal = norm(cross(sub(vb, va), sub(vc, va)));
      if (lenSq(normal) <= 1e-12) continue;
      triangles.push({ a: va, b: vb, c: vc, normal });
    }
  });
  return triangles;
}
