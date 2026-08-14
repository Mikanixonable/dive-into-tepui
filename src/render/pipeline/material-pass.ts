// LIT_OPAQUE_LAYER のオブジェクトだけを対象に、ライトプリパスが書いた拡散/鏡面照度バッファを
// screenUV で読み、素材(アルベド・金属度・F0)を掛けて描く。
//
// PhysicalLightingModel の direct() を no-op にしてシーンの実光源(DirectionalLight/AmbientLight)
// の寄与を切り、indirect() だけをライトプリパス読み出しへ差し替える — BRDF・マップ・粗さ/金属度の
// 扱いは three 標準の MeshStandardNodeMaterial のまま何も変えない。
//
// world パスより前に、world パスと共有する HDR ターゲットへの最初の書き込みとしてこのパスが描く
// (色・深度ともクリア)。world パスは autoClear を落として重ね描きし、GPU 自身の深度テストで
// 奥行きを揃える — world パスは透明物(オービットライン・プルーム・ビルボード)を自分のソート順の
// 最後に描くため、不透明な自艦の深度がその前に書き込まれていないと、自艦の手前にある透明物が
// それで上書きされてしまう。
//
// 自前のデバッグ表示用ターゲットへ同じジオメトリをもう一度描くのは「マテリアル」表示を選んでいる
// 間だけ — 通常プレイでは共有ターゲットへの1回の描画で足り、それ以外の表示を見ている間まで
// 3回目のジオメトリ描画を払わせない。
import * as THREE from 'three/webgpu';
import { WebGPURenderer, PhysicalLightingModel } from 'three/webgpu';
import { diffuseColor, metalness, mix, screenUV, texture, vec3 } from 'three/tsl';
import { GPU_PASS, type GpuTimings } from '../../gpu-timings';
import { LIT_OPAQUE_LAYER } from './lit-layer';
import type { LightPrepass } from './light-prepass';
import type { Vec3Node } from '../tsl-types';

// direct() で実シーンの光源からの寄与を足さず、indirect() でライトプリパスの2枚の照度
// バッファだけを反射率に掛ける。specularColorBlended(誘電体 F0=0.04 と金属を metalness で
// 混ぜた値)は MeshStandardNodeMaterial 内部専用で公開されていないため、同じ式で組み直す。
class MaterialPassLightingModel extends PhysicalLightingModel {
  constructor(
    private readonly diffuseIrradiance: Vec3Node,
    private readonly specularIrradiance: Vec3Node,
  ) {
    super();
  }

  override direct(): void {}

  override indirect(builder: THREE.NodeBuilder): void {
    const { reflectedLight } = builder.context as { reflectedLight: THREE.LightingModelReflectedLight };
    const specularColorBlended = mix(vec3(0.04), diffuseColor.rgb, metalness);
    // reflectedLight.indirectDiffuse/indirectSpecular の @types/three 上の型は無引数の Node
    // (light-prepass.ts の D_GGX 等と同じく実体は他の TSL ノードと同じプロキシで addAssign を
    // 持つのに、Node<'vec3'> でないため型定義側でメソッドチェインが欠落している)ため、
    // Vec3Node へ読み替えてから足し込む。
    const indirectDiffuse = reflectedLight.indirectDiffuse as unknown as Vec3Node;
    const indirectSpecular = reflectedLight.indirectSpecular as unknown as Vec3Node;
    indirectDiffuse.addAssign(this.diffuseIrradiance.mul(diffuseColor.rgb));
    indirectSpecular.addAssign(this.specularIrradiance.mul(specularColorBlended));
  }
}

// 素材の色/マップ一式のうち MeshStandardNodeMaterial のコンストラクタが受けるものだけを
// 元の MeshStandardMaterial から拾う。プロパティ名は両クラスで共通。
function standardMaterialParams(src: THREE.MeshStandardMaterial): THREE.MeshStandardNodeMaterialParameters {
  return {
    color: src.color,
    map: src.map,
    roughness: src.roughness,
    roughnessMap: src.roughnessMap,
    metalness: src.metalness,
    metalnessMap: src.metalnessMap,
    normalMap: src.normalMap,
    normalScale: src.normalScale,
    emissive: src.emissive,
    emissiveMap: src.emissiveMap,
    emissiveIntensity: src.emissiveIntensity,
    alphaMap: src.alphaMap,
    transparent: src.transparent,
    opacity: src.opacity,
    side: src.side,
  };
}

