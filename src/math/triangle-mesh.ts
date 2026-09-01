// 三角形の集合を BVH へ束ね、レイと球の最近接触を求める。座標系と長さの単位は
// 呼び出し側の三角形に従うので、変換は呼び出し側で済ませてから渡す。
import { Vec3, v3, add, sub, scale, dot, len, cross, norm } from './vec3';

export interface Triangle {
  readonly a: Vec3;
  readonly b: Vec3;
  readonly c: Vec3;
  readonly normal: Vec3; // 表を向く単位法線
}

export interface RayHit {
  readonly point: Vec3; // 交差点
  readonly normal: Vec3; // 当たった三角形の法線
  readonly distance: number; // 始点から交差点までの距離
}

export interface SphereHit {
  readonly point: Vec3; // 三角形上の最近点
  readonly normal: Vec3; // 球を押し戻す向き
  readonly depth: number; // めり込み深さ
}

interface BVHLeaf {
  readonly min: Vec3;
  readonly max: Vec3;
  readonly triangles: readonly Triangle[];
}

interface BVHBranch {
  readonly min: Vec3;
  readonly max: Vec3;
  readonly left: BVHNode;
  readonly right: BVHNode;
}

// min / max は配下の全頂点を覆う AABB。
export type BVHNode = BVHLeaf | BVHBranch;

const LEAF_TRIANGLE_COUNT = 16;
const MAX_BVH_DEPTH = 12;

/** 三角形群から BVH を組む。三角形が1枚も無ければ null。 */
export function buildBVH(triangles: readonly Triangle[]): BVHNode | null {
  return buildNode(triangles, 0);
}

/** BVH へレイを飛ばし、maxDist 以内で最も手前の交差を返す。当たらなければ null。 */
export function raycastTriangles(
  origin: Vec3, dir: Vec3, maxDist: number, root: BVHNode | null,
): RayHit | null {
  return root === null ? null : raycastNode(origin, dir, maxDist, root);
}

/** BVH へ球を当て、最も深くめり込んだ接触を返す。触れていなければ null。 */
export function sphereCollideTriangles(
  center: Vec3, radius: number, root: BVHNode | null,
): SphereHit | null {
  return root === null ? null : sphereCollideNode(center, radius, root);
}

/** レイが maxDist 以内で AABB を横切るかを返す。 */
export function rayIntersectsAABB(
  origin: Vec3, dir: Vec3, maxDist: number, min: Vec3, max: Vec3,
): boolean {
  let entry = 0;
  let exit = maxDist;

  // 3 軸それぞれのスラブとの交差区間を積み、空になった時点で外れと分かる。
  for (const axis of ['x', 'y', 'z'] as const) {
    if (Math.abs(dir[axis]) < 1e-9) {
      if (origin[axis] < min[axis] || origin[axis] > max[axis]) return false;
      continue;
    }
    const inverseDir = 1 / dir[axis];
    const near = (min[axis] - origin[axis]) * inverseDir;
    const far = (max[axis] - origin[axis]) * inverseDir;
    entry = Math.max(entry, Math.min(near, far));
    exit = Math.min(exit, Math.max(near, far));
    if (entry > exit) return false;
  }
  return true;
}

/** 三角形群を1ノードへ束ね、深さと枚数の上限に達するまで再帰的に分割する。 */
function buildNode(triangles: readonly Triangle[], depth: number): BVHNode | null {
  if (triangles.length === 0) return null;

  // 配下の全頂点を覆う AABB を求める。
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

  // 最長軸の重心中央値で分け、偏りにくい二分木を作る。
  const extent = { x: maxX - minX, y: maxY - minY, z: maxZ - minZ };
  const axis: 'x' | 'y' | 'z' = extent.x >= extent.y && extent.x >= extent.z
    ? 'x' : extent.y >= extent.z ? 'y' : 'z';
  const sorted = [...triangles].sort((l, r) => centroidOn(l, axis) - centroidOn(r, axis));
  const middle = Math.floor(sorted.length / 2);
  const left = buildNode(sorted.slice(0, middle), depth + 1);
  const right = buildNode(sorted.slice(middle), depth + 1);
  if (left === null || right === null) return { min, max, triangles: [...triangles] };
  return { min, max, left, right };
}

