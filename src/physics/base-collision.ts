// 基地の多段階 (LOD0 / LOD1 / LOD2) 衝突検出エンジン
import * as THREE from 'three/webgpu';
import { Vec3, v3, add, sub, scale, dot, len, lenSq, norm, cross } from './vec3';
import { Quat, qRotate, qInvert } from './attitude';
import { buildBaseModel } from '../render/ships';

export interface RayHit {
  readonly point: Vec3; // 着弾ワールド座標
  readonly normal: Vec3; // ワールド法線
  readonly distance: number; // 距離 [m]
}

export interface SphereHit {
  readonly point: Vec3; // ワールド衝突点
  readonly normal: Vec3; // 基地外向きのワールド反発法線
  readonly depth: number; // めり込み深さ [m]
}

export interface OBB {
  readonly center: Vec3; // ローカル中心
  readonly halfSizes: Vec3; // 半長 (x, y, z)
}

export interface Triangle {
  readonly a: Vec3;
  readonly b: Vec3;
  readonly c: Vec3;
  readonly normal: Vec3;
}

// 簡易 BVH ノード
interface BVHNode {
  readonly min: Vec3;
  readonly max: Vec3;
  readonly triangles?: Triangle[];
  readonly left?: BVHNode;
  readonly right?: BVHNode;
}

export class BaseCollisionGeometry {
  // 外接球半径 [m] (早期棄却判定用)
  public readonly outerRadius = 110;

  // LOD0: フルポリゴン BVH
  private readonly lod0Triangles: Triangle[] = [];
  private lod0BVH: BVHNode | null = null;

  // LOD1: 低ポリゴン BVH (主要ブロック + タンク)
  private readonly lod1Triangles: Triangle[] = [];
  private lod1BVH: BVHNode | null = null;

  // LOD2: 複合 OBB (主要3ブロック)
  private readonly lod2OBBs: OBB[] = [
    // 主要部 (居住区・農場)
    { center: v3(0, 0, 75), halfSizes: v3(12, 12, 28) },
    // トラス・ドック部
    { center: v3(0, 0, 0), halfSizes: v3(22, 10, 43) },
    // カウンターウェイト部
    { center: v3(0, 0, -75), halfSizes: v3(18, 18, 36) },
  ];

  constructor() {
    this.buildLOD0Geometry();
    this.buildLOD1Geometry();
  }

  // -------------------------------------------------------------------
  // パブリック判定 API (ワールド座標系)
  // -------------------------------------------------------------------

  /**
   * 判定用レイキャスト (ワールド ECI)
   * @param rayOrigin レイ始点 (ワールド ECI)
   * @param rayDir レイ方向単位ベクトル (ワールド ECI)
   * @param maxDist 最大探索距離 [m]
   * @param basePos 基地の位置 (ワールド ECI)
   * @param baseAtt 基地の姿勢 Quat
   * @param warpLevel 現在のワープ倍率
   */
  raycast(
    rayOrigin: Vec3,
    rayDir: Vec3,
    maxDist: number,
    basePos: Vec3,
    baseAtt: Quat,
    warpLevel: number,
  ): RayHit | null {
    // 1. 早期棄却: 外接球判定
    const toBase = sub(basePos, rayOrigin);
    const proj = dot(toBase, rayDir);
    const distSqToLine = lenSq(toBase) - proj * proj;
    if (distSqToLine > (this.outerRadius + 5) * (this.outerRadius + 5)) {
      return null;
    }

    // 2. ローカル座標系へ変換
    const invQ = qInvert(baseAtt);
    const localOrigin = qRotate(invQ, sub(rayOrigin, basePos));
    const localDir = qRotate(invQ, rayDir);

    // 3. ワープ倍率に応じた LOD 選択
    let hitLocal: { point: Vec3; normal: Vec3; distance: number } | null = null;
    if (warpLevel <= 1) {
      // LOD 0: フルポリゴン BVH
      hitLocal = this.raycastTriangles(localOrigin, localDir, maxDist, this.lod0BVH);
    } else if (warpLevel <= 16) {
      // LOD 1: 低ポリゴン BVH
      hitLocal = this.raycastTriangles(localOrigin, localDir, maxDist, this.lod1BVH);
    } else {
      // LOD 2: 複合 OBB
      hitLocal = this.raycastOBBs(localOrigin, localDir, maxDist, this.lod2OBBs);
    }

    if (!hitLocal) return null;

    // 4. ワールド座標系へ逆変換
    return {
      point: add(basePos, qRotate(baseAtt, hitLocal.point)),
      normal: norm(qRotate(baseAtt, hitLocal.normal)),
      distance: hitLocal.distance,
    };
  }

