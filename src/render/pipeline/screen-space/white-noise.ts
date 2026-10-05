// 画素ごと・パスごと・成分ごとに互いに独立な一様な値(ホワイトノイズ)。多くのパスを平均する計測で、ブルーノイズの
// タイルのずれの数に縛られずに独立な標本を引くためのもの。
import { float, uint } from 'three/tsl';
import type { FloatNode, UintNode, Vec2Node } from '../../tsl-types';

// PCG の 1 段の整数ハッシュ(Jarzynski, Olano 2020「Hash Functions for GPU Rendering」)。u32 の掛け算と足し算は 2³² で
// 回る。
function pcgHash(value: UintNode): UintNode {
  const state = value.mul(uint(747796405)).add(uint(2891336453)).toVar();
  const word = state.shiftRight(state.shiftRight(uint(28)).add(uint(4))).bitXor(state).mul(uint(277803737)).toVar();
  return word.shiftRight(uint(22)).bitXor(word);
}

// 画素の整数座標 pixel・パスの番号 pass・成分の番号 component の組ごとの、(0, 1) の一様な値。
export function whiteNoiseAt(pixel: Vec2Node, pass: UintNode, component: number): FloatNode {
  const key = pcgHash(pcgHash(pcgHash(pcgHash(uint(pixel.x)).add(uint(pixel.y))).add(pass)).add(uint(component)));
  // 上位 24 ビットを開区間へ写す。
  return float(key.shiftRight(uint(8))).add(0.5).div(16777216);
}
