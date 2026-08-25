// フレーム最後のパス: 3D 空間に居るが物理的な明るさを持たない表示物(軌道線・軌跡線・天球
// グリッド・縮尺グリッド・Δv ギズモ)を、合成後の画面へ描き足す。物理量として描くものだけが
// 露出とトーンマッピングを通るので、それらの外へ出す — 指定した色がそのまま画面へ出る。
//
// 深度は自前では書かない。合成パスが G バッファの深度を画面の深度バッファへ複製しているので、
// このパスは普通に深度テストするだけでよく、線のマテリアルをノード化する必要がない。
// 帰結として、深度を書かない透ける物体(環・大気・オーロラ・噴射炎)には隠れない。
//
// 模式図スタイルは白背景なので、暗背景向けに定義された線の色はそのままでは見えない。線ごとの
// 色定義を書き換える代わりに、このチャンネルだけを専用ターゲットへ描いてから、色相を保った
// まま暗くして画面へ合成する。
import * as THREE from 'three/webgpu';
import { MeshBasicNodeMaterial, QuadMesh, WebGPURenderer } from 'three/webgpu';
import { max, min, screenUV, texture, uniform, vec2, vec4 } from 'three/tsl';
import { GPU_PASS, type GpuTimings } from '../../gpu-timings';
import {
  SCHEMATIC_OVERLAY_ALPHA_GAIN, SCHEMATIC_OVERLAY_DARKEN, SCHEMATIC_OVERLAY_DILATE_PX,
} from '../schematic-style';
import { setOverlayPassLayers } from './lit-layer';
import type { RenderStyle } from '../render-style';
import type { Vec2Node, Vec4Node } from '../tsl-types';

export class OverlayPass {
  // 模式図スタイルで 3D UI レイヤーを描く RGBA ターゲット。アルファはプリマルチプライドとして
  // 持ち、画面への合成マテリアルもそれを前提にブレンド式を組む。
  private readonly target: THREE.RenderTarget;
  private readonly quad: QuadMesh;
  private readonly compositeMaterial: THREE.MeshBasicNodeMaterial;
  // G バッファの深度を専用ターゲットへ写しつつ、色を透明で塗り潰す材質。
  private readonly depthCopyMaterial: THREE.MeshBasicNodeMaterial;
  // ダイレートで拾う上下左右オフセット [screenUV]。解像度が変わるたびに render() 側が書き込む。
  private readonly dilateOffset: THREE.UniformNode<'vec2', THREE.Vector2>;
  private static readonly sizeScratch = new THREE.Vector2();

