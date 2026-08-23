// G バッファ(法線・粗さ・深度)だけを読み、そのシェーディング点に届く光の量を拡散/鏡面の
// 2枚の照度バッファへ書く。素材のアルベド・金属度・F0 は一切知らない — それらを掛けて最終色を
// 出すのはマテリアルパスの役目で、このパスは「どれだけの光が、どこから届くか」だけを答える。
//
// マテリアル固有の F0(反射率の色)を持たないため、鏡面照度は F0=1 で仮に評価した値になる —
// フレネル項をマテリアルパス側で掛け直す前提の、ライトプリパスという構成そのものが持つ制約。
import * as THREE from 'three/webgpu';
import { QuadMesh, WebGPURenderer } from 'three/webgpu';
import {
  D_GGX, F_Schlick, V_GGX_SmithCorrelated, dot, float, mrt, normalize, saturate,
  screenUV, texture, uniform, vec4,
} from 'three/tsl';
import { SHADOW_MIN_SUN } from '../../game/const';
import { GPU_PASS, type GpuTimings } from '../../gpu-timings';
import type { FloatNode, Mat4Uniform, Vec3Node, Vec3Uniform } from '../tsl-types';
import { GBufferPass, octDecodeNormal } from './gbuffer';
import type { OcclusionPass } from './occlusion';
import type { SunLight } from './sun-light';
import { viewPositionAt, viewRayAt } from './view-ray';

export class LightPrepass {
  private readonly renderer: WebGPURenderer;
  private readonly target: THREE.RenderTarget;
  private readonly quad: QuadMesh;
  // quad.material は Mesh 由来の Material|Material[] 型で dispose を持たないため、
  // 構築した具体型のまま別途保持する。
  private readonly material: THREE.MeshBasicNodeMaterial;
  private readonly mrtNode: ReturnType<typeof mrt>;
  // QuadMesh は固定直交カメラで描かれるため、実カメラの逆射影行列は毎フレーム自前で書き込む
  // (render-pipeline.ts の depthDebugNear/Far と同じ理由)。
  private readonly projMatrixInverse: Mat4Uniform;
  // 恒星の位置は描画座標(SunLight.position)で保持されるので、G バッファの法線・復元位置と
  // 同じ view 空間へ移した値を毎フレーム CPU 側で用意する — シェーダ内で行列を組むより単純。
  private readonly sunPositionView: Vec3Uniform;
  private readonly scratchPosition = new THREE.Vector3();

