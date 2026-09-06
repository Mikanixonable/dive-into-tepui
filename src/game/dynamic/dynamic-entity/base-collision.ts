// 基地の当たり形状。表示モデルの部品ごとの凸包を焼いたローポリメッシュ
// (tools/export-base-collision.mjs が src/assets/models/baseCollision.json へ書く)を
// BVH へ載せ、基地ローカル座標のレイと球を判定する。
import { Vec3, v3, sub, cross, norm } from '../../../math/vec3';
import {
  RayHit, SphereHit, Triangle, TriangleBVH,
  buildBVH, raycastTriangles, sphereCollideTriangles,
} from '../../../math/triangle-mesh';
import bakedShape from '../../../assets/models/baseCollision.json';

// positions は基地ローカル座標 [m] の頂点を xyz 順に並べたもの、indices は三角形1枚あたり
// 3つの添字で、a → b → c が外を向く巻き。
interface BakedShape {
  readonly positions: readonly number[];
  readonly indices: readonly number[];
}

const shape = bakedShape as unknown as BakedShape;

/** 頂点列の index 番目を基地ローカル座標 [m] の点として読む。 */
function bakedVertex(index: number): Vec3 {
  const at = index * 3;
  return v3(shape.positions[at]!, shape.positions[at + 1]!, shape.positions[at + 2]!);
}

/** 焼いた添字列を、BVH がそのまま受け取れる三角形の列へ起こす。法線は巻きから求める。 */
function bakedTriangles(): Triangle[] {
  const triangles: Triangle[] = [];
  for (let i = 0; i < shape.indices.length; i += 3) {
    const a = bakedVertex(shape.indices[i]!);
    const b = bakedVertex(shape.indices[i + 1]!);
    const c = bakedVertex(shape.indices[i + 2]!);
    triangles.push({ a, b, c, normal: norm(cross(sub(b, a), sub(c, a))) });
  }
  return triangles;
}

/** 焼いた頂点列から外接半径を求める。手で書くと、モデルを変えたときに黙って覆いが崩れる。 */
function outerRadius(): number {
  let maxSquared = 0;
  for (let i = 0; i < shape.positions.length; i += 3) {
    const x = shape.positions[i]!;
    const y = shape.positions[i + 1]!;
    const z = shape.positions[i + 2]!;
    maxSquared = Math.max(maxSquared, x * x + y * y + z * z);
  }
  return Math.sqrt(maxSquared);
}

/** 当たり形状の全体を覆う外接半径 [m]。 */
export const BASE_COLLISION_RADIUS = outerRadius();

let sharedBVH: TriangleBVH | null = null;

/** 判定に使う BVH。構築に十数 ms 掛かるので、最初の呼び出しで1度だけ組んで共有する。 */
function collisionBVH(): TriangleBVH | null {
  if (sharedBVH === null) sharedBVH = buildBVH(bakedTriangles());
  return sharedBVH;
}

/** 基地ローカル座標のレイ。maxDist 以内で最も手前の交差を返す。当たらなければ null。 */
export function baseRaycast(origin: Vec3, dir: Vec3, maxDist: number): RayHit | null {
  return raycastTriangles(origin, dir, maxDist, collisionBVH());
}

/** 基地ローカル座標の球。最も深くめり込んだ接触を返す。触れていなければ null。 */
export function baseSphereCollide(center: Vec3, radius: number): SphereHit | null {
  return sphereCollideTriangles(center, radius, collisionBVH());
}
