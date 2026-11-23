import { clamp, dot, length, log2, max, select, tan } from 'three/tsl';
import type { FloatNode, Vec3Node } from '../../tsl-types';

// 均しの広さ: 均すのに読む段の画素の一辺の、像のぼけの短い軸の幅に対する比。斜めから見た面の映り込みは、入射面の中へは
// ローブの半幅どおりにぼけ、入射面に垂直な向きへはその約 N·V 倍しかぼけない。像のぼけは追跡の向きのジッターが縦横とも
// 作るので、均しはまだらを消す幅でよい。
const DENOISE_WIDTH_PER_SHORT_AXIS = 0.756;
// 入射面の中で法線が回ると、反射の向きはその 2 倍回る。
const REFLECTED_ROTATION_PER_NORMAL_ROTATION = 2;

// 位置 position [m]、法線 normal、鏡面ローブの半幅 lobeHalfWidth [rad]、視線 viewDir、当たり距離 distance [m]、
// 焦点距離 focalLength [px]、法線の回転 normalRate [rad/px]、最粗段 coarsestLevel、固定段 fixedLevel から読む段を返す。
// fixedLevel が負なら見積もる。
export function reflectionDenoiseLevelOf(
  position: Vec3Node, normal: Vec3Node, lobeHalfWidth: FloatNode, viewDir: Vec3Node,
  distance: FloatNode, focalLength: FloatNode, normalRate: FloatNode, coarsestLevel: FloatNode, fixedLevel: FloatNode,
): FloatNode {
  const range = length(position).toVar();
  // 鏡像は視線の延長上、視点から |P| + d の所にある。
  const mirrorDepth = position.z.negate().mul(range.add(distance)).div(range);
  const facing = dot(normal, viewDir).toVar();
  // 受け手が 1 画素動いたときの、入射面に垂直な向きの当たりの点の動き [m]。平らな鏡の分に、法線が回る分を足す。後者には
  // ローブの幅と同じく N·V が掛かるので、法線が回る分が支配的な曲面では、像のぼけ幅から N·V が消える。
  const travel = mirrorDepth.div(focalLength)
    .add(distance.mul(normalRate).mul(REFLECTED_ROTATION_PER_NORMAL_ROTATION).mul(facing));
  const shortAxis = distance.mul(tan(lobeHalfWidth)).mul(2).mul(facing).div(max(travel, 1e-9));
  const estimated = clamp(log2(max(shortAxis.mul(DENOISE_WIDTH_PER_SHORT_AXIS), 1)), 0, coarsestLevel);
  return select(fixedLevel.greaterThanEqual(0), fixedLevel.min(coarsestLevel), estimated);
}