const LIT_OPAQUE_TEST = new THREE.Layers();
LIT_OPAQUE_TEST.set(LIT_OPAQUE_LAYER);

export class MaterialPass {
  private readonly renderer: WebGPURenderer;
  private readonly target: THREE.RenderTarget;
  private readonly diffuseNode: Vec3Node;
  private readonly specularNode: Vec3Node;
  // 一度アップグレードした Material の再変換を避けるための既変換集合。
  private readonly upgraded = new WeakSet<THREE.Material>();

  constructor(
    renderer: WebGPURenderer,
    private readonly lightPrepass: LightPrepass,
    private readonly gpu: GpuTimings,
  ) {
    this.renderer = renderer;
    this.target = new THREE.RenderTarget(1, 1, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: true, samples: 0 });
    this.diffuseNode = texture(this.lightPrepass.diffuseTexture, screenUV).rgb;
    this.specularNode = texture(this.lightPrepass.specularTexture, screenUV).rgb;
  }

  get texture(): THREE.Texture { return this.target.texture; }

  // MeshStandardMaterial を、同じ見た目の値を持つ MeshStandardNodeMaterial + 上のライティング
  // モデルへ置き換える。mesh.material が既に置き換え済みならなにもしない。ships.ts がメッシュを
  // 組み立てる時点ではライティングモデルが読む2枚の照度テクスチャ(ライトプリパスの出力)がまだ
  // 存在しない — このクラス自身の構築より前には作りようがない — ため、構築時ではなく毎フレーム
  // この呼び出しでアップグレードする。
  private upgrade(mesh: THREE.Mesh): void {
    const material = mesh.material as THREE.Material;
    if (this.upgraded.has(material)) return;
    if (!(material as THREE.MeshStandardMaterial).isMeshStandardMaterial) return;

    const src = material as THREE.MeshStandardMaterial;
    const upgraded = new THREE.MeshStandardNodeMaterial(standardMaterialParams(src));
    upgraded.setupLightingModel = () => new MaterialPassLightingModel(this.diffuseNode, this.specularNode);
    this.upgraded.add(upgraded);
    mesh.material = upgraded;
    src.dispose();
  }

  // LIT_OPAQUE_LAYER のオブジェクトを、world パスと共有する HDR ターゲットへ描く(このパスが
  // そこへの最初の書き込みなのでクリアする)。showDebugTarget が立っているときだけ、同じ
  // ジオメトリをこのパス専用のターゲットへもう一度描く — 「マテリアル」デバッグ表示を選んで
  // いるかどうかの判断は RenderPipeline のもので、ここでは結果だけを受け取る。
  render(
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    sharedTarget: THREE.RenderTarget,
    width: number,
    height: number,
    showDebugTarget: boolean,
  ): void {
    scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.isMesh && mesh.layers.test(LIT_OPAQUE_TEST)) this.upgrade(mesh);
    });

    const savedMask = camera.layers.mask;
    camera.layers.set(LIT_OPAQUE_LAYER);

    if (showDebugTarget) {
      if (this.target.width !== width || this.target.height !== height) this.target.setSize(width, height);
      // beginPass はこのあとの renderer.render() 呼び出しの直前に呼び、GPU 計測の対象パスを申告する。
      this.gpu.beginPass(GPU_PASS.material);
      this.renderer.setRenderTarget(this.target);
      this.renderer.autoClear = true;
      this.renderer.render(scene, camera);
    }

    this.gpu.beginPass(GPU_PASS.material);
    this.renderer.setRenderTarget(sharedTarget);
    this.renderer.autoClear = true;
    this.renderer.render(scene, camera);
    this.renderer.setRenderTarget(null);

    camera.layers.mask = savedMask;
  }

  // 保持している GPU 資源を解放する。
  dispose(): void {
    this.target.dispose();
  }
}
