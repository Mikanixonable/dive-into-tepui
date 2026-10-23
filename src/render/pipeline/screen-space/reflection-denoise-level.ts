import { clamp, dot, length, log2, max, tan } from 'three/tsl';
import type { FloatNode, Vec3Node } from '../../tsl-types';

// 均しの広さ: 均すのに読む段の画素の一辺の、像のぼけの短い軸の幅に対する比。短い軸の幅は、鏡像の奥行きへ写した鏡面
// ローブの円の直径に N·V を掛けたもの — 斜めから見た面の映り込みは、入射面の中へはローブの半幅どおりにぼけ、入射面に
// 垂直な向きへはその約 N·V 倍しかぼけない。像のぼけは追跡の向きのジッターが縦横とも作るので、均しはまだらを消す幅でよい。
const DENOISE_WIDTH_PER_SHORT_AXIS = 1;

// 位置 position [m]、法線 normal、鏡面ローブの半幅 lobeHalfWidth [rad]、視線 viewDir、当たり距離 distance [m]、
// 焦点距離 focalLength [px]、いちばん粗い段 coarsestLevel から、受け手の像のぼけ幅に応じた段を返す。
export function reflectionDenoiseLevelOf(
  position: Vec3Node, normal: Vec3Node, lobeHalfWidth: FloatNode, viewDir: Vec3Node,
  distance: FloatNode, focalLength: FloatNode, coarsestLevel: FloatNode,
): FloatNode {
  const range = length(position).toVar();
  // 鏡像は視線の延長上、視点から |P| + d の所にある。
  const mirrorDepth = position.z.negate().mul(range.add(distance)).div(range);
  const diameter = distance.mul(tan(lobeHalfWidth)).mul(focalLength).div(mirrorDepth).mul(2);
  const shortAxis = diameter.mul(dot(normal, viewDir));
  return clamp(log2(max(shortAxis.mul(DENOISE_WIDTH_PER_SHORT_AXIS), 1)), 0, coarsestLevel);
}
