// ライトプリパスが書いた照度へ G バッファの素材(ベース色・金属度・自己発光)を掛け合わせ、面の画素の
// 陰影を自分の描画先へ2枚書く — 近くの物体の映り込みが置き換えない成分 keep と、映り込みの像の元
// M0 = keep + R × 遠方の鏡面照度。背景専用レイヤーの星野を、world パスと共有する HDR ターゲットへ
// 最初に描く(クリアする)のもこのパスが担う。
import * as THREE from 'three/webgpu';
import { QuadMesh, WebGPURenderer } from 'three/webgpu';
import { BRDF_Lambert, float, mix, mrt, screenUV, select, texture, vec3, vec4 } from 'three/tsl';
import { GPU_PASS, type GpuTimings } from '../gpu-timings';
import { WORLD_BACKGROUND_LAYER } from './lit-layer';
import type { GBufferPass } from './gbuffer';
import type { LightPrepass } from './light-prepass';
import type { Vec2Node, Vec3Node } from '../tsl-types';
import { compileInto } from './compile-into';

// G バッファの uv の画素の鏡面反射率 R — 照度バッファの鏡面へ掛ける F0(誘電体 0.04 と金属色を金属度で混ぜた値)。
// 鏡面へ届く光に掛ける係数はすべてこれを使う。一様でない分岐の中から読んでよい。
export function specularReflectanceAt(gbuffer: GBufferPass, uv: Vec2Node): Vec3Node {
  // 段を明示して読む — 暗黙の段は画素の間の微分で決まり、一様でない分岐の中では組めない。G バッファの段は 1 つだけ。
  const material = texture(gbuffer.basecolorTexture, uv).level(float(0));
  return mix(vec3(0.04), material.rgb, material.a);
}

// 画素の keep と M0 を MRT の出力として組む。拡散は BRDF_Lambert(ベース色×(1−金属度)/π)、鏡面は鏡面反射率を
// 照度へ掛け、自己発光を足す。照度バッファが持つのは放射照度なので、掛けるのは反射率ではなく BRDF — 拡散の 1/π を
// 落とすと、それだけで π 倍明るくなる。
function shadedOutputs(lightPrepass: LightPrepass, gbuffer: GBufferPass): ReturnType<typeof mrt> {
  const material = texture(gbuffer.basecolorTexture, screenUV);
  const baseColor: Vec3Node = material.rgb;
  const metalness = material.a;
  // BRDF_Lambert の @types/three 上の戻り値型はメソッドチェインを持たないため、Vec3Node へ読み替える。
  const lambert = BRDF_Lambert({
    diffuseColor: baseColor.mul(metalness.oneMinus()),
  }) as unknown as Vec3Node;
  const reflectance = specularReflectanceAt(gbuffer, screenUV);
  const diffuse = texture(lightPrepass.diffuseTexture, screenUV).rgb.mul(lambert);
  const directSpecular = texture(lightPrepass.directSpecularTexture, screenUV).rgb.mul(reflectance);
  const emissive = texture(gbuffer.emissiveTexture, screenUV).rgb;
  const keep = diffuse.add(directSpecular).add(emissive);
  const source = keep.add(texture(lightPrepass.farSpecularTexture, screenUV).rgb.mul(reflectance));

  // 物体の無い画素は 0。
  const covered = gbuffer.covered();
  return mrt({
    keep: select(covered, vec4(keep, 1), vec4(0)),
    reflectionSource: select(covered, vec4(source, 1), vec4(0)),
  });
}

export class MaterialPass {
  // 0 枚目は keep、1 枚目は像の元 M0。どちらも面の無い画素は 0。
  private readonly target = new THREE.RenderTarget(1, 1, { count: 2, depthBuffer: false, samples: 0 });
  private readonly material: THREE.MeshBasicNodeMaterial;
  private readonly quad: QuadMesh;

  // 照度と素材を掛け合わせる全画面の板ポリを一度だけ組み立てる。
  public constructor(
    private readonly renderer: WebGPURenderer,
    lightPrepass: LightPrepass,
    gbuffer: GBufferPass,
    private readonly gpu: GpuTimings,
  ) {
    // 名前は MRT の出力と結び付く。
    for (const [index, name] of ['keep', 'reflectionSource'].entries()) {
      const texture = this.target.textures[index]!;
      texture.name = name;
      texture.format = THREE.RGBAFormat;
      texture.type = THREE.HalfFloatType;
    }
    this.material = new THREE.MeshBasicNodeMaterial({
      depthTest: false, depthWrite: false, transparent: false, blending: THREE.NoBlending,
    });
    this.material.mrtNode = shadedOutputs(lightPrepass, gbuffer);
    this.quad = new QuadMesh(this.material);
  }

  // 近くの物体の映り込みが置き換えない成分 keep = 拡散 + R × 直接の鏡面照度 + 自己発光(放射輝度)。
  public get keepTexture(): THREE.Texture { return this.target.textures[0]!; }
  // 映り込みの像の元 M0 = keep + R × 遠方の鏡面照度(放射輝度)。
  public get reflectionSourceTexture(): THREE.Texture { return this.target.textures[1]!; }

  // 背景専用レイヤーを sharedTarget へ、面の陰影を自分の描画先へ描く。描画バッファの寸法 width × height で呼ぶ。
  // camera はこのあと world パスでも使う同一インスタンスなので、layers.mask は呼び出し前の値へ必ず戻す。
  public render(
    scene: THREE.Scene, camera: THREE.Camera, sharedTarget: THREE.RenderTarget, width: number, height: number,
  ): void {
    if (this.target.width !== width || this.target.height !== height) this.target.setSize(width, height);
    const savedMask = camera.layers.mask;
    camera.layers.set(WORLD_BACKGROUND_LAYER);

    this.renderer.setRenderTarget(sharedTarget);
    // beginPass は描画命令ごとに申告する — 板ポリのぶんも同じパスへ計上する。
    this.gpu.beginPass(GPU_PASS.material);
    this.renderer.autoClear = true;
    this.renderer.render(scene, camera);

    this.renderer.setRenderTarget(this.target);
    this.gpu.beginPass(GPU_PASS.material);
    this.quad.render(this.renderer);

    this.renderer.setRenderTarget(null);
    camera.layers.mask = savedMask;
  }

  // 背景を共有ターゲットへ、陰影の板を自分の描画先へ事前コンパイルする。
  public async compile(
    scene: THREE.Scene, camera: THREE.Camera, sharedTarget: THREE.RenderTarget, width: number, height: number,
  ): Promise<void> {
    if (this.target.width !== width || this.target.height !== height) this.target.setSize(width, height);
    const savedMask = camera.layers.mask;
    camera.layers.set(WORLD_BACKGROUND_LAYER);
    try {
      await compileInto(this.renderer, sharedTarget, scene, camera);
      await compileInto(this.renderer, this.target, this.quad, this.quad.camera);
    } finally {
      camera.layers.mask = savedMask;
    }
  }

  // 保持している GPU 資源を解放する。QuadMesh の板は three が全インスタンスで共有するので解放しない。
  public dispose(): void {
    this.target.dispose();
    this.material.dispose();
  }
}
