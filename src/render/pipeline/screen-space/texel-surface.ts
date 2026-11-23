// 走査の解像度の面の写しを読む口。G バッファの画素の値を、画素の座標とともに値のまま渡す。
import type * as THREE from 'three/webgpu';
import type { FloatNode, Vec2Node } from '../../tsl-types';

// G バッファの画素の整数座標。
export type Texel = THREE.Node<'ivec2'>;

// G バッファの画素 1 つの面。texel は画素の整数座標、depth は素の深度(0 なら面が写っていない)、encodedNormal は
// G バッファの法線の rg のまま(octDecodeNormal で戻す)。
export interface TexelSurface {
  readonly texel: Texel;
  readonly depth: FloatNode;
  readonly encodedNormal: Vec2Node;
}

// 走査の解像度の画素が表す面を読む。走査と最後の拡大は、全解像度の G バッファでなくこの面を読む。
export interface ScanSurfaces {
  // 走査の画素 pixel(整数座標)の面。
  scanSurfaceAt(pixel: Texel): TexelSurface;
}
