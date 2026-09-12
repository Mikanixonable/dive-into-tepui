// タンパク質の模型上の座標と、個体の位置・姿勢で測るワールド座標の間の変換。当たり判定(規則)と
// 表示(装置)の両方がここを読む。調整値を含まない厳密な幾何で、模型座標は原構造の [Å]、
// ワールド座標は [m]。
import { qInvert, qRotate, type Quat } from '../math/quat';
import { add, sub, v3, type Vec3 } from '../math/vec3';

// 部位の静止座標 [Å]。原構造の座標系でそのまま持つ。
export type ProteinSitePosition = readonly [number, number, number];

// 部位の静止座標と、そのフレームの残基変位(どちらも模型座標)から、ワールド座標を求める。
// coordinateScale は [Å] から模型座標への倍率、rootScale は模型そのものの倍率。
// 部位を持たないときは origin をそのまま返す。
export function proteinSiteWorldPosition(
  sitePosition: ProteinSitePosition | null,
  residueOffset: ProteinSitePosition,
  coordinateScale: number,
  rootScale: number,
  origin: Vec3,
  attitude: Quat,
): Vec3 {
  if (sitePosition === null) return origin;
  const scale = coordinateScale * rootScale;
  const local = v3(
    (sitePosition[0] + residueOffset[0]) * scale,
    (sitePosition[1] + residueOffset[1]) * scale,
    (sitePosition[2] + residueOffset[2]) * scale,
  );
  return add(origin, qRotate(attitude, local));
}

// ワールド座標の着弾点を、root の倍率を外した模型ローカル座標へ写す。
export function proteinLocalImpactPoint(
  worldPoint: Vec3, origin: Vec3, attitude: Quat, rootScale: number,
): Vec3 {
  const oriented = qRotate(qInvert(attitude), sub(worldPoint, origin));
  return v3(oriented.x / rootScale, oriented.y / rootScale, oriented.z / rootScale);
}
