// フレーム最初のパス: lit-opaque 層(lit-layer.ts)のオブジェクトだけを対象に、深度・法線・
// ラフネス・ベース色・金属度・自己発光を MRT(複数レンダーターゲット)へ描く。
import * as THREE from 'three/webgpu';
import { WebGPURenderer } from 'three/webgpu';
import {
  abs, diffuseColor, emissive, float, metalness, mrt, normalize, normalView, roughness, select, step, vec3, vec4,
} from 'three/tsl';
import { GPU_PASS, type GpuTimings } from '../gpu-timings';
import { LIT_OPAQUE_LAYER } from './lit-layer';
import type { Vec2Node, Vec3Node } from '../tsl-types';

// v の各成分が 0 以上なら +1、そうでなければ -1 を返す。TSL の sign() は 0 で 0 を返すため、
// 下記 octEncodeNormal の折り返しがそこで壊れる — 自前で書く。
function signNotZero(v: Vec2Node): Vec2Node {
  return step(0, v).mul(2).sub(1);
}

// view space 法線 n(正規化済み、法線マップ適用後)を octahedral encoding で vec2 の 0..1
// レンジへ詰める。読み手はこの逆写像で復号するので、写像を変えるときは両方を同時に直す。
//   p = n.xy / (|n.x| + |n.y| + |n.z|)
//   n.z < 0 のとき p = (1 - |p.yx|) * signNotZero(p)
//   出力 = p * 0.5 + 0.5
function octEncodeNormal(n: Vec3Node): Vec2Node {
  const l1Norm = abs(n.x).add(abs(n.y)).add(abs(n.z));
  const p = n.xy.div(l1Norm);
  const folded = float(1).sub(p.yx.abs()).mul(signNotZero(p));
  const encoded = select(n.z.lessThan(0), folded, p);
  return encoded.mul(0.5).add(0.5);
}

// octEncodeNormal の逆写像。0..1 レンジの rg から view space 単位法線を復元する。
//   e = raw * 2 - 1
//   n = vec3(e.x, e.y, 1 - |e.x| - |e.y|)
//   n.z < 0 のとき n.xy = (1 - |n.yx|) * signNotZero(n.xy)
//   normalize(n)
export function octDecodeNormal(raw: Vec2Node): Vec3Node {
  const e = raw.mul(2).sub(1);
  const nz = float(1).sub(abs(e.x)).sub(abs(e.y));
  const folded = float(1).sub(e.yx.abs()).mul(signNotZero(e));
  const xy = select(nz.lessThan(0), folded, e);
  return normalize(vec3(xy, nz));
}

export class GBufferPass {
  private readonly target: THREE.RenderTarget;
  private readonly mrtNode: ReturnType<typeof mrt>;

  // ターゲットは 1×1 で作り、render() が画面寸法へ合わせる。
  public constructor(private readonly renderer: WebGPURenderer, private readonly gpu: GpuTimings) {
    // モデル間の境界をマルチサンプルで平均すると、法線がどちらの面にも属さない方向に
    // なってしまうため、G バッファはマルチサンプルしない。
    this.target = new THREE.RenderTarget(1, 1, { count: 4, depthBuffer: true, samples: 0 });
    const [normalTex, roughnessTex, basecolorTex, emissiveTex] = this.target.textures;
    normalTex!.name = 'normal';
    normalTex!.format = THREE.RGFormat;
    normalTex!.type = THREE.HalfFloatType;
    roughnessTex!.name = 'roughness';
    roughnessTex!.format = THREE.RedFormat;
    roughnessTex!.type = THREE.UnsignedByteType;
    // ベース色は線形の 8bit。α へ金属度を同居させるのは、この2つを読む側が常に同時に使うため。
    basecolorTex!.name = 'basecolor';
    basecolorTex!.format = THREE.RGBAFormat;
    basecolorTex!.type = THREE.UnsignedByteType;
    // 自己発光は 1 を超えうる HDR 値なので半精度浮動小数点で持つ。
    emissiveTex!.name = 'emissive';
    emissiveTex!.format = THREE.RGBAFormat;
    emissiveTex!.type = THREE.HalfFloatType;
    // 深度は 32bit 浮動小数点。RenderTarget の深度が自動で depth32float になるのは
    // キャンバス直描きのときだけで、明示しないと depth24plus のまま — 絵は正常なのに
    // 精度だけ落ちる。
    this.target.depthTexture = new THREE.DepthTexture(1, 1, THREE.FloatType);

    // MRT の名前はターゲットのテクスチャ名で添付先へ結び付く。成分数も添付のフォーマットに
    // 合わせる — 自己発光は vec3 だが、rgba16float の添付には 4 成分の出力が要る。
    this.mrtNode = mrt({
      normal: octEncodeNormal(normalView),
      roughness,
      basecolor: vec4(diffuseColor.rgb, metalness),
      emissive: vec4(emissive, 1),
    });
  }

  public get normalTexture(): THREE.Texture { return this.target.textures[0]!; }
  public get roughnessTexture(): THREE.Texture { return this.target.textures[1]!; }
  // rgb がベース色(線形)、a が金属度。何も描かれなかった画素は a が 1 のままなので、物体の
  // 有無は depthTexture(クリア値 0 が反転 Z の far)で判定する。
  public get basecolorTexture(): THREE.Texture { return this.target.textures[2]!; }
  public get emissiveTexture(): THREE.Texture { return this.target.textures[3]!; }
  public get depthTexture(): THREE.DepthTexture { return this.target.depthTexture!; }

  // lit-opaque 層のオブジェクトだけを G バッファへ描く。camera はこのあと world パスでも
  // 使う同一インスタンスなので、layers.mask は呼び出し前の値へ必ず戻す。
  public render(scene: THREE.Scene, camera: THREE.Camera, width: number, height: number): void {
    if (this.target.width !== width || this.target.height !== height) this.target.setSize(width, height);

    const savedMask = camera.layers.mask;
    camera.layers.set(LIT_OPAQUE_LAYER);

    this.renderer.setMRT(this.mrtNode);
    this.renderer.setRenderTarget(this.target);
    this.gpu.beginPass(GPU_PASS.gbuffer);
    this.renderer.render(scene, camera);
    this.renderer.setRenderTarget(null);
    this.renderer.setMRT(null);

    camera.layers.mask = savedMask;
  }

  // 保持している GPU 資源を解放する。
  public dispose(): void {
    this.target.dispose();
  }
}