/** 三角形の重心の、指定軸の座標を返す。 */
function centroidOn(triangle: Triangle, axis: 'x' | 'y' | 'z'): number {
  return (triangle.a[axis] + triangle.b[axis] + triangle.c[axis]) / 3;
}

/** node 以下で maxDist 以内の最も手前の交差を返す。当たらなければ null。 */
function raycastNode(origin: Vec3, dir: Vec3, maxDist: number, node: BVHNode): RayHit | null {
  if (!rayIntersectsAABB(origin, dir, maxDist, node.min, node.max)) return null;

  if ('triangles' in node) {
    let closest: RayHit | null = null;
    for (const triangle of node.triangles) {
      const hit = rayIntersectTriangle(origin, dir, triangle);
      if (hit !== null && hit.distance < (closest?.distance ?? maxDist)) closest = hit;
    }
    return closest;
  }

  // 左で当たった距離まで探索窓を縮めるので、右で当たればそちらが必ず手前になる。
  const leftHit = raycastNode(origin, dir, maxDist, node.left);
  const rightHit = raycastNode(origin, dir, leftHit?.distance ?? maxDist, node.right);
  return rightHit ?? leftHit;
}

// Möller–Trumbore 法。dir と平行な面と、始点より後ろの交差は当たりとしない。
function rayIntersectTriangle(origin: Vec3, dir: Vec3, triangle: Triangle): RayHit | null {
  const edge1 = sub(triangle.b, triangle.a);
  const edge2 = sub(triangle.c, triangle.a);
  const pvec = cross(dir, edge2);
  const determinant = dot(edge1, pvec);
  if (Math.abs(determinant) < 1e-8) return null;

  // 交差点の重心座標 (u, v) を求め、三角形の内側に落ちるものだけ残す。
  const inverseDeterminant = 1 / determinant;
  const tvec = sub(origin, triangle.a);
  const u = dot(tvec, pvec) * inverseDeterminant;
  if (u < 0 || u > 1) return null;
  const qvec = cross(tvec, edge1);
  const v = dot(dir, qvec) * inverseDeterminant;
  if (v < 0 || u + v > 1) return null;

  const distance = dot(edge2, qvec) * inverseDeterminant;
  if (distance < 0) return null;
  return { point: add(origin, scale(dir, distance)), normal: triangle.normal, distance };
}

/** node 以下で最も深くめり込んだ接触を返す。触れていなければ null。 */
function sphereCollideNode(center: Vec3, radius: number, node: BVHNode): SphereHit | null {
  // 半径だけ広げた AABB の外なら、配下のどの三角形にも届かない。
  if (center.x < node.min.x - radius || center.x > node.max.x + radius
    || center.y < node.min.y - radius || center.y > node.max.y + radius
    || center.z < node.min.z - radius || center.z > node.max.z + radius) return null;

  if ('triangles' in node) {
    let deepest: SphereHit | null = null;
    for (const triangle of node.triangles) {
      const closest = closestPointTriangle(center, triangle);
      const difference = sub(center, closest);
      const distance = len(difference);
      if (distance >= radius) continue;
      const depth = radius - distance;
      if (deepest !== null && depth <= deepest.depth) continue;
      // 中心が面上に乗ると押し戻す向きが定まらないので、そのときだけ面の法線を使う。
      deepest = { point: closest, normal: distance > 1e-6 ? norm(difference) : triangle.normal, depth };
    }
    return deepest;
  }

  const leftHit = sphereCollideNode(center, radius, node.left);
  const rightHit = sphereCollideNode(center, radius, node.right);
  if (leftHit === null) return rightHit;
  if (rightHit === null) return leftHit;
  return leftHit.depth >= rightHit.depth ? leftHit : rightHit;
}

/** 点から三角形への最近点を Voronoi 領域ごとに求める。 */
function closestPointTriangle(point: Vec3, triangle: Triangle): Vec3 {
  // 頂点、辺、面の順に重心座標の符号から所属領域を絞り込む。
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
