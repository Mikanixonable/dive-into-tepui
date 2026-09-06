// G バッファ(法線・粗さ・深度)だけを読み、そのシェーディング点に届く光の量を拡散/鏡面の
// 2枚の照度バッファへ書く。素材のアルベド・金属度・F0 は一切知らない — それらを掛けて最終色を
// 出すのはマテリアルパスの役目で、このパスは「どれだけの光が、どこから届くか」だけを答える。
//
// 照度バッファを 0 でクリアし、光源 1 つにつきフルスクリーン 1 枚を加算合成で積む。寄与の
// 中身はそれぞれの光源(lighting/)が持ち、このパスは器に徹する。
//
// 面が写っていない画素の照度は 0 になる。
import * as THREE from 'three/webgpu';
import { QuadMesh, WebGPURenderer } from 'three/webgpu';
import { GPU_PASS, type GpuTimings } from '../gpu-timings';
import type { GBufferPass } from './gbuffer';
import type { LightSource } from './lighting/light-source';
import { ShadingSample } from './lighting/shading-sample';
import { compileInto } from './compile-into';

export class LightPrepass {
  private readonly renderer: WebGPURenderer;
  private readonly target: THREE.RenderTarget;
  private readonly quad: QuadMesh;
  private readonly sample: ShadingSample;
  // クリア色の退避先。毎フレーム確保しないよう 1 つだけ持つ。
  private readonly savedClearColor = new THREE.Color();

  // 照度バッファ 2 枚と、sources が共有するシェーディング入力を組む。sources の順に積む。
  constructor(
    renderer: WebGPURenderer,
    gbuffer: GBufferPass,
    private readonly sources: readonly LightSource[],
    private readonly gpu: GpuTimings,
  ) {
    this.renderer = renderer;

    // diffuse/specular の2枚。WebGPU に3チャンネル16bit浮動小数点フォーマットは無いため、
    // rgba16float(a は未使用)を使う。
    this.target = new THREE.RenderTarget(1, 1, { count: 2, depthBuffer: false, samples: 0 });
    const [diffuseTex, specularTex] = this.target.textures;
    diffuseTex!.name = 'diffuse';
    diffuseTex!.format = THREE.RGBAFormat;
    diffuseTex!.type = THREE.HalfFloatType;
    specularTex!.name = 'specular';
    specularTex!.format = THREE.RGBAFormat;
    specularTex!.type = THREE.HalfFloatType;

    this.sample = new ShadingSample(gbuffer);
    this.quad = new QuadMesh();
  }

  get diffuseTexture(): THREE.Texture { return this.target.textures[0]!; }
  get specularTexture(): THREE.Texture { return this.target.textures[1]!; }

  // 寄与のある光源を順に照度バッファへ積む。camera は共有のシェーディング入力の行列を
  // 毎フレーム引き直すためだけに使い、シーン自体は描かない(光源ごとのフルスクリーンのみ)。
  render(camera: THREE.Camera, width: number, height: number): void {
    if (this.target.width !== width || this.target.height !== height) this.target.setSize(width, height);
    this.sample.sync(camera);

    // 加算合成の土台は 0。クリア色は共有状態なので退避して戻す(lens-pass.ts と同じ)。
    const savedClearAlpha = this.renderer.getClearAlpha();
    this.renderer.getClearColor(this.savedClearColor);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setRenderTarget(this.target);
    let cleared = false;
    for (const source of this.sources) {
      if (!source.hasContribution()) continue;
      this.quad.material = source.material(this.sample);
      this.renderer.autoClear = !cleared;
      cleared = true;
      // beginPass は render() 呼び出しごとに申告する。同じパスの複数回ぶんは計測側が足し合わせる。
      this.gpu.beginPass(GPU_PASS.lighting);
      this.quad.render(this.renderer);
    }
    // 寄与のある光源が 1 つも無いフレームでも、前のフレームの照度を残さない。
    if (!cleared) this.renderer.clear(true, false, false);
    this.renderer.autoClear = true;
    this.renderer.setRenderTarget(null);
    this.renderer.setClearColor(this.savedClearColor, savedClearAlpha);
  }

  // 光源ごとの全マテリアルを照度ターゲットへ事前コンパイルする。
  async compile(camera: THREE.Camera, width: number, height: number): Promise<void> {
    if (this.target.width !== width || this.target.height !== height) this.target.setSize(width, height);
    this.sample.sync(camera);
    for (const source of this.sources) {
      this.quad.material = source.material(this.sample);
      await compileInto(this.renderer, this.target, this.quad, this.quad.camera);
    }
  }

  // 保持している GPU 資源を解放する。QuadMesh の geometry は three が全インスタンスで
  // 共有する単一の板なので、ここでは解放しない。
  dispose(): void {
    this.target.dispose();
    for (const source of this.sources) source.dispose();
  }
}
