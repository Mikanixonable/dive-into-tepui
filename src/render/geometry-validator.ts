// 3Dジオメトリ(BufferGeometry)の品質検証ユーティリティ。
// 1. 閉じていない面(オープンエッジ / 水密性の欠如)の検出
// 2. ジッタリング(Z-fighting / 同一平面上の重複ポリゴン)の検出
import * as THREE from 'three/webgpu';

export interface GeometryValidationOptions {
  /** 頂点座標を同一とみなす量子化の許容誤差 [m] (既定: 1e-4) */
  epsilon?: number;
  /** ジッタリング判定時、同平面ポリゴンペアの探索を有効にするか (既定: true) */
  checkCoplanarOverlap?: boolean;
}

export interface GeometryValidationResult {
  /** 閉じていない面(共有数が1のエッジ)の数 */
  openEdgeCount: number;
  /** 重複または同平面上でオーバーラップするポリゴンペアの数 */
  coplanarOverlapCount: number;
  /** オープンエッジの端点対リスト */
  openEdges: Array<{ a: { x: number; y: number; z: number }; b: { x: number; y: number; z: number } }>;
}

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

function quantizeKey(x: number, y: number, z: number, eps: number): string {
  const qx = Math.round(x / eps);
  const qy = Math.round(y / eps);
  const qz = Math.round(z / eps);
  return `${qx},${qy},${qz}`;
}

function canonicalEdgeKey(vA: Vec3, vB: Vec3, eps: number): string {
  const kA = quantizeKey(vA.x, vA.y, vA.z, eps);
  const kB = quantizeKey(vB.x, vB.y, vB.z, eps);
  return kA < kB ? `${kA}|${kB}` : `${kB}|${kA}`;
}

function pointsEqual2D(a: { x: number; y: number }, b: { x: number; y: number }, eps = 1e-4): boolean {
  return Math.abs(a.x - b.x) < eps && Math.abs(a.y - b.y) < eps;
}

function ccw2D(a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }): number {
  return (c.y - a.y) * (b.x - a.x) - (b.y - a.y) * (c.x - a.x);
}

/**
 * 2D 領域での線分 (p1-q1) と (p2-q2) の交差判定
 */
function lineSegmentsIntersect2D(
  p1: { x: number; y: number }, q1: { x: number; y: number },
  p2: { x: number; y: number }, q2: { x: number; y: number },
): boolean {
  const val1 = ccw2D(p1, q1, p2) * ccw2D(p1, q1, q2);
  const val2 = ccw2D(p2, q2, p1) * ccw2D(p2, q2, q1);
  return val1 < -1e-8 && val2 < -1e-8;
}

/**
 * 点 p が 2D 三角形 t0, t1, t2 の内部にあるか (境界を除く)
 */
function pointInTriangle2D(
  p: { x: number; y: number },
  t0: { x: number; y: number }, t1: { x: number; y: number }, t2: { x: number; y: number },
): boolean {
  const area = 0.5 * (-t1.y * t2.x + t0.y * (-t1.x + t2.x) + t0.x * (t1.y - t2.y) + t1.x * t2.y);
  if (Math.abs(area) < 1e-10) return false;
  const s = 1 / (2 * area) * (t0.y * t2.x - t0.x * t2.y + (t2.y - t0.y) * p.x + (t0.x - t2.x) * p.y);
  const t = 1 / (2 * area) * (t0.x * t1.y - t0.y * t1.x + (t0.y - t1.y) * p.x + (t1.x - t0.x) * p.y);
  const eps = 1e-4;
  return s > eps && t > eps && (1 - s - t) > eps;
}

/**
 * 2D 空間で2つの同平面三角形が実質的に交差/オーバーラップしているか
 */
