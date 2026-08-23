// フレームの描画パス構成を制御する。render/** 配下の個々の描画物モジュールとは別に、
// 「何段で、どのターゲットへ描き、どう合成してキャンバスへ出すか」をここへ集約する。
// 現在は5段: G バッファパス(深度・法線・ラフネスを MRT へ描く)→ ライティングパス(G バッファ
// だけを読み、拡散/鏡面の照度を MRT へ描く)→ マテリアルパス(lit-opaque 層をライティングパスの
// 照度で描き、world パスと共有する HDR ターゲットの最初の書き込みとしてクリアする)→ world パス
// (シーンを同じ HDR ターゲットへ重ね描きする)→ composite パス。composite パスは通常表示
// (debugTarget==='off')では HDR ターゲットへ露出を掛けてキャンバスへ合成し、それ以外を選ぶと
// 代わりに G バッファ/照度バッファ/マテリアルパス単体の中身を画面いっぱいに映す(debug-target.ts)。
import * as THREE from 'three/webgpu';
import { QuadMesh, WebGPURenderer } from 'three/webgpu';
import { log, screenUV, texture, uniform, vec3, vec4 } from 'three/tsl';
import { GPU_PASS, type GpuTimings } from '../../gpu-timings';
import type { GraphicsSettingsData } from '../graphics-settings';
import type { FloatNode, FloatUniform, Vec4Node } from '../tsl-types';
import type { DebugTargetHost, DebugTargetId } from './debug-target';
import { GBufferPass, octDecodeNormal } from './gbuffer';
import { LightPrepass } from './light-prepass';
import { MaterialPass } from './material-pass';
import { SunLight } from './sun-light';

// composite パスが HDR 値全体へ一律に掛ける、フレーム唯一の明るさ係数。実照度に対する
// 物理的な較正は後続のサブフェーズの課題で、現状は環(render/ring.ts)の単一散乱輝度が
// LDR で飽和しない値として 0.72 に置く。
export const EXPOSURE = 0.72;

// 深度テクスチャの生値(反転深度: 1=near/0=far)を view 空間の距離へ変換する。
// three.js 標準の perspectiveDepthToViewZ は far-near を素朴に引くが、near=2m/far=2e12m の
// ように float32 の分解能を near がまるごと下回る組み合わせでは far-near が far そのものへ
// 丸め込まれ、深度が far 側に近い領域で 0 除算(→NaN)に破綻する。near*(1-depth) と far*depth を
// 個別に求めてから足し合わせる形に組み替えると、depth=0 ちょうどで分母が near ちょうどに
// なり(0 にならず)この破綻を避けられる。
function viewDistanceFromDepth(depth: FloatNode, near: FloatUniform, far: FloatUniform): FloatNode {
  return near.mul(far).div(near.mul(depth.oneMinus()).add(far.mul(depth)));
}

export class RenderPipeline implements DebugTargetHost {
  private readonly renderer: WebGPURenderer;
  private readonly gbuffer: GBufferPass;
  private readonly lightPrepass: LightPrepass;
  private readonly materialPass: MaterialPass;
  private readonly _sunLight: SunLight;
  private readonly target: THREE.RenderTarget;
  private readonly quad: QuadMesh;
  private readonly compositeMaterials: Readonly<Record<DebugTargetId, THREE.MeshBasicNodeMaterial>>;
  private readonly exposure: FloatUniform;
  // 深度デバッグ表示が near/far 間の対数スケールを組むのに使う uniform。composite パスは
  // QuadMesh 自前の固定直交カメラ(near=0/far=1)で描かれるため、TSL の cameraNear/cameraFar
  // 組み込みノードはここでは実カメラの値を返さない — render() が毎フレーム実カメラの
  // near/far を書き込む。
  private readonly depthDebugNear: FloatUniform;
  private readonly depthDebugFar: FloatUniform;
  // getDrawingBufferSize の書き込み先。フレームごとに確保しない使い回し領域。
  private readonly drawingBufferSize = new THREE.Vector2();