  // 模式図スタイルが使う専用ターゲットと、それを暗くして画面へ合成するマテリアルを構築する。
  // depthTexture は G バッファのもの — 描画のたびにノードを組み直すとシェーダごと作り直しに
  // なるため、同一インスタンスであることを前提に一度だけ束ねる。
  constructor(
    private readonly renderer: WebGPURenderer, private readonly gpu: GpuTimings,
    depthTexture: THREE.DepthTexture,
  ) {
    this.target = new THREE.RenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      depthBuffer: true,
      samples: 0,
    });
    this.target.texture.name = 'overlay-schematic';
    this.target.depthTexture = new THREE.DepthTexture(1, 1, THREE.FloatType);
    this.dilateOffset = uniform(new THREE.Vector2());

    // 深度は G バッファのものを共有せず複製する — テクスチャを共有すると、リサイズや解放の際に
    // 一方の後始末がもう一方の描画中のテクスチャを破棄してしまう。全画素へ透明を書き込みながら
    // 深度だけを立てるので、この板がターゲットのクリアも兼ねる。透明でない色を書くと線の無い
    // 画素まで不透明になり、合成が画面全体を塗り潰す。
    this.depthCopyMaterial = new MeshBasicNodeMaterial({
      depthTest: false, depthWrite: true, transparent: true, blending: THREE.NoBlending,
    });
    this.depthCopyMaterial.colorNode = vec4(0, 0, 0, 0);
    this.depthCopyMaterial.depthNode = texture(depthTexture, screenUV).r;

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
    // ネイティブ線は太さ制御を持たないため、中心と上下左右の4点をダイレート半径ぶん
    // オフセットしてサンプルし、成分ごとの最大値を採って線を太らせる。
    const sampleAt = (uv: Vec2Node): Vec4Node => texture(this.target.texture, uv);
    const neighbors: readonly Vec4Node[] = [
      sampleAt(screenUV.add(vec2(this.dilateOffset.x, 0))),
      sampleAt(screenUV.sub(vec2(this.dilateOffset.x, 0))),
      sampleAt(screenUV.add(vec2(0, this.dilateOffset.y))),
      sampleAt(screenUV.sub(vec2(0, this.dilateOffset.y))),
    ];
    const dilated = neighbors.reduce((acc: Vec4Node, n) => max(acc, n), sampleAt(screenUV));

    // ターゲットの rgb はアルファを掛けた後の値。色を触るにはいったんアルファを外し、
    // 暗くしてから掛け直す — 掛かったまま暗くすると、線の縁(半透明な画素)だけ余計に
    // 変換されてアンチエイリアスの縁が背景へ溶ける。
    const sample = dilated;
    const unpremultiplied = sample.rgb.div(max(sample.a, 1e-4));
    const alpha = min(sample.a.mul(SCHEMATIC_OVERLAY_ALPHA_GAIN), 1);
    this.compositeMaterial.colorNode = vec4(
      unpremultiplied.mul(SCHEMATIC_OVERLAY_DARKEN).mul(alpha), alpha);
    this.quad = new QuadMesh(this.compositeMaterial);
  }

  // 3D UI チャンネルのオブジェクトを描く。camera は他のパスと同じインスタンスなので、
  // layers.mask は呼び出し前の値へ必ず戻す。写実スタイルはキャンバスへ直接重ね描きし、模式図
  // スタイルは専用ターゲットへ描いてから明度反転して合成する。
  render(scene: THREE.Scene, camera: THREE.Camera, style: RenderStyle): void {
    const savedMask = camera.layers.mask;
    setOverlayPassLayers(camera);

    if (style === 'schematic') this.renderSchematic(scene, camera);
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
  private renderSchematic(scene: THREE.Scene, camera: THREE.Camera): void {
    this.renderer.getDrawingBufferSize(OverlayPass.sizeScratch);
    const width = OverlayPass.sizeScratch.x;
    const height = OverlayPass.sizeScratch.y;
    if (this.target.width !== width || this.target.height !== height) this.target.setSize(width, height);
    this.dilateOffset.value.set(SCHEMATIC_OVERLAY_DILATE_PX / width, SCHEMATIC_OVERLAY_DILATE_PX / height);

    this.renderer.setRenderTarget(this.target);
    this.renderer.autoClear = false;
    // 不透明物の深度テストを合成パスと同じ結果にするため、線を描く前に G バッファの深度を写す。
    // 同じ板が色を透明で塗り潰すので、これがこのターゲットのクリアも兼ねる。
    this.quad.material = this.depthCopyMaterial;
    this.gpu.beginPass(GPU_PASS.overlay);
    this.quad.render(this.renderer);
    this.gpu.beginPass(GPU_PASS.overlay);
    this.renderer.render(scene, camera);
    this.renderer.setRenderTarget(null);

    // 合成パスが書いたキャンバスの色を消さずに重ねる — autoClear のまま板を描くと、
    // キャンバスがクリア色で塗り潰されてから線だけが残る。
    this.quad.material = this.compositeMaterial;
    this.gpu.beginPass(GPU_PASS.overlay);
    this.quad.render(this.renderer);
    this.renderer.autoClear = true;
  }

  // 保持している GPU 資源を解放する。QuadMesh の geometry は three が全インスタンスで
  // 共有する単一の板なので、ここでは解放しない。
  dispose(): void {
    this.target.dispose();
    this.compositeMaterial.dispose();
    this.depthCopyMaterial.dispose();
  }
}