  /**
   * 剛体/船/デブリ用 剛体球接触テスト (ワールド ECI)
   * @param sphereCenter 球体中心 (ワールド ECI)
   * @param sphereRadius 球体半径 [m]
   * @param basePos 基地位置 (ワールド ECI)
   * @param baseAtt 基地姿勢 Quat
   * @param warpLevel ワープ倍率
   */
  testSphereCollision(
    sphereCenter: Vec3,
    sphereRadius: number,
    basePos: Vec3,
    baseAtt: Quat,
    warpLevel: number,
  ): SphereHit | null {
    // 1. 早期棄却: 外接球判定
    const distToBase = len(sub(sphereCenter, basePos));
    if (distToBase > this.outerRadius + sphereRadius) {
      return null;
    }

    // 2. ローカル座標系へ変換
    const invQ = qInvert(baseAtt);
    const localCenter = qRotate(invQ, sub(sphereCenter, basePos));

    // 3. ワープ倍率に応じた LOD 選択
    let hitLocal: { point: Vec3; normal: Vec3; depth: number } | null = null;
    if (warpLevel <= 1) {
      // LOD 0: フルポリゴン BVH
      hitLocal = this.sphereCollideTriangles(localCenter, sphereRadius, this.lod0BVH);
    } else if (warpLevel <= 16) {
      // LOD 1: 低ポリゴン BVH
      hitLocal = this.sphereCollideTriangles(localCenter, sphereRadius, this.lod1BVH);
    } else {
      // LOD 2: 複合 OBB
      hitLocal = this.sphereCollideOBBs(localCenter, sphereRadius, this.lod2OBBs);
    }

    if (!hitLocal) return null;

    // 4. ワールド座標系へ逆変換
    return {
      point: add(basePos, qRotate(baseAtt, hitLocal.point)),
      normal: norm(qRotate(baseAtt, hitLocal.normal)),
      depth: hitLocal.depth,
    };
  }

  // -------------------------------------------------------------------
  // ジオメトリ構築 (LOD0 & LOD1)
  // -------------------------------------------------------------------

  private buildLOD0Geometry(): void {
    const rootGroup = buildBaseModel();
    rootGroup.updateMatrixWorld(true);

    const triangles: Triangle[] = [];
    const vA = new THREE.Vector3();
    const vB = new THREE.Vector3();
    const vC = new THREE.Vector3();

    rootGroup.traverse((child) => {
      if (child instanceof THREE.Mesh && child.geometry) {
        const geom = child.geometry.toNonIndexed();
        const posAttr = geom.attributes.position;
        if (!posAttr) return;

        const matrix = child.matrixWorld;
        for (let i = 0; i < posAttr.count; i += 3) {
          vA.fromBufferAttribute(posAttr, i).applyMatrix4(matrix);
          vB.fromBufferAttribute(posAttr, i + 1).applyMatrix4(matrix);
          vC.fromBufferAttribute(posAttr, i + 2).applyMatrix4(matrix);

          const pA = v3(vA.x, vA.y, vA.z);
          const pB = v3(vB.x, vB.y, vB.z);
          const pC = v3(vC.x, vC.y, vC.z);

          const ab = sub(pB, pA);
          const ac = sub(pC, pA);
          const n = norm(cross(ab, ac));
          if (lenSq(n) > 1e-6) {
            triangles.push({ a: pA, b: pB, c: pC, normal: n });
          }
        }
      }
    });

    this.lod0Triangles.push(...triangles);
    this.lod0BVH = this.buildBVH(triangles, 0);
  }