  // 通常表示に代えて画面いっぱいに映す中間ターゲットの選択。ページ再読み込みでは必ず 'off'
  // に戻るセッション限定の状態で、永続化しない。
  debugTarget: DebugTargetId = 'off';

  // ライティングパスが読む恒星光。EnvironmentScene がここへ毎フレーム書き込む。
  get sunLight(): SunLight { return this._sunLight; }

  // G バッファパス・ライティングパス・マテリアルパスと、world パスの描画先である HDR
  // オフスクリーンターゲット、それらをキャンバスへ合成する QuadMesh 用のデバッグ表示ごとの
  // マテリアルを構築する。
  constructor(renderer: WebGPURenderer, graphics: GraphicsSettingsData, private readonly gpu: GpuTimings) {
    this.renderer = renderer;
    this.gbuffer = new GBufferPass(renderer, gpu);
    this._sunLight = new SunLight();
    this.lightPrepass = new LightPrepass(renderer, this.gbuffer, this._sunLight, gpu);
    this.materialPass = new MaterialPass(renderer, this.lightPrepass, gpu);

    // antialias はレンダラ生成時にしか渡せず(scene.ts 参照)、キャンバスへの直描きは
    // それでマルチサンプルされていた。オフスクリーンの HDR ターゲットは自前で samples を
    // 要求しないと素通りで失われるので、構築時に一度だけ読んで反映する。
    const samples = graphics.antialias ? 4 : 0;
    this.target = new THREE.RenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      depthBuffer: true,
      samples,
    });
    // G バッファと同じく、深度を 32bit 浮動小数点にするには明示が要る(gbuffer.ts 参照)。
    this.target.depthTexture = new THREE.DepthTexture(1, 1, THREE.FloatType);

    this.exposure = uniform(EXPOSURE);
    this.depthDebugNear = uniform(1);
    this.depthDebugFar = uniform(2);

    // デバッグ表示の切替は quad.material の差し替えで行う(WebGPU ではジオメトリ/頂点属性の
    // 差し替えは禁止だが、マテリアルの差し替えは可 — CLAUDE.md の WebGPU 注意点参照)。1枚の
    // マテリアルをユニフォーム分岐させると、通常プレイの毎フレームで G バッファの全テクスチャを
    // bind/sample することになるため、表示ごとに別マテリアルを構築する。
    this.compositeMaterials = {
      off: this.buildCompositeMaterial(
        vec4(texture(this.target.texture, screenUV).rgb.mul(this.exposure), 1),
      ),
      normal: this.buildCompositeMaterial(
        vec4(octDecodeNormal(texture(this.gbuffer.normalTexture, screenUV).rg).mul(0.5).add(0.5), 1),
      ),
      roughness: this.buildCompositeMaterial(
        vec4(vec3(texture(this.gbuffer.roughnessTexture, screenUV).r), 1),
      ),
      depth: this.buildCompositeMaterial(vec4(vec3(this.logDepthNode()), 1)),
      // 照度は 1 を超え得る HDR 値なので、通常表示と同じ露出係数を掛けてから画面へ出す。
      diffuse: this.buildCompositeMaterial(
        vec4(texture(this.lightPrepass.diffuseTexture, screenUV).rgb.mul(this.exposure), 1),
      ),
      specular: this.buildCompositeMaterial(
        vec4(texture(this.lightPrepass.specularTexture, screenUV).rgb.mul(this.exposure), 1),
      ),
      material: this.buildCompositeMaterial(
        vec4(texture(this.materialPass.texture, screenUV).rgb.mul(this.exposure), 1),
      ),
    };
    this.quad = new QuadMesh(this.compositeMaterials.off);
  }

  // depthTest/depthWrite/transparent の共通設定を1箇所へまとめた、composite 用マテリアルの
  // 下請け。colorNode だけがデバッグ表示ごとに異なる。
  private buildCompositeMaterial(colorNode: Vec4Node): THREE.MeshBasicNodeMaterial {
    const material = new THREE.MeshBasicNodeMaterial({ depthTest: false, depthWrite: false, transparent: false });
    material.colorNode = colorNode;
    return material;
  }

  // 深度バッファの生値を near/far 間の対数スケール(0=near, 1=far)へ変換する。素の深度値は
  // near=2m/far=2e12m のスケールでは端に潰れて識別できないため、対数を挟むことで
  // 精度の落ち方そのものを見えるようにする。
  private logDepthNode(): FloatNode {
    const rawDepth = texture(this.gbuffer.depthTexture, screenUV).r;
    const dist = viewDistanceFromDepth(rawDepth, this.depthDebugNear, this.depthDebugFar);
    return log(dist.div(this.depthDebugNear)).div(log(this.depthDebugFar.div(this.depthDebugNear)));
  }

  // G バッファパス → ライティングパス → マテリアルパス → シーンを同じ HDR ターゲットへ重ね描く
  // world パス → debugTarget に応じたマテリアルでキャンバスへ合成する composite パスの順に
  // 実行する。Game.render() から毎フレーム1回呼ぶ。デバッグ表示を選んでいてもいずれのパスも
  // 省略しない — 見せるのは通常のフレームが実際に生成した中身であるべきため。
  render(scene: THREE.Scene, camera: THREE.Camera): void {
    this.renderer.getDrawingBufferSize(this.drawingBufferSize);
    const width = this.drawingBufferSize.x;
    const height = this.drawingBufferSize.y;
    if (this.target.width !== width || this.target.height !== height) this.target.setSize(width, height);

    // G バッファパス。camera.layers の一時的な絞り込みと GPU 計測の申告は自身の中で行う。
    this.gbuffer.render(scene, camera, width, height);

    // ライティングパス。G バッファだけを読むので scene は渡さない。
    this.lightPrepass.render(camera, width, height);

    // マテリアルパス。LIT_OPAQUE_LAYER のオブジェクトと背景専用レイヤーを this.target(このあとの
    // world パスと共有 — 最初の書き込みなのでクリアする)へ描く。「マテリアル」デバッグ表示を選んでいる
    // ときだけ、自前のターゲットへも同じジオメトリをもう一度描く。
    this.materialPass.render(scene, camera, this.target, width, height, this.debugTarget === 'material');

    // world パス。マテリアルパスが LIT_OPAQUE_LAYER と背景専用レイヤーをチャンネル0から外しているので、
    // 既定のカメラマスクで描く限りここでは自動的に重複しない。autoClear を落として
    // マテリアルパスの描画(色・深度とも)を残したまま重ね描きする — world パスは透明物
    // (オービットライン・プルーム・ビルボードなど)を自分の描画順の最後に描くため、不透明な
    // 自艦の深度がその前に書き込まれていないと、自艦の手前にある透明物がそれで上書きされて
    // しまう。beginPass はそのパスが発行する renderer.render() の直前に呼び、GPU 所要時間の
    // 計測先を申告する。
    this.renderer.setRenderTarget(this.target);
    this.renderer.autoClear = false;
    this.gpu.beginPass(GPU_PASS.world);
    this.renderer.render(scene, camera);
    this.renderer.autoClear = true;
    this.renderer.setRenderTarget(null);

    // composite パス。QuadMesh.render も内部で renderer.render() を呼ぶので、world パスとは
    // 別の GPU 計測枠が付く。
    if (camera instanceof THREE.PerspectiveCamera || camera instanceof THREE.OrthographicCamera) {
      this.depthDebugNear.value = camera.near;
      this.depthDebugFar.value = camera.far;
    }
    this.quad.material = this.compositeMaterials[this.debugTarget];
    this.gpu.beginPass(GPU_PASS.composite);
    this.quad.render(this.renderer);
  }

  // 保持している GPU 資源を解放する。QuadMesh の geometry は three が全インスタンスで
  // 共有する単一の板なので、ここでは解放しない。
  dispose(): void {
    this.gbuffer.dispose();
    this.lightPrepass.dispose();
    this.materialPass.dispose();
    this.target.dispose();
    for (const material of Object.values(this.compositeMaterials)) material.dispose();
  }
}
