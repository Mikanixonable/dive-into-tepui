// 遮蔽と照り返しのパスが出す、環境光ごとの遮られずに届く割合と照り返しの放射照度。描画先と、そこへの
// 詰め方(encode)と、光源からの読み方を持つ。
import * as THREE from 'three/webgpu';
import { clamp, float, max, select, texture, vec4 } from 'three/tsl';
import type { ShadingSample } from '../lighting/shading-sample';
import type { FloatNode, Vec2Node, Vec3Node, Vec4Node } from '../../tsl-types';

// 範囲の測度がこれ未満の光は、走査がその向きの塞がれ方を 1 標本も数えていない。半精度浮動小数の
// 揺らぎより十分大きく取る。
const MIN_EXTENT = 1e-3;

// 全解像度の描画先。textures[0] が光ごとの割合、textures[1] が照り返し(どちらも rgba16float)。
function createTarget(): THREE.RenderTarget {
  const target = new THREE.RenderTarget(1, 1, {
    count: 2, type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, samples: 0,
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
  });
  const [visibility, indirect] = target.textures;
  visibility!.name = 'visibility';
  indirect!.name = 'indirect';
  return target;
}

export class ScreenSpaceLight {
  // 遮蔽と照り返しのパスが拡大の段で書く描画先。textures[0] = 光ごとの遮られずに届く割合(r = 一様な
  // 環境光、g・b = 天体照のスロット 0・1、a = 環境光の鏡面)、textures[1] = rgb 照り返しの放射照度。
  public readonly target = createTarget();

  // 塞がれた測度 occluded(x = 空全体、y・z = 球冠 0・1、w = ローブ)と、数える範囲の測度 extent を、
  // 光ごとの遮られずに届く割合 0..1 へ詰める。範囲を 1 標本も数えていない光は遮られないとする。
  public static encode(occluded: Vec4Node, extent: Vec3Node): Vec4Node {
    return vec4(
      clamp(occluded.x.oneMinus(), 0, 1),
      visibleFraction(occluded.y, extent.x),
      visibleFraction(occluded.z, extent.y),
      visibleFraction(occluded.w, extent.z),
    );
  }

  // 受け手 sample へ一様な環境光が遮られずに届く割合 0..1。
  public ambientVisibility(sample: ShadingSample): FloatNode {
    return this.ambientVisibilityAt(sample.uv);
  }

  // 受け手 sample へスロット slot の天体照が遮られずに届く割合 0..1。
  public planetVisibility(sample: ShadingSample, slot: number): FloatNode {
    const packed = this.packedAt(sample.uv);
    return slot === 0 ? packed.g : packed.b;
  }

  // 受け手 sample の鏡面のローブのうち、遮られていない割合 0..1。
  public specularVisibility(sample: ShadingSample): FloatNode {
    return this.packedAt(sample.uv).a;
  }

  // 受け手 sample が近くの面から受ける照り返しの放射照度(SUN_IRRADIANCE_1AU の目盛り)。
  public indirect(sample: ShadingSample): Vec3Node {
    return this.indirectAt(sample.uv);
  }

  // 画面の uv の画素へ一様な環境光が遮られずに届く割合 0..1。
  public ambientVisibilityAt(uv: Vec2Node): FloatNode {
    return this.packedAt(uv).r;
  }

  // 画面の uv の画素が受ける照り返しの放射照度。
  public indirectAt(uv: Vec2Node): Vec3Node {
    return texture(this.target.textures[1]!, uv).rgb;
  }

  // 画面の uv の画素に詰められた、光ごとの割合。
  private packedAt(uv: Vec2Node): Vec4Node {
    return texture(this.target.textures[0]!, uv);
  }

  // 保持している GPU 資源を解放する。
  public dispose(): void {
    this.target.dispose();
  }
}

// 測度 extent の範囲のうち occluded が塞がれているときの、遮られずに届く割合 0..1。
function visibleFraction(occluded: FloatNode, extent: FloatNode): FloatNode {
  const visible = clamp(occluded.div(max(extent, MIN_EXTENT)).oneMinus(), 0, 1);
  return select(extent.greaterThan(MIN_EXTENT), visible, float(1));
}