function trianglesOverlap2D(
  tA: [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }],
  tB: [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }],
): boolean {
  const sharedIndicesA: number[] = [];
  const sharedIndicesB: number[] = [];

  for (let i = 0; i < 3; i++) {
    const ptA = tA[i];
    if (!ptA) continue;
    for (let j = 0; j < 3; j++) {
      const ptB = tB[j];
      if (!ptB) continue;
      if (pointsEqual2D(ptA, ptB)) {
        sharedIndicesA.push(i);
        sharedIndicesB.push(j);
        break;
      }
    }
  }

  // 1. 3頂点とも一致する場合 (完全同一平面ポリゴンの重ね配置)
  if (sharedIndicesA.length >= 3) return true;

  // 2. 2頂点を共有している場合 (隣接ポリゴンか重なりポリゴンか)
  if (sharedIndicesA.length === 2) {
    const s0A = sharedIndicesA[0];
    const s1A = sharedIndicesA[1];
    if (s0A !== undefined && s1A !== undefined) {
      const shared0A = tA[s0A];
      const shared1A = tA[s1A];
      const otherIdxA = [0, 1, 2].find((idx) => !sharedIndicesA.includes(idx)) ?? 0;
      const otherIdxB = [0, 1, 2].find((idx) => !sharedIndicesB.includes(idx)) ?? 0;
      const otherA = tA[otherIdxA];
      const otherB = tB[otherIdxB];

      if (shared0A && shared1A && otherA && otherB) {
        const sideA = ccw2D(shared0A, shared1A, otherA);
        const sideB = ccw2D(shared0A, shared1A, otherB);

        // 共有エッジの同じ側に対極頂点がある場合はオーバーラップ (同じ側 = 同符号)
        if (sideA * sideB > 1e-8) {
          return true;
        }
        // 反対側にある場合は正常な隣接四角形のテセレーション
        return false;
      }
    }
  }

  // 3. 共有頂点が 0 または 1 の場合: 相手の内部に頂点が入っているか
  for (let i = 0; i < 3; i++) {
    const ptA = tA[i];
    if (ptA && !sharedIndicesA.includes(i) && tB[0] && tB[1] && tB[2]) {
      if (pointInTriangle2D(ptA, tB[0], tB[1], tB[2])) {
        return true;
      }
    }
  }
  for (let j = 0; j < 3; j++) {
    const ptB = tB[j];
    if (ptB && !sharedIndicesB.includes(j) && tA[0] && tA[1] && tA[2]) {
      if (pointInTriangle2D(ptB, tA[0], tA[1], tA[2])) {
        return true;
      }
    }
  }

  // 4. エッジ同士の内部交差判定
  if (tA[0] && tA[1] && tA[2] && tB[0] && tB[1] && tB[2]) {
    const edgesA = [[tA[0], tA[1]], [tA[1], tA[2]], [tA[2], tA[0]]] as const;
    const edgesB = [[tB[0], tB[1]], [tB[1], tB[2]], [tB[2], tB[0]]] as const;
    for (const [eA1, eA2] of edgesA) {
      for (const [eB1, eB2] of edgesB) {
        if (lineSegmentsIntersect2D(eA1, eA2, eB1, eB2)) return true;
      }
    }
  }

  return false;
}

