// タンパク質敵のリボン表示メッシュから作る狭域の球-三角形判定。
// 外接球は broad phase に残すが、実際の接触はこの BVH に入っているリボンの
// 三角形だけを対象にする。表示用のメッシュを読み取るため、リボンの分割数と
// 衝突形状が別々にずれることがない。
import * as THREE from 'three/webgpu';
import { add, cross, dot, len, norm, scale, sub, type Vec3, v3 } from '../../physics/vec3';
import { qInvert, qRotate, type Quat } from '../../physics/attitude';
import type { SphereHit, Triangle } from '../../physics/base-collision';

interface BVHNode {
  readonly min: Vec3;
  readonly max: Vec3;
  readonly triangles?: readonly Triangle[];
  readonly left?: BVHNode;
  readonly right?: BVHNode;
}

const LEAF_TRIANGLE_COUNT = 16;
const MAX_BVH_DEPTH = 12;

export class ProteinRibbonCollisionGeometry {
  readonly outerRadius: number;
  private readonly bvh: BVHNode | null;
  private readonly rootScale: number;

  constructor(renderRoot: THREE.Object3D, rootScale: number) {
    this.rootScale = rootScale;
    const triangles = collectRibbonTriangles(renderRoot);
    this.bvh = buildBVH(triangles, 0);

    let radiusSq = 0;
    for (const triangle of triangles) {
      radiusSq = Math.max(radiusSq, lenSq(triangle.a), lenSq(triangle.b), lenSq(triangle.c));
    }
    this.outerRadius = Math.sqrt(radiusSq) * rootScale;
  }

  // 球の中心・半径は ECI、center/att はタンパク質自身の状態。
  testSphereCollision(
    sphereCenter: Vec3, sphereRadius: number, center: Vec3, att: Quat,
  ): SphereHit | null {
    if (this.bvh === null) return null;

    const distance = len(sub(sphereCenter, center));
    if (distance > this.outerRadius + sphereRadius) return null;

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

  // リボンの細い面を高速弾が区間内で横切る場合に備えた近似 CCD。まず外接球との交差区間
  // へ絞り、その区間を等分して BVH を調べ、最初のヒットを二分探索で面へ寄せる。判定形状
  // 自体は各サンプルで同じ三角形 BVH を使うため、球の外接判定へ戻ることはない。
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

function positionAt(previous: Vec3, current: Vec3, t: number): Vec3 {
  return v3(
    previous.x + (current.x - previous.x) * t,
    previous.y + (current.y - previous.y) * t,
    previous.z + (current.z - previous.z) * t,
  );
}

function segmentSphereInterval(start: Vec3, end: Vec3, radius: number): { start: number; end: number } | null {
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

function collectRibbonTriangles(renderRoot: THREE.Object3D): Triangle[] {
  renderRoot.updateMatrixWorld(true);
  const rootInverse = renderRoot.matrixWorld.clone().invert();
  const triangles: Triangle[] = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();

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

function lenSq(value: Vec3): number {
  return dot(value, value);
}

function buildBVH(triangles: readonly Triangle[], depth: number): BVHNode | null {
  if (triangles.length === 0) return null;

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const triangle of triangles) {
    for (const point of [triangle.a, triangle.b, triangle.c]) {
      minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x);
      minY = Math.min(minY, point.y); maxY = Math.max(maxY, point.y);
      minZ = Math.min(minZ, point.z); maxZ = Math.max(maxZ, point.z);
    }
  }
  const min = v3(minX, minY, minZ);
  const max = v3(maxX, maxY, maxZ);
  if (triangles.length <= LEAF_TRIANGLE_COUNT || depth >= MAX_BVH_DEPTH) {
    return { min, max, triangles: [...triangles] };
  }

  const extent = { x: maxX - minX, y: maxY - minY, z: maxZ - minZ };
  const axis: 'x' | 'y' | 'z' = extent.x >= extent.y && extent.x >= extent.z
    ? 'x' : extent.y >= extent.z ? 'y' : 'z';
  const sorted = [...triangles].sort((left, right) => (
    (left.a[axis] + left.b[axis] + left.c[axis]) / 3
    - (right.a[axis] + right.b[axis] + right.c[axis]) / 3
  ));
  const middle = Math.floor(sorted.length / 2);
  const left = buildBVH(sorted.slice(0, middle), depth + 1);
  const right = buildBVH(sorted.slice(middle), depth + 1);
  if (left === null || right === null) return { min, max, triangles: [...triangles] };
  return { min, max, left, right };
}

function sphereCollideTriangles(
  center: Vec3, radius: number, node: BVHNode,
): { point: Vec3; normal: Vec3; depth: number } | null {
  const expandedMin = sub(node.min, v3(radius, radius, radius));
  const expandedMax = add(node.max, v3(radius, radius, radius));
  if (center.x < expandedMin.x || center.x > expandedMax.x
    || center.y < expandedMin.y || center.y > expandedMax.y
    || center.z < expandedMin.z || center.z > expandedMax.z) return null;

  if (node.triangles) {
    let deepest: { point: Vec3; normal: Vec3; depth: number } | null = null;
    for (const triangle of node.triangles) {
      const closest = closestPointTriangle(center, triangle);
      const difference = sub(center, closest);
      const distance = len(difference);
      if (distance >= radius) continue;
      const depth = radius - distance;
      if (deepest === null || depth > deepest.depth) {
        deepest = {
          point: closest,
          normal: distance > 1e-6 ? norm(difference) : triangle.normal,
          depth,
        };
      }
    }
    return deepest;
  }

  const leftHit = node.left ? sphereCollideTriangles(center, radius, node.left) : null;
  const rightHit = node.right ? sphereCollideTriangles(center, radius, node.right) : null;
  if (leftHit === null) return rightHit;
  if (rightHit === null || leftHit.depth >= rightHit.depth) return leftHit;
  return rightHit;
}

function closestPointTriangle(point: Vec3, triangle: Triangle): Vec3 {
  const { a, b, c } = triangle;
  const ab = sub(b, a), ac = sub(c, a), ap = sub(point, a);
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return a;

  const bp = sub(point, b);
  const d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return b;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return add(a, scale(ab, d1 / (d1 - d3)));

  const cp = sub(point, c);
  const d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return add(a, scale(ac, d2 / (d2 - d6)));

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    return add(b, scale(sub(c, b), (d4 - d3) / ((d4 - d3) + (d5 - d6))));
  }
  const denominator = 1 / (va + vb + vc);
  return add(a, add(scale(ab, vb * denominator), scale(ac, vc * denominator)));
}