  private buildLOD1Geometry(): void {
    const boxes: OBB[] = [
      { center: v3(0, 0, 75), halfSizes: v3(11, 11, 26) }, // 主要部
      { center: v3(0, 11, 95), halfSizes: v3(8, 6, 6) }, // 温室
      { center: v3(0, 0, 5), halfSizes: v3(9, 9, 42.5) }, // トラス
      { center: v3(0, 0, 0), halfSizes: v3(21, 3, 26) }, // ドックパレット
      { center: v3(0, 0, -75), halfSizes: v3(16, 16, 35) }, // カウンターウェイトコア
      { center: v3(-10, 10, -75), halfSizes: v3(6.5, 6.5, 17) }, // タンク 1
      { center: v3(10, 10, -75), halfSizes: v3(6.5, 6.5, 17) }, // タンク 2
      { center: v3(0, -10, -75), halfSizes: v3(7.5, 7.5, 17) }, // タンク 3
    ];

    for (const box of boxes) {
      this.addBoxTriangles(box, this.lod1Triangles);
    }
    this.lod1BVH = this.buildBVH(this.lod1Triangles, 0);
  }

  private addBoxTriangles(box: OBB, out: Triangle[]): void {
    const { center: c, halfSizes: h } = box;
    const p = [
      v3(c.x - h.x, c.y - h.y, c.z - h.z), // 0
      v3(c.x + h.x, c.y - h.y, c.z - h.z), // 1
      v3(c.x + h.x, c.y + h.y, c.z - h.z), // 2
      v3(c.x - h.x, c.y + h.y, c.z - h.z), // 3
      v3(c.x - h.x, c.y - h.y, c.z + h.z), // 4
      v3(c.x + h.x, c.y - h.y, c.z + h.z), // 5
      v3(c.x + h.x, c.y + h.y, c.z + h.z), // 6
      v3(c.x - h.x, c.y + h.y, c.z + h.z), // 7
    ];

    const addQuad = (i0: number, i1: number, i2: number, i3: number, normal: Vec3) => {
      out.push({ a: p[i0]!, b: p[i1]!, c: p[i2]!, normal });
      out.push({ a: p[i0]!, b: p[i2]!, c: p[i3]!, normal });
    };

    addQuad(0, 3, 2, 1, v3(0, 0, -1)); // -Z
    addQuad(4, 5, 6, 7, v3(0, 0, 1));  // +Z
    addQuad(0, 1, 5, 4, v3(0, -1, 0)); // -Y
    addQuad(3, 7, 6, 2, v3(0, 1, 0));  // +Y
    addQuad(0, 4, 7, 3, v3(-1, 0, 0)); // -X
    addQuad(1, 2, 6, 5, v3(1, 0, 0));  // +X
  }

  // -------------------------------------------------------------------
  // BVH 構築 & 探索アルゴリズム
  // -------------------------------------------------------------------

  private buildBVH(triangles: Triangle[], depth: number): BVHNode | null {
    if (triangles.length === 0) return null;

    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

    for (const tri of triangles) {
      for (const pt of [tri.a, tri.b, tri.c]) {
        if (pt.x < minX) minX = pt.x; if (pt.x > maxX) maxX = pt.x;
        if (pt.y < minY) minY = pt.y; if (pt.y > maxY) maxY = pt.y;
        if (pt.z < minZ) minZ = pt.z; if (pt.z > maxZ) maxZ = pt.z;
      }
    }

    const min = v3(minX, minY, minZ);
    const max = v3(maxX, maxY, maxZ);

    if (triangles.length <= 16 || depth >= 10) {
      return { min, max, triangles };
    }

    // 分割軸の決定 (最も広い軸)
    const dx = maxX - minX, dy = maxY - minY, dz = maxZ - minZ;
    let axis: 'x' | 'y' | 'z' = 'x';
    if (dy > dx && dy > dz) axis = 'y';
    else if (dz > dx && dz > dy) axis = 'z';

    const mid = (min[axis] + max[axis]) / 2;
    const leftTris: Triangle[] = [];
    const rightTris: Triangle[] = [];

    for (const tri of triangles) {
      const triMid = (tri.a[axis] + tri.b[axis] + tri.c[axis]) / 3;
      if (triMid < mid) leftTris.push(tri);
      else rightTris.push(tri);
    }

    if (leftTris.length === 0 || rightTris.length === 0) {
      return { min, max, triangles };
    }

    return {
      min,
      max,
      left: this.buildBVH(leftTris, depth + 1)!,
      right: this.buildBVH(rightTris, depth + 1)!,
    };
  }

  // -------------------------------------------------------------------
  // 三角形交差 & OBB 衝突判定演算
  // -------------------------------------------------------------------

