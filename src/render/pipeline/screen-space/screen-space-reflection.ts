// 滑らかな面の映り込みの判定結果を、描画バッファの解像度の 1 枚として渡す。画素ごとに、鏡の向きの ray が
// 当たった位置 hit uv・当たるまでの距離・近くの物体の像が遠方の鏡面光を置き換える重み w を持つ。
import * as THREE from 'three/webgpu';
import { float, texture, vec4 } from 'three/tsl';
import type { ShadingSample } from '../lighting/shading-sample';
import type { FloatNode, Vec2Node, Vec4Node } from '../../tsl-types';

// 1 画素ぶんの判定を描画先の texel へ符号化する。hitUV は当たった位置の uv(0..1、上端が原点)、distance は
// 反射する面から当たった点までの view 空間の距離 [m]、weight は置換の重み w(0..1)。当たらなかった画素は
// どれも 0 で書くこと — w = 0 が「遠方の鏡面光をそのまま残す」を表す。
export function encodedReflection(hitUV: Vec2Node, distance: FloatNode, weight: FloatNode): Vec4Node {
  return vec4(hitUV, distance, weight);
}

export class ScreenSpaceReflection {
  // 描画バッファの解像度の判定。rg = hit uv、b = 当たるまでの距離 [m]、a = w。
  public readonly target = new THREE.RenderTarget(1, 1, {
    type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, samples: 0,
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
  });

  // 描画先に名前を付ける。名前は MRT の出力と結び付く。
  public constructor() {
    this.target.texture.name = 'screenSpaceReflection';
  }

  public get texture(): THREE.Texture { return this.target.texture; }

  // sample の画素で、天体照と環境光の鏡面光へ掛ける係数 1 − w。当たらなかった画素と、映り込みを切っている
  // フレームでは厳密に 1。一様でない分岐の中から読んでよい。
  public farSpecularWeight(sample: ShadingSample): FloatNode {
    return float(1).sub(this.weightAt(sample.uv));
  }

  // uv(0..1)の画素の hit uv。当たらなかった画素は (0, 0)。
  public hitUVAt(uv: Vec2Node): Vec2Node { return this.texelAt(uv).rg; }

  // uv(0..1)の画素の、当たるまでの距離 [m]。当たらなかった画素は 0。
  public hitDistanceAt(uv: Vec2Node): FloatNode { return this.texelAt(uv).b; }

  // uv(0..1)の画素の置換の重み w。
  public weightAt(uv: Vec2Node): FloatNode { return this.texelAt(uv).a; }

  // 段を明示して読む — 暗黙の段は画素の間の微分で決まり、一様でない分岐の中では組めない。段は 1 つだけ。
  private texelAt(uv: Vec2Node): Vec4Node { return texture(this.texture, uv).level(float(0)); }

  // 描画先を解放する。
  public dispose(): void {
    this.target.dispose();
  }
}