export function validateGeometry(
  geometry: THREE.BufferGeometry,
  options: GeometryValidationOptions = {},
): GeometryValidationResult {
  const eps = options.epsilon ?? 1e-4;
  const checkCoplanar = options.checkCoplanarOverlap ?? true;

  const posAttr = geometry.attributes.position;
  if (!posAttr) {
    return { openEdgeCount: 0, coplanarOverlapCount: 0, openEdges: [] };
  }

  const indexAttr = geometry.index;
  const totalTriangles = indexAttr ? Math.floor(indexAttr.count / 3) : Math.floor(posAttr.count / 3);

  const getVertex = (i: number): Vec3 => {
    const vIdx = indexAttr ? indexAttr.getX(i) : i;
    return { x: posAttr.getX(vIdx), y: posAttr.getY(vIdx), z: posAttr.getZ(vIdx) };
  };

  // --- 1. オープンエッジ (共有数 = 1) の検出 ---
  const edgeCountMap = new Map<string, { count: number; a: Vec3; b: Vec3 }>();

  interface TriangleData {
    v: [Vec3, Vec3, Vec3];
    norm: Vec3;
    d: number;
    min: Vec3;
    max: Vec3;
  }

  const triangles: TriangleData[] = [];

  for (let i = 0; i < totalTriangles; i++) {
    const v0 = getVertex(i * 3);
    const v1 = getVertex(i * 3 + 1);
    const v2 = getVertex(i * 3 + 2);

    const k0 = quantizeKey(v0.x, v0.y, v0.z, eps);
    const k1 = quantizeKey(v1.x, v1.y, v1.z, eps);
    const k2 = quantizeKey(v2.x, v2.y, v2.z, eps);

    // 縮退ポリゴン(頂点が同一点に量子化されたもの)は無視
    if (k0 === k1 || k1 === k2 || k2 === k0) continue;

    // エッジ カウント
    const edges = [[v0, v1], [v1, v2], [v2, v0]] as const;
    for (const [eA, eB] of edges) {
      const key = canonicalEdgeKey(eA, eB, eps);
      const existing = edgeCountMap.get(key);
      if (existing) {
        existing.count++;
      } else {
        edgeCountMap.set(key, { count: 1, a: eA, b: eB });
      }
    }

    if (checkCoplanar) {
      // 法線と平面定数の計算
      const ax = v1.x - v0.x, ay = v1.y - v0.y, az = v1.z - v0.z;
      const bx = v2.x - v0.x, by = v2.y - v0.y, bz = v2.z - v0.z;
      const nx = ay * bz - az * by;
      const ny = az * bx - ax * bz;
      const nz = ax * by - ay * bx;
      const lenN = Math.sqrt(nx * nx + ny * ny + nz * nz);

      if (lenN > 1e-8) {
        const norm = { x: nx / lenN, y: ny / lenN, z: nz / lenN };
        const d = -(norm.x * v0.x + norm.y * v0.y + norm.z * v0.z);
        const min = {
          x: Math.min(v0.x, v1.x, v2.x),
          y: Math.min(v0.y, v1.y, v2.y),
          z: Math.min(v0.z, v1.z, v2.z),
        };
        const max = {
          x: Math.max(v0.x, v1.x, v2.x),
          y: Math.max(v0.y, v1.y, v2.y),
          z: Math.max(v0.z, v1.z, v2.z),
        };
        triangles.push({ v: [v0, v1, v2], norm, d, min, max });
      }
    }
  }

  const openEdges: Array<{ a: Vec3; b: Vec3 }> = [];
  for (const entry of edgeCountMap.values()) {
    if (entry.count === 1) {
      openEdges.push({ a: entry.a, b: entry.b });
    }
  }

  // --- 2. 同一平面ポリゴンのオーバーラップ (Z-fighting) の検出 ---
  let coplanarOverlapCount = 0;

  if (checkCoplanar) {
    const numTris = triangles.length;
    for (let i = 0; i < numTris; i++) {
      const tI = triangles[i];
      if (!tI) continue;
      for (let j = i + 1; j < numTris; j++) {
        const tJ = triangles[j];
        if (!tJ) continue;

        // 1. 平面の平行チェック (|dot| ≈ 1)
        const dotN = Math.abs(tI.norm.x * tJ.norm.x + tI.norm.y * tJ.norm.y + tI.norm.z * tJ.norm.z);
        if (dotN < 1 - 1e-3) continue;

        // 2. 平面の距離一致チェック (|d_i - d_j| ≈ 0)
        const sameDir = (tI.norm.x * tJ.norm.x + tI.norm.y * tJ.norm.y + tI.norm.z * tJ.norm.z) > 0;
        const diffD = sameDir ? Math.abs(tI.d - tJ.d) : Math.abs(tI.d + tJ.d);
        if (diffD > 1e-3) continue;

        // 3. AABB 重複チェック
        if (
          tI.max.x < tJ.min.x - 1e-4 || tI.min.x > tJ.max.x + 1e-4 ||
          tI.max.y < tJ.min.y - 1e-4 || tI.min.y > tJ.max.y + 1e-4 ||
          tI.max.z < tJ.min.z - 1e-4 || tI.min.z > tJ.max.z + 1e-4
        ) {
          continue;
        }

        // 4. 最も法線成分の大きい軸に直交する面へ 2D 射影して交差を検証
        const absNx = Math.abs(tI.norm.x);
        const absNy = Math.abs(tI.norm.y);
        const absNz = Math.abs(tI.norm.z);

        const project2D = (v: Vec3): { x: number; y: number } => {
          if (absNx >= absNy && absNx >= absNz) return { x: v.y, y: v.z };
          if (absNy >= absNx && absNy >= absNz) return { x: v.x, y: v.z };
          return { x: v.x, y: v.y };
        };

        const projA = [project2D(tI.v[0]), project2D(tI.v[1]), project2D(tI.v[2])] as const;
        const projB = [project2D(tJ.v[0]), project2D(tJ.v[1]), project2D(tJ.v[2])] as const;

        if (trianglesOverlap2D(projA as any, projB as any)) {
          coplanarOverlapCount++;
        }
      }
    }
  }

  return {
    openEdgeCount: openEdges.length,
    coplanarOverlapCount,
    openEdges,
  };
}
