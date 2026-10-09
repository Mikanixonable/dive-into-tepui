// 滑らかな面の映り込みを、描画バッファの解像度の 2 つの描画先として渡す。均す前の描画先は画素ごとに、近くの物体の
// 像が遠方の鏡面光を置き換える重み w と、それを掛けた当たった点の像 w × I と当たるまでの距離 w × d を持つ。均した
// 描画先は、同じ 3 つの量を粗さに応じて近傍で均した (w × I)‾・w̄・(w × d)‾ と、均すのに読んだ段を持つ。重みを掛けた
// 形で持つので、同じ重みで均せば 3 つの量が同じカーネルで均れる。
import * as THREE from 'three/webgpu';
import { float, mrt, select, texture, textureLoad, vec4 } from 'three/tsl';
import type { FloatNode, IVec2Node, Vec2Node, Vec3Node, Vec4Node } from '../../tsl-types';

// 均した描画先の段の符号。w̄ が正の画素は段 + DENOISE_LEVEL_CODE_OFFSET、w̄ が 0 の画素は UNWEIGHTED_DENOISE_LEVEL_CODE を
// 書き、空へ戻した 0 は書いていないことを表す。three のマテリアルは出力を 0 で下から切るので、負の値で印を付けられない。
const DENOISE_LEVEL_CODE_OFFSET = 2;
const UNWEIGHTED_DENOISE_LEVEL_CODE = 1;

// 1 画素ぶんの均す前の映り込みを描画先の出力へ符号化する。image は当たった点の像 I(放射輝度)、distance は反射する面から
// 当たった点までの view 空間の距離 [m]、weight は置換の重み w(0 以上。画素ごとには 1 をわずかに超えうるが、期待値は
// 1 以下)。当たらなかった画素は w = 0 で書くこと — w = 0 が「遠方の鏡面光をそのまま残す」を表す。
export function encodedRawReflection(image: Vec3Node, distance: FloatNode, weight: FloatNode): ReturnType<typeof mrt> {
  return mrt({
    rawWeightedReflection: vec4(image.mul(weight), weight),
    rawWeightedReflectionDistance: vec4(distance.mul(weight), 0, 0, 1),
  });
}

// 1 画素ぶんの均した映り込みを描画先の出力へ符号化する。weightedImage / weight / weightedDistance は均した (w × I)‾・w̄・
// (w × d)‾ で、level は均すのに読んだ段(小数)。段の符号は w̄ が正の画素で level、0 の画素で「w̄ = 0」の印になる。
export function encodedDenoisedReflection(
  weightedImage: Vec3Node, weight: FloatNode, weightedDistance: FloatNode, level: FloatNode,
): ReturnType<typeof mrt> {
  const levelCode = select(weight.greaterThan(0), level.add(DENOISE_LEVEL_CODE_OFFSET), float(UNWEIGHTED_DENOISE_LEVEL_CODE));
  return mrt({
    denoisedWeightedReflection: vec4(weightedImage, weight),
    denoisedWeightedReflectionDistance: vec4(weightedDistance, 0, 0, 1),
    reflectionDenoiseLevel: vec4(levelCode, 0, 0, 1),
  });
}

// 描画バッファの解像度の、深度を持たない半精度の描画先。names は添付ごとのテクスチャの名前(MRT の出力と結び付く)
// と形式。
function reflectionTarget(names: readonly (readonly [string, THREE.PixelFormat])[]): THREE.RenderTarget {
  const target = new THREE.RenderTarget(1, 1, {
    count: names.length, depthBuffer: false, samples: 0,
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
  });
  // 添付ごとの名前と形式。
  for (const [index, [name, format]] of names.entries()) {
    const attachment = target.textures[index]!;
    attachment.name = name;
    attachment.format = format;
    attachment.type = THREE.HalfFloatType;
  }
  return target;
}

export class ScreenSpaceReflection {
  // 均す前の映り込み。0 枚目は rgb = w × I、a = w。1 枚目は r = w × d [m]。
  public readonly rawTarget = reflectionTarget([
    ['rawWeightedReflection', THREE.RGBAFormat], ['rawWeightedReflectionDistance', THREE.RedFormat],
  ]);
  // 均した映り込み。0 枚目は rgb = (w × I)‾、a = w̄。1 枚目は r = (w × d)‾ [m]。2 枚目は r = 段の符号。
  public readonly denoisedTarget = reflectionTarget([
    ['denoisedWeightedReflection', THREE.RGBAFormat], ['denoisedWeightedReflectionDistance', THREE.RedFormat],
    ['reflectionDenoiseLevel', THREE.RedFormat],
  ]);

  // uv(0..1)の画素の、均す前の重みを掛けた像 w × I(放射輝度。鏡面反射率を掛ける前)。
  public rawWeightedImageAt(uv: Vec2Node): Vec3Node { return texelAt(this.rawTarget, 0, uv).rgb; }

  // uv(0..1)の画素の、均す前の置換の重み w。
  public rawWeightAt(uv: Vec2Node): FloatNode { return texelAt(this.rawTarget, 0, uv).a; }

  // uv(0..1)の画素の、均す前の重みを掛けた当たるまでの距離 w × d [m]。
  public rawWeightedDistanceAt(uv: Vec2Node): FloatNode { return texelAt(this.rawTarget, 1, uv).r; }

  // 描画画素 pixel(整数の座標)の、均す前の重みを掛けた像と置換の重み(rgb = w × I、a = w)。
  public rawWeightedReflectionOfPixel(pixel: IVec2Node): Vec4Node {
    return textureLoad(this.rawTarget.textures[0]!, pixel);
  }

  // 描画画素 pixel(整数の座標)の、均す前の重みを掛けた当たるまでの距離 w × d [m]。
  public rawWeightedDistanceOfPixel(pixel: IVec2Node): FloatNode {
    return textureLoad(this.rawTarget.textures[1]!, pixel).r;
  }

  // uv(0..1)の画素の、均した重みを掛けた像 (w × I)‾(放射輝度。鏡面反射率を掛ける前)。
  public denoisedWeightedImageAt(uv: Vec2Node): Vec3Node { return texelAt(this.denoisedTarget, 0, uv).rgb; }

  // uv(0..1)の画素の、均した置換の重み w̄。
  public denoisedWeightAt(uv: Vec2Node): FloatNode { return texelAt(this.denoisedTarget, 0, uv).a; }

  // uv(0..1)の画素の、均した重みを掛けた当たるまでの距離 (w × d)‾ [m]。
  public denoisedWeightedDistanceAt(uv: Vec2Node): FloatNode { return texelAt(this.denoisedTarget, 1, uv).r; }

  // uv(0..1)の画素を均すのに読んだ段(小数)。w̄ が 0 の画素は −1、均した値を書いていない(映り込みを切った)フレームは
  // −2。
  public denoiseLevelAt(uv: Vec2Node): FloatNode {
    return texelAt(this.denoisedTarget, 2, uv).r.sub(DENOISE_LEVEL_CODE_OFFSET);
  }

  // 描画先を解放する。
  public dispose(): void {
    this.rawTarget.dispose();
    this.denoisedTarget.dispose();
  }
}

// 描画先 target の index 枚目を uv(0..1)で読む。段を明示して読む — 暗黙の段は画素の間の微分で決まり、一様でない
// 分岐の中では組めない。段は 1 つだけ。
function texelAt(target: THREE.RenderTarget, index: number, uv: Vec2Node): Vec4Node {
  return texture(target.textures[index]!, uv).level(float(0));
}
