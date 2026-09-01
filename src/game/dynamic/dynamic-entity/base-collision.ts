// 基地の当たり形状を組み、ワープ倍率に応じた粗さ (LOD0 / LOD1 / LOD2) でレイと球を判定する。
import * as THREE from 'three/webgpu';
import { Vec3, v3, add, sub, scale, dot, len, lenSq, norm, cross } from '../../../math/vec3';
import {
  BVHNode, RayHit, SphereHit, Triangle,
  buildBVH, raycastTriangles, rayIntersectsAABB, sphereCollideTriangles,
} from '../../../math/triangle-mesh';
import { Quat, qRotate, qInvert } from '../../../physics/attitude';
import { buildBaseModel } from '../../../render/base-station-model';

// 軸並行の箱。center / halfSizes とも基地ローカル座標 [m]。
interface OBB {
  readonly center: Vec3;
  readonly halfSizes: Vec3;
}

// LOD1: 主要ブロックとタンクを箱で覆った近似形状。
const LOD1_BOXES: readonly OBB[] = [
  { center: v3(0, 0, 75), halfSizes: v3(11, 11, 26) }, // 主要部
  { center: v3(0, 11, 95), halfSizes: v3(8, 6, 6) }, // 温室
  { center: v3(0, 0, 5), halfSizes: v3(9, 9, 42.5) }, // トラス
  { center: v3(0, 0, 0), halfSizes: v3(21, 3, 26) }, // ドックパレット
  { center: v3(0, 0, -75), halfSizes: v3(16, 16, 35) }, // カウンターウェイトコア
  { center: v3(-10, 10, -75), halfSizes: v3(6.5, 6.5, 17) }, // タンク 1
  { center: v3(10, 10, -75), halfSizes: v3(6.5, 6.5, 17) }, // タンク 2
  { center: v3(0, -10, -75), halfSizes: v3(7.5, 7.5, 17) }, // タンク 3
];

// LOD2: 主要3ブロックを覆う粗い近似形状。
const LOD2_OBBS: readonly OBB[] = [
  { center: v3(0, 0, 225), halfSizes: v3(36, 36, 84) }, // 主要部 (居住区・研究ドーム)
  { center: v3(0, 0, 0), halfSizes: v3(66, 30, 129) }, // トラス・ドック部
  { center: v3(0, 0, -225), halfSizes: v3(54, 54, 108) }, // カウンターウェイト部
];

export class BaseCollisionGeometry {
  // 全 LOD を覆う外接球の半径 [m]。
  public readonly outerRadius = 330;

  private readonly lod0BVH: BVHNode | null; // フルポリゴン
  private readonly lod1BVH: BVHNode | null; // 低ポリゴン

  // 構築コストが高いので、1つを基地ごとに使い回す。
  constructor() {
    this.lod0BVH = buildBVH(collectModelTriangles());
    this.lod1BVH = buildBVH(boxTriangles(LOD1_BOXES));
  }

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
    const hitLocal = warpLevel <= 1
      ? raycastTriangles(localOrigin, localDir, maxDist, this.lod0BVH)
      : warpLevel <= 16
        ? raycastTriangles(localOrigin, localDir, maxDist, this.lod1BVH)
        : raycastOBBs(localOrigin, localDir, maxDist, LOD2_OBBS);
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
    const hitLocal = warpLevel <= 1
      ? sphereCollideTriangles(localCenter, sphereRadius, this.lod0BVH)
      : warpLevel <= 16
        ? sphereCollideTriangles(localCenter, sphereRadius, this.lod1BVH)
        : sphereCollideOBBs(localCenter, sphereRadius, LOD2_OBBS);
    if (!hitLocal) return null;

    // 4. ワールド座標系へ逆変換
    return {
      point: add(basePos, qRotate(baseAtt, hitLocal.point)),
      normal: norm(qRotate(baseAtt, hitLocal.normal)),
      depth: hitLocal.depth,
    };
  }
}

/** 描画モデルの全メッシュを基地ローカル座標の三角形へ焼き直す。 */
function collectModelTriangles(): Triangle[] {
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

      // 子メッシュの変換を掛けてから、退化していない面だけを積む。
      const matrix = child.matrixWorld;
      for (let i = 0; i < posAttr.count; i += 3) {
        vA.fromBufferAttribute(posAttr, i).applyMatrix4(matrix);
        vB.fromBufferAttribute(posAttr, i + 1).applyMatrix4(matrix);
        vC.fromBufferAttribute(posAttr, i + 2).applyMatrix4(matrix);

        const pA = v3(vA.x, vA.y, vA.z);
        const pB = v3(vB.x, vB.y, vB.z);
        const pC = v3(vC.x, vC.y, vC.z);

        const n = norm(cross(sub(pB, pA), sub(pC, pA)));
        if (lenSq(n) > 1e-6) {
          triangles.push({ a: pA, b: pB, c: pC, normal: n });
        }
      }
    }
  });
  return triangles;
}

