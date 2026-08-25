// フレーム最後のパス: 3D 空間に居るが物理的な明るさを持たない表示物(軌道線・軌跡線・天球
// グリッド・縮尺グリッド・Δv ギズモ)を、合成後の画面へ描き足す。物理量として描くものだけが
// 露出とトーンマッピングを通るので、それらの外へ出す — 指定した色がそのまま画面へ出る。
//
// 深度は自前では書かない。合成パスが G バッファの深度を画面の深度バッファへ複製しているので、
// このパスは普通に深度テストするだけでよく、線のマテリアルをノード化する必要がない。
// 帰結として、深度を書かない透ける物体(環・大気・オーロラ・噴射炎)には隠れない。
//
// 模式図スタイルは白背景なので、暗背景向けに定義された線の色はそのままでは見えない。線ごとの
// 色定義を書き換える代わりに、このチャンネルだけを専用ターゲットへ描いてから明度反転して
// 画面へ合成する。
import * as THREE from 'three/webgpu';
import { MeshBasicNodeMaterial, QuadMesh, WebGPURenderer } from 'three/webgpu';
import { screenUV, texture, vec4 } from 'three/tsl';
import { GPU_PASS, type GpuTimings } from '../../gpu-timings';
import { SCHEMATIC_OVERLAY_INVERT_MAX } from '../schematic-style';
import { setOverlayPassLayers } from './lit-layer';
import type { RenderStyle } from '../render-style';

export class OverlayPass {
  // 模式図スタイルで 3D UI レイヤーを描く RGBA ターゲット。アルファはプリマルチプライドとして
  // 持ち、画面への合成マテリアルもそれを前提にブレンド式を組む。
  private readonly target: THREE.RenderTarget;
  private readonly quad: QuadMesh;
  private readonly compositeMaterial: THREE.MeshBasicNodeMaterial;
  private static readonly sizeScratch = new THREE.Vector2();

  // 模式図スタイルが使う専用ターゲットと、それを明度反転しながら画面へ合成するマテリアルを
  // 構築する。写実スタイルはこれらを使わない。
  constructor(private readonly renderer: WebGPURenderer, private readonly gpu: GpuTimings) {
    this.target = new THREE.RenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      depthBuffer: true,
      samples: 0,
    });
    this.target.texture.name = 'overlay-schematic';

    // アルファはプリマルチプライド前提。線はアンチエイリアスで縁が半透明になるため、
    // 素朴な (src.a, 1-src.a) 合成では縁の色が薄まった上へさらにアルファが掛かって二重に霞む。
    this.compositeMaterial = new MeshBasicNodeMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendEquationAlpha: THREE.AddEquation,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
    // ターゲットの rgb はアルファを掛けた後の値なので、反転もアルファを掛けた形で行う:
    // (MAX - c) * a = MAX*a - rgb。素の rgb をそのまま反転すると、線の縁(半透明な画素)だけ
    // 反転が過剰になり、アンチエイリアスの縁が背景へ溶けて線が霞む。
    const sample = texture(this.target.texture, screenUV);
    this.compositeMaterial.colorNode = vec4(
      sample.a.mul(SCHEMATIC_OVERLAY_INVERT_MAX).sub(sample.rgb), sample.a);
    this.quad = new QuadMesh(this.compositeMaterial);
  }

  // 3D UI チャンネルのオブジェクトを描く。camera は他のパスと同じインスタンスなので、
  // layers.mask は呼び出し前の値へ必ず戻す。写実スタイルはキャンバスへ直接重ね描きし、模式図
  // スタイルは専用ターゲットへ描いてから明度反転して合成する。
  render(
    scene: THREE.Scene, camera: THREE.Camera, style: RenderStyle, depthTexture: THREE.DepthTexture,
  ): void {
    const savedMask = camera.layers.mask;
    setOverlayPassLayers(camera);

    if (style === 'schematic') this.renderSchematic(scene, camera, depthTexture);
    else this.renderRealistic(scene, camera);

    camera.layers.mask = savedMask;
  }

  // 合成パスが書いた色と深度を残したまま、3D UI チャンネルをキャンバスへそのまま重ね描く。
  private renderRealistic(scene: THREE.Scene, camera: THREE.Camera): void {
    this.renderer.autoClear = false;
    this.gpu.beginPass(GPU_PASS.overlay);
    this.renderer.render(scene, camera);
    this.renderer.autoClear = true;
  }

  // 3D UI チャンネルを専用ターゲットへ描いてから、明度反転しつつプリマルチプライドアルファで
  // キャンバスへ合成する。
  private renderSchematic(scene: THREE.Scene, camera: THREE.Camera, depthTexture: THREE.DepthTexture): void {
    this.renderer.getDrawingBufferSize(OverlayPass.sizeScratch);
    const width = OverlayPass.sizeScratch.x;
    const height = OverlayPass.sizeScratch.y;
    if (this.target.width !== width || this.target.height !== height) this.target.setSize(width, height);
    // G バッファの深度をそのまま共有する。不透明物の深度テストを合成パスと同じ結果にするため。
    this.target.depthTexture = depthTexture;

    const savedAutoClearDepth = this.renderer.autoClearDepth;
    this.renderer.autoClearDepth = false;
    this.renderer.setRenderTarget(this.target);
    this.renderer.clear(true, false, false);
    this.gpu.beginPass(GPU_PASS.overlay);
    this.renderer.render(scene, camera);
    this.renderer.setRenderTarget(null);
    this.renderer.autoClearDepth = savedAutoClearDepth;

    this.gpu.beginPass(GPU_PASS.overlay);
    this.quad.render(this.renderer);
  }

  // 保持している GPU 資源を解放する。QuadMesh の geometry は three が全インスタンスで
  // 共有する単一の板なので、ここでは解放しない。
  dispose(): void {
    this.target.dispose();
    this.compositeMaterial.dispose();
  }
}