  constructor(
    renderer: WebGPURenderer,
    private readonly gbuffer: GBufferPass,
    occlusion: OcclusionPass,
    private readonly sunLight: SunLight,
    private readonly gpu: GpuTimings,
  ) {
    this.renderer = renderer;

    // diffuse/specular の2枚。企画書は「rgb16float」と書くが WebGPU に3チャンネル16bit浮動小数点
    // フォーマットは無いため、実際には rgba16float(a は未使用)を使う。
    this.target = new THREE.RenderTarget(1, 1, { count: 2, depthBuffer: false, samples: 0 });
    const [diffuseTex, specularTex] = this.target.textures;
    diffuseTex!.name = 'diffuse';
    diffuseTex!.format = THREE.RGBAFormat;
    diffuseTex!.type = THREE.HalfFloatType;
    specularTex!.name = 'specular';
    specularTex!.format = THREE.RGBAFormat;
    specularTex!.type = THREE.HalfFloatType;

    this.projMatrixInverse = uniform(new THREE.Matrix4());
    this.sunPositionView = uniform(new THREE.Vector3(0, 1, 0));

    const normal = octDecodeNormal(texture(this.gbuffer.normalTexture, screenUV).rg);
    const roughnessValue = texture(this.gbuffer.roughnessTexture, screenUV).r;

    const viewPos = viewPositionAt(this.gbuffer.depthTexture, this.projMatrixInverse);
    // 面から視点へ向かう向き = 視線の逆向き。「復元位置の逆向き」は透視投影でしか成り立たない
    // ので、投影方式に依らない形(view-ray.ts)から取る。
    const viewDir = viewRayAt(this.projMatrixInverse).direction.negate();
    // 恒星は点光源。画素ごとに差分ベクトルを取るので、方向も逆二乗の減衰もその画素のものになる。
    const toSun = this.sunPositionView.sub(viewPos);
    const lightDir = normalize(toSun);

    const dotNL: FloatNode = saturate(dot(normal, lightDir));
    // 恒星から届く放射照度(遮蔽込み)。拡散・鏡面の両方がこれを基準に BRDF を掛ける。
    // 恒星の直射は遮蔽パスの透過率で落ち、本影では 0 になる。そこへ足す SHADOW_MIN_SUN は、
    // 影の中にも届く星明かり・地球照ぶんを「恒星と同じ向きから来る一定量」で代用したもので、
    // 基準強度のうちその割合を直射から分けて持つ。
    const direct = texture(occlusion.texture, screenUV).r.mul(1 - SHADOW_MIN_SUN);
    const sunlit = direct.add(SHADOW_MIN_SUN);
    const irradiance: Vec3Node = this.sunLight.color
      .mul(this.sunLight.intensity).div(dot(toSun, toSun))
      .mul(dotNL).mul(sunlit);
    const diffuse: Vec3Node = irradiance.add(this.sunLight.ambientColor.mul(this.sunLight.ambientIntensity));

    const alpha = roughnessValue.mul(roughnessValue);
    const halfDir = normalize(lightDir.add(viewDir));
    const dotNH = saturate(dot(normal, halfDir));
    const dotNV = saturate(dot(normal, viewDir));
    const dotVH = saturate(dot(viewDir, halfDir));
    // D_GGX/V_GGX_SmithCorrelated/F_Schlick の @types/three 上の戻り値型 OperatorNode は
    // メソッドチェインを持たない(実体は他の TSL ノードと同じプロキシで、型定義側の欠落)ため、
    // FloatNode へ読み替えてから掛け合わせる。
    const fresnel = F_Schlick({ f0: float(1), f90: float(1), dotVH }) as unknown as FloatNode;
    const visibility = V_GGX_SmithCorrelated({ alpha, dotNL, dotNV }) as unknown as FloatNode;
    const distribution = D_GGX({ alpha, dotNH }) as unknown as FloatNode;
    const ggx = fresnel.mul(visibility).mul(distribution);
    const specular: Vec3Node = irradiance.mul(ggx);

    this.mrtNode = mrt({ diffuse: vec4(diffuse, 1), specular: vec4(specular, 1) });

    this.material = new THREE.MeshBasicNodeMaterial({ depthTest: false, depthWrite: false });
    this.quad = new QuadMesh(this.material);
  }

  get diffuseTexture(): THREE.Texture { return this.target.textures[0]!; }
  get specularTexture(): THREE.Texture { return this.target.textures[1]!; }

  // G バッファを読んで拡散/鏡面の照度バッファへ書く。camera は逆射影行列と恒星位置の view 空間
  // 変換を毎フレーム引き直すためだけに使い、シーン自体は描かない(フルスクリーン1枚のみ)。
  render(camera: THREE.Camera, width: number, height: number): void {
    if (this.target.width !== width || this.target.height !== height) this.target.setSize(width, height);

    this.projMatrixInverse.value.copy(camera.projectionMatrixInverse);
    this.scratchPosition.copy(this.sunLight.position.value).applyMatrix4(camera.matrixWorldInverse);
    this.sunPositionView.value.copy(this.scratchPosition);

    this.renderer.setMRT(this.mrtNode);
    this.renderer.setRenderTarget(this.target);
    // beginPass はこのあとの renderer.render() 呼び出しの直前に呼び、GPU 計測の対象パスを申告する。
    this.gpu.beginPass(GPU_PASS.lighting);
    this.quad.render(this.renderer);
    this.renderer.setRenderTarget(null);
    this.renderer.setMRT(null);
  }

  // 保持している GPU 資源を解放する。QuadMesh の geometry は three が全インスタンスで
  // 共有する単一の板なので、ここでは解放しない。
  dispose(): void {
    this.target.dispose();
    this.material.dispose();
  }
}
