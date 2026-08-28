// LIT_OPAQUE_LAYER のオブジェクトと背景専用レイヤーを対象に、ライトプリパスが書いた拡散/鏡面
// 照度バッファを screenUV で読み、素材(アルベド・金属度・F0)を掛けて描く。背景専用レイヤーは
// renderOrder により不透明物より先に描かれ、world パスの既定レイヤーには現れない。
//
// PhysicalLightingModel の direct() を no-op にしてシーンの実光源の寄与を切り、
// indirect() だけをライトプリパス読み出しへ差し替える — BRDF・マップ・粗さ/金属度の
// 扱いは three 標準の MeshStandardNodeMaterial のまま何も変えない。
//
// world パスより前に、world パスと共有する HDR ターゲットへの最初の書き込みとしてこのパスが描く
// (色・深度ともクリア)。world パスは autoClear を落として重ね描きし、GPU 自身の深度テストで
// 奥行きを揃える — world パスは透明物(オービットライン・プルーム・ビルボード)を自分のソート順の
// 最後に描くため、不透明な自艦の深度がその前に書き込まれていないと、自艦の手前にある透明物が
// それで上書きされてしまう。
import * as THREE from 'three/webgpu';
import { WebGPURenderer, PhysicalLightingModel } from 'three/webgpu';
import { BRDF_Lambert, diffuseColor, metalness, mix, screenUV, texture, vec3 } from 'three/tsl';
import { GPU_PASS, type GpuTimings } from '../../gpu-timings';
import { LIT_OPAQUE_LAYER, isStandardMaterial, setOpaquePassLayers } from './lit-layer';
import { toStandardNodeMaterial } from '../standard-node-material';
import type { LightPrepass } from './light-prepass';
import type { Vec3Node } from '../tsl-types';

// direct() で実シーンの光源からの寄与を足さず、indirect() でライトプリパスの2枚の照度
// バッファへ BRDF を掛ける。掛ける中身は three がフォワード経路の direct() で使うものと同一で、
// 拡散が BRDF_Lambert(アルベド×(1−金属度)/π)、鏡面が F0(誘電体 0.04 と金属色を金属度で
// 混ぜた値)。どちらも MeshStandardNodeMaterial の内部プロパティ(diffuseContribution /
// specularColorBlended)にあたるが three/tsl から公開されていないため、同じ式で組み直す。
//
// 照度バッファが持つのは放射照度なので、そこへ掛けるのは反射率ではなく BRDF である。
// 拡散の 1/π を落とすと、それだけでフォワード経路より π 倍明るくなる。
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
    const diffuseContribution = diffuseColor.rgb.mul(metalness.oneMinus());
    // reflectedLight.indirectDiffuse/indirectSpecular の @types/three 上の型は無引数の Node
    // (light-prepass.ts の D_GGX 等と同じく実体は他の TSL ノードと同じプロキシで addAssign を
    // 持つのに、Node<'vec3'> でないため型定義側でメソッドチェインが欠落している)ため、
    // Vec3Node へ読み替えてから足し込む。
    const indirectDiffuse = reflectedLight.indirectDiffuse as unknown as Vec3Node;
    const indirectSpecular = reflectedLight.indirectSpecular as unknown as Vec3Node;
    // BRDF_Lambert の @types/three 上の戻り値型 OperatorNode はメソッドチェインを持たない
    // (light-prepass.ts の D_GGX 等と同じ型定義側の欠落)ため、Vec3Node へ読み替える。
    const lambert = BRDF_Lambert({ diffuseColor: diffuseContribution }) as unknown as Vec3Node;
    indirectDiffuse.addAssign(this.diffuseIrradiance.mul(lambert));
    indirectSpecular.addAssign(this.specularIrradiance.mul(specularColorBlended));
  }
}

const LIT_OPAQUE_TEST = new THREE.Layers();
LIT_OPAQUE_TEST.set(LIT_OPAQUE_LAYER);

export class MaterialPass {
  private readonly diffuseNode: Vec3Node;
  private readonly specularNode: Vec3Node;
  // 一度アップグレードした Material の再変換を避けるための既変換集合。
  private readonly upgraded = new WeakSet<THREE.Material>();

  constructor(
    private readonly renderer: WebGPURenderer,
    private readonly lightPrepass: LightPrepass,
    private readonly gpu: GpuTimings,
  ) {
    this.diffuseNode = texture(this.lightPrepass.diffuseTexture, screenUV).rgb;
    this.specularNode = texture(this.lightPrepass.specularTexture, screenUV).rgb;
  }

  // 標準マテリアルへ上のライティングモデルを据える。mesh.material が既に済みならなにもしない。
  // 呼び出し元がメッシュを組み立てる時点では、ライティングモデルが読む2枚の照度テクスチャ
  // (ライトプリパスの出力)がまだ存在しない — このクラス自身の構築より前には作りようがない —
  // ため、構築時ではなく毎フレームこの呼び出しで据える。
  private upgrade(mesh: THREE.Mesh): void {
    const material = mesh.material as THREE.Material;
    if (this.upgraded.has(material) || !isStandardMaterial(material)) return;

    const upgraded = toStandardNodeMaterial(material);
    upgraded.setupLightingModel = () => new MaterialPassLightingModel(this.diffuseNode, this.specularNode);
    this.upgraded.add(upgraded);
    mesh.material = upgraded;
  }

  // LIT_OPAQUE_LAYER のオブジェクトと背景専用レイヤーを、world パスと共有する HDR ターゲットへ
  // 描く(このパスがそこへの最初の書き込みなのでクリアする)。
  render(scene: THREE.Scene, camera: THREE.Camera, sharedTarget: THREE.RenderTarget): void {
    scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.isMesh && mesh.layers.test(LIT_OPAQUE_TEST)) this.upgrade(mesh);
    });

    const savedMask = camera.layers.mask;
    setOpaquePassLayers(camera);

    // beginPass はこのあとの renderer.render() 呼び出しの直前に呼び、GPU 計測の対象パスを申告する。
    this.gpu.beginPass(GPU_PASS.material);
    this.renderer.setRenderTarget(sharedTarget);
    this.renderer.autoClear = true;
    this.renderer.render(scene, camera);
    this.renderer.setRenderTarget(null);

    camera.layers.mask = savedMask;
  }
}