/** 箱の集合を、外向き法線を持つ三角形の集合へ展開する。 */
function boxTriangles(boxes: readonly OBB[]): Triangle[] {
  const triangles: Triangle[] = [];
  for (const { center: c, halfSizes: h } of boxes) {
    // 箱の8頂点を、各軸の符号の組み合わせで並べる。
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

    // 4頂点の面を、共通の外向き法線を持つ2枚の三角形へ割る。
    const addQuad = (i0: number, i1: number, i2: number, i3: number, normal: Vec3) => {
      triangles.push({ a: p[i0]!, b: p[i1]!, c: p[i2]!, normal });
      triangles.push({ a: p[i0]!, b: p[i2]!, c: p[i3]!, normal });
    };

    // 6面をすべて外向きに張る。
    addQuad(0, 3, 2, 1, v3(0, 0, -1)); // -Z
    addQuad(4, 5, 6, 7, v3(0, 0, 1));  // +Z
    addQuad(0, 1, 5, 4, v3(0, -1, 0)); // -Y
    addQuad(3, 7, 6, 2, v3(0, 1, 0));  // +Y
    addQuad(0, 4, 7, 3, v3(-1, 0, 0)); // -X
    addQuad(1, 2, 6, 5, v3(1, 0, 0));  // +X
  }
  return triangles;
}

/** 箱の集合へレイを飛ばし、maxDist 以内で最も手前の交差を返す。当たらなければ null。 */
function raycastOBBs(origin: Vec3, dir: Vec3, maxDist: number, obbs: readonly OBB[]): RayHit | null {
  let closestHit: RayHit | null = null;
  let currentMax = maxDist;

  for (const obb of obbs) {
    const min = sub(obb.center, obb.halfSizes);
    const max = add(obb.center, obb.halfSizes);
    if (!rayIntersectsAABB(origin, dir, currentMax, min, max)) continue;

    // 最後に入ったスラブが入射面を決めるので、その軸の向きを法線として採る。
    let tmin = 0;
    let hitNormal = v3(0, 0, 1);
    for (const axis of ['x', 'y', 'z'] as const) {
      if (Math.abs(dir[axis]) < 1e-9) continue;
      const invD = 1 / dir[axis];
      const entryT = Math.min((min[axis] - origin[axis]) * invD, (max[axis] - origin[axis]) * invD);
      if (entryT > tmin) {
        tmin = entryT;
        hitNormal = axis === 'x' ? v3(dir.x > 0 ? -1 : 1, 0, 0)
          : axis === 'y' ? v3(0, dir.y > 0 ? -1 : 1, 0)
            : v3(0, 0, dir.z > 0 ? -1 : 1);
      }
    }
    if (tmin > 0 && tmin < currentMax) {
      currentMax = tmin;
      closestHit = { point: add(origin, scale(dir, tmin)), normal: hitNormal, distance: tmin };
    }
  }
  return closestHit;
}

/** 箱の集合へ球を当て、最も深くめり込んだ接触を返す。触れていなければ null。 */
function sphereCollideOBBs(center: Vec3, radius: number, obbs: readonly OBB[]): SphereHit | null {
  let deepestHit: SphereHit | null = null;

  for (const obb of obbs) {
    const closestPt = v3(
      Math.max(obb.center.x - obb.halfSizes.x, Math.min(obb.center.x + obb.halfSizes.x, center.x)),
      Math.max(obb.center.y - obb.halfSizes.y, Math.min(obb.center.y + obb.halfSizes.y, center.y)),
      Math.max(obb.center.z - obb.halfSizes.z, Math.min(obb.center.z + obb.halfSizes.z, center.z)),
    );

    const diff = sub(center, closestPt);
    const dist = len(diff);
    if (dist >= radius) continue;
    const depth = radius - dist;
    if (deepestHit !== null && depth <= deepestHit.depth) continue;
    // 中心が箱の内側にあると押し戻す向きが定まらないので、そのときだけ上向きへ逃がす。
    deepestHit = { point: closestPt, normal: dist > 1e-6 ? norm(diff) : v3(0, 1, 0), depth };
  }
  return deepestHit;
}
