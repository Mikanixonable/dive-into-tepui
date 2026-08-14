// フレーム最初のパス: lit-opaque 層(lit-layer.ts)のオブジェクトだけを対象に、深度・法線・
// ラフネスを MRT(複数レンダーターゲット)へ描く。
//
// シーンの実マテリアルをそのまま描く。renderer.setMRT を張った状態では NodeMaterial が
// 自前の出力ノードを MRT ノードで置き換えるため、ライティングのグラフは生成されないまま
// roughness などのシェーダ変数だけが確定する — overrideMaterial もマテリアルの改変も要らない。
import * as THREE from 'three/webgpu';
import { WebGPURenderer } from 'three/webgpu';
import { abs, float, mrt, normalize, normalView, roughness, select, step, vec3 } from 'three/tsl';
import { GPU_PASS, type GpuTimings } from '../../gpu-timings';
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
  private readonly renderer: WebGPURenderer;
  private readonly target: THREE.RenderTarget;
  private readonly mrtNode: ReturnType<typeof mrt>;

  // normal/roughness の2枚 MRT ターゲットとそれぞれのフォーマットを構築し、出力ノード
  // (法線は octEncodeNormal 経由、ラフネスはそのまま)を一度だけ組み立てる。
  constructor(renderer: WebGPURenderer, private readonly gpu: GpuTimings) {
    this.renderer = renderer;

    // モデル間の境界をマルチサンプルで平均すると、法線がどちらの面にも属さない方向に
    // なってしまうため、G バッファはマルチサンプルしない。
    this.target = new THREE.RenderTarget(1, 1, { count: 2, depthBuffer: true, samples: 0 });
    const [normalTex, roughnessTex] = this.target.textures;
    normalTex!.name = 'normal';
    normalTex!.format = THREE.RGFormat;
    normalTex!.type = THREE.HalfFloatType;
    roughnessTex!.name = 'roughness';
    roughnessTex!.format = THREE.RedFormat;
    roughnessTex!.type = THREE.UnsignedByteType;
    this.target.depthTexture = new THREE.DepthTexture(1, 1);

    this.mrtNode = mrt({
      normal: octEncodeNormal(normalView),
      roughness,
    });
  }

  get normalTexture(): THREE.Texture { return this.target.textures[0]!; }
  get roughnessTexture(): THREE.Texture { return this.target.textures[1]!; }
  get depthTexture(): THREE.DepthTexture { return this.target.depthTexture!; }

  // lit-opaque 層のオブジェクトだけを G バッファへ描く。camera はこのあと world パスでも
  // 使う同一インスタンスなので、layers.mask は呼び出し前の値へ必ず戻す。
  render(scene: THREE.Scene, camera: THREE.Camera, width: number, height: number): void {
    if (this.target.width !== width || this.target.height !== height) this.target.setSize(width, height);

    const savedMask = camera.layers.mask;
    camera.layers.set(LIT_OPAQUE_LAYER);

    this.renderer.setMRT(this.mrtNode);
    this.renderer.setRenderTarget(this.target);
    // beginPass はこのあとの renderer.render() 呼び出しの直前に呼び、GPU 計測の対象パスを申告する。
    this.gpu.beginPass(GPU_PASS.gbuffer);
    this.renderer.render(scene, camera);
    this.renderer.setRenderTarget(null);
    this.renderer.setMRT(null);

    camera.layers.mask = savedMask;
  }

  // 保持している GPU 資源を解放する。
  dispose(): void {
    this.target.dispose();
  }
}