  private raycastTriangles(
    origin: Vec3,
    dir: Vec3,
    maxDist: number,
    node: BVHNode | null,
  ): { point: Vec3; normal: Vec3; distance: number } | null {
    if (!node) return null;

    if (!this.rayIntersectsAABB(origin, dir, maxDist, node.min, node.max)) {
      return null;
    }

    let closestHit: { point: Vec3; normal: Vec3; distance: number } | null = null;
    let currentMax = maxDist;

    if (node.triangles) {
      for (const tri of node.triangles) {
        const hit = this.rayIntersectTriangle(origin, dir, tri);
        if (hit && hit.distance < currentMax) {
          currentMax = hit.distance;
          closestHit = hit;
        }
      }
      return closestHit;
    }

    const leftHit = node.left ? this.raycastTriangles(origin, dir, currentMax, node.left) : null;
    if (leftHit) {
      currentMax = leftHit.distance;
      closestHit = leftHit;
    }

    const rightHit = node.right ? this.raycastTriangles(origin, dir, currentMax, node.right) : null;
    if (rightHit && rightHit.distance < currentMax) {
      closestHit = rightHit;
    }

    return closestHit;
  }

  private rayIntersectsAABB(origin: Vec3, dir: Vec3, maxDist: number, min: Vec3, max: Vec3): boolean {
    let tmin = 0;
    let tmax = maxDist;

    for (const axis of ['x', 'y', 'z'] as const) {
      if (Math.abs(dir[axis]) < 1e-9) {
        if (origin[axis] < min[axis] || origin[axis] > max[axis]) return false;
      } else {
        const invD = 1 / dir[axis];
        let t1 = (min[axis] - origin[axis]) * invD;
        let t2 = (max[axis] - origin[axis]) * invD;
        if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
        tmin = Math.max(tmin, t1);
        tmax = Math.min(tmax, t2);
        if (tmin > tmax) return false;
      }
    }
    return true;
  }

  // Möller–Trumbore レイ-三角形交差判定
  private rayIntersectTriangle(origin: Vec3, dir: Vec3, tri: Triangle): { point: Vec3; normal: Vec3; distance: number } | null {
    const edge1 = sub(tri.b, tri.a);
    const edge2 = sub(tri.c, tri.a);
    const pvec = cross(dir, edge2);
    const det = dot(edge1, pvec);

    if (Math.abs(det) < 1e-8) return null;
    const invDet = 1 / det;

    const tvec = sub(origin, tri.a);
    const u = dot(tvec, pvec) * invDet;
    if (u < 0 || u > 1) return null;

    const qvec = cross(tvec, edge1);
    const v = dot(dir, qvec) * invDet;
    if (v < 0 || u + v > 1) return null;

    const t = dot(edge2, qvec) * invDet;
    if (t < 0) return null;

    const hitPoint = add(origin, scale(dir, t));
    return { point: hitPoint, normal: tri.normal, distance: t };
  }

  private raycastOBBs(origin: Vec3, dir: Vec3, maxDist: number, obbs: readonly OBB[]): { point: Vec3; normal: Vec3; distance: number } | null {
    let closestHit: { point: Vec3; normal: Vec3; distance: number } | null = null;
    let currentMax = maxDist;

    for (const obb of obbs) {
      const min = sub(obb.center, obb.halfSizes);
      const max = add(obb.center, obb.halfSizes);
      if (this.rayIntersectsAABB(origin, dir, currentMax, min, max)) {
        // 近似法線と交差距離
        let tmin = 0;
        let hitNormal = v3(0, 0, 1);
        for (const axis of ['x', 'y', 'z'] as const) {
          if (Math.abs(dir[axis]) >= 1e-9) {
            const invD = 1 / dir[axis];
            const t1 = (min[axis] - origin[axis]) * invD;
            const t2 = (max[axis] - origin[axis]) * invD;
            const entryT = Math.min(t1, t2);
            if (entryT > tmin) {
              tmin = entryT;
              hitNormal = axis === 'x' ? v3(dir.x > 0 ? -1 : 1, 0, 0)
                : axis === 'y' ? v3(0, dir.y > 0 ? -1 : 1, 0)
                : v3(0, 0, dir.z > 0 ? -1 : 1);
            }
          }
        }
        if (tmin > 0 && tmin < currentMax) {
          currentMax = tmin;
          closestHit = {
            point: add(origin, scale(dir, tmin)),
            normal: hitNormal,
            distance: tmin,
          };
        }
      }
    }
    return closestHit;
  }

