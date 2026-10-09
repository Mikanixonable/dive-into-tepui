// 滑らかな面の映り込みを、描画バッファの解像度の 1 つの描画先(2 枚)として渡す。画素ごとに、近くの物体の像が
// 遠方の鏡面光を置き換える重み w と、それを掛けた当たった点の像 w × I と当たるまでの距離 w × d を持つ。重みを
// 掛けた形で持つので、2 枚を同じ重みで均せば 3 つの量が同じカーネルで均れる。
import * as THREE from 'three/webgpu';
import { float, mrt, texture, vec4 } from 'three/tsl';
import type { FloatNode, Vec2Node, Vec3Node, Vec4Node } from '../../tsl-types';

// 1 画素ぶんの映り込みを描画先の出力へ符号化する。image は当たった点の像 I(放射輝度)、distance は反射する面から
// 当たった点までの view 空間の距離 [m]、weight は置換の重み w(0 以上。画素ごとには 1 をわずかに超えうるが、期待値は
// 1 以下)。当たらなかった画素は w = 0 で書くこと — w = 0 が「遠方の鏡面光をそのまま残す」を表す。
export function encodedReflection(image: Vec3Node, distance: FloatNode, weight: FloatNode): ReturnType<typeof mrt> {
  return mrt({
    weightedReflection: vec4(image.mul(weight), weight),
    weightedReflectionDistance: vec4(distance.mul(weight), 0, 0, 1),
  });
}

export class ScreenSpaceReflection {
  // 描画バッファの解像度の映り込み。0 枚目は rgb = w × I、a = w。1 枚目は r = w × d [m]。
  public readonly target = new THREE.RenderTarget(1, 1, {
    count: 2, depthBuffer: false, samples: 0, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
  });

  // 描画先の形式と名前を決める。名前は MRT の出力と結び付く。
  public constructor() {
    const [weighted, distance] = this.target.textures;
    weighted!.name = 'weightedReflection';
    weighted!.format = THREE.RGBAFormat;
    weighted!.type = THREE.HalfFloatType;
    distance!.name = 'weightedReflectionDistance';
    distance!.format = THREE.RedFormat;
    distance!.type = THREE.HalfFloatType;
  }

  // uv(0..1)の画素の、重みを掛けた像 w × I(放射輝度。鏡面反射率を掛ける前)。
  public weightedImageAt(uv: Vec2Node): Vec3Node { return this.weightedTexelAt(uv).rgb; }

  // uv(0..1)の画素の置換の重み w。
  public weightAt(uv: Vec2Node): FloatNode { return this.weightedTexelAt(uv).a; }

  // uv(0..1)の画素の、重みを掛けた当たるまでの距離 w × d [m]。
  public weightedDistanceAt(uv: Vec2Node): FloatNode {
    return texture(this.target.textures[1]!, uv).level(float(0)).r;
  }

  // 段を明示して読む — 暗黙の段は画素の間の微分で決まり、一様でない分岐の中では組めない。段は 1 つだけ。
  private weightedTexelAt(uv: Vec2Node): Vec4Node { return texture(this.target.textures[0]!, uv).level(float(0)); }

  // 描画先を解放する。
  public dispose(): void {
    this.target.dispose();
  }
}