  private sphereCollideTriangles(
    center: Vec3,
    radius: number,
    node: BVHNode | null,
  ): { point: Vec3; normal: Vec3; depth: number } | null {
    if (!node) return null;

    // AABB 判定 (球体拡張 AABB)
    const expandedMin = sub(node.min, v3(radius, radius, radius));
    const expandedMax = add(node.max, v3(radius, radius, radius));
    if (center.x < expandedMin.x || center.x > expandedMax.x ||
        center.y < expandedMin.y || center.y > expandedMax.y ||
        center.z < expandedMin.z || center.z > expandedMax.z) {
      return null;
    }

    let deepestHit: { point: Vec3; normal: Vec3; depth: number } | null = null;
    let maxDepth = 0;

    if (node.triangles) {
      for (const tri of node.triangles) {
        const closestPt = this.closestPointTriangle(center, tri);
        const diff = sub(center, closestPt);
        const dist = len(diff);
        if (dist < radius) {
          const depth = radius - dist;
          if (depth > maxDepth) {
            maxDepth = depth;
            const normal = dist > 1e-6 ? norm(diff) : tri.normal;
            deepestHit = { point: closestPt, normal, depth };
          }
        }
      }
      return deepestHit;
    }

    const leftHit = node.left ? this.sphereCollideTriangles(center, radius, node.left) : null;
    if (leftHit && leftHit.depth > maxDepth) {
      maxDepth = leftHit.depth;
      deepestHit = leftHit;
    }

    const rightHit = node.right ? this.sphereCollideTriangles(center, radius, node.right) : null;
    if (rightHit && rightHit.depth > maxDepth) {
      deepestHit = rightHit;
    }

    return deepestHit;
  }

  private sphereCollideOBBs(center: Vec3, radius: number, obbs: readonly OBB[]): { point: Vec3; normal: Vec3; depth: number } | null {
    let deepestHit: { point: Vec3; normal: Vec3; depth: number } | null = null;
    let maxDepth = 0;

    for (const obb of obbs) {
      const closestPt = v3(
        Math.max(obb.center.x - obb.halfSizes.x, Math.min(obb.center.x + obb.halfSizes.x, center.x)),
        Math.max(obb.center.y - obb.halfSizes.y, Math.min(obb.center.y + obb.halfSizes.y, center.y)),
        Math.max(obb.center.z - obb.halfSizes.z, Math.min(obb.center.z + obb.halfSizes.z, center.z)),
      );

      const diff = sub(center, closestPt);
      const dist = len(diff);
      if (dist < radius) {
        const depth = radius - dist;
        if (depth > maxDepth) {
          maxDepth = depth;
          const normal = dist > 1e-6 ? norm(diff) : v3(0, 1, 0);
          deepestHit = { point: closestPt, normal, depth };
        }
      }
    }
    return deepestHit;
  }

  // 点から三角形への最短点を計算
  private closestPointTriangle(p: Vec3, tri: Triangle): Vec3 {
    const a = tri.a, b = tri.b, c = tri.c;
    const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
    const d1 = dot(ab, ap), d2 = dot(ac, ap);
    if (d1 <= 0 && d2 <= 0) return a;

    const bp = sub(p, b);
    const d3 = dot(ab, bp), d4 = dot(ac, bp);
    if (d3 >= 0 && d4 <= d3) return b;

    const vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) {
      const v = d1 / (d1 - d3);
      return add(a, scale(ab, v));
    }

    const cp = sub(p, c);
    const d5 = dot(ab, cp), d6 = dot(ac, cp);
    if (d6 >= 0 && d5 <= d6) return c;

    const vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) {
      const w = d2 / (d2 - d6);
      return add(a, scale(ac, w));
    }

    const va = d3 * d6 - d5 * d4;
    if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
      const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
      return add(b, scale(sub(c, b), w));
    }

    const denom = 1 / (va + vb + vc);
    const v = vb * denom;
    const w = vc * denom;
    return add(a, add(scale(ab, v), scale(ac, w)));
  }
}
