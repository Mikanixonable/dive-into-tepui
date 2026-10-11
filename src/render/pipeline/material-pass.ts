// ライトプリパスが書いた照度へ G バッファの素材(ベース色・金属度・自己発光)を掛け合わせ、面の画素の
// 陰影を自分の描画先へ2枚書く — 近くの物体の映り込みが置き換えない成分 keep と、映り込みの像の元 M0
// (中身は ReflectionSource の方式で選ぶ。仮)。背景専用レイヤーの星野を、world パスと共有する HDR ターゲットへ
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

// 映り込みの像の元 M0 の方式(仮)。いずれも放射輝度。
//   specular          — keep + R × 遠方の鏡面照度。面がカメラへ向けて見せる鏡面をそのまま含む。
//   lambert           — 面を反射率 ρ = 拡散色 + R のランバート面とみなした ρ / π × 拡散照度 + 自己発光。
//   lambert-roughness — lambert の R を知覚的粗さ r で弱めた ρ = 拡散色 + r × R。
// TODO: 方式を見比べ終えたら1つに確定し、この切り替えを外す。
export type ReflectionSource = 'specular' | 'lambert' | 'lambert-roughness';
export const REFLECTION_SOURCES: readonly ReflectionSource[] = ['specular', 'lambert', 'lambert-roughness'];

// BRDF_Lambert(反射率 albedo / π)。@types/three 上の戻り値型はメソッドチェインを持たないため、Vec3Node へ読み替える。
function lambertOf(albedo: Vec3Node): Vec3Node {
  return BRDF_Lambert({ diffuseColor: albedo }) as unknown as Vec3Node;
}

// 画素の keep と、方式 source の M0 を MRT の出力として組む。拡散は BRDF_Lambert(ベース色×(1−金属度)/π)、鏡面は
// 鏡面反射率を照度へ掛け、自己発光を足す。照度バッファが持つのは放射照度なので、掛けるのは反射率ではなく BRDF —
// 拡散の 1/π を落とすと、それだけで π 倍明るくなる。
function shadedOutputs(
  lightPrepass: LightPrepass, gbuffer: GBufferPass, source: ReflectionSource,
): ReturnType<typeof mrt> {
  const material = texture(gbuffer.basecolorTexture, screenUV);
  const baseColor: Vec3Node = material.rgb;
  const metalness = material.a;
  const diffuseColor = baseColor.mul(metalness.oneMinus());
  const reflectance = specularReflectanceAt(gbuffer, screenUV);
  const irradiance = texture(lightPrepass.diffuseTexture, screenUV).rgb;
  const diffuse = irradiance.mul(lambertOf(diffuseColor));
  const directSpecular = texture(lightPrepass.directSpecularTexture, screenUV).rgb.mul(reflectance);
  const emissive = texture(gbuffer.emissiveTexture, screenUV).rgb;
  const keep = diffuse.add(directSpecular).add(emissive);

  // 像の元。ρ = 拡散色 + R のランバート面は、一様な環境光の下でこのエンジンが描く面(拡散色 × E/π + R × E/π)と一致する。
  // 鏡面を一様な反射に広げた見え方は、粗い面では元の鏡面に似て、滑らかな面ほど離れる — lambert-roughness はその分 R を弱める。
  const lambertSourceOf = (specularAlbedo: Vec3Node): Vec3Node =>
    irradiance.mul(lambertOf(diffuseColor.add(specularAlbedo))).add(emissive);
  const reflectionSources: Readonly<Record<ReflectionSource, Vec3Node>> = {
    'specular': keep.add(texture(lightPrepass.farSpecularTexture, screenUV).rgb.mul(reflectance)),
    'lambert': lambertSourceOf(reflectance),
    'lambert-roughness': lambertSourceOf(reflectance.mul(texture(gbuffer.roughnessTexture, screenUV).r)),
  };

  // 物体の無い画素は 0。
  const covered = gbuffer.covered();
  return mrt({
    keep: select(covered, vec4(keep, 1), vec4(0)),
    reflectionSource: select(covered, vec4(reflectionSources[source], 1), vec4(0)),
  });
}

// 方式 source の M0 を書く陰影の板のマテリアル。
function shadingMaterial(
  lightPrepass: LightPrepass, gbuffer: GBufferPass, source: ReflectionSource,
): THREE.MeshBasicNodeMaterial {
  const material = new THREE.MeshBasicNodeMaterial({
    depthTest: false, depthWrite: false, transparent: false, blending: THREE.NoBlending,
  });
  material.mrtNode = shadedOutputs(lightPrepass, gbuffer, source);
  return material;
}

export class MaterialPass {
  // 0 枚目は keep、1 枚目は像の元 M0。どちらも面の無い画素は 0。
  private readonly target = new THREE.RenderTarget(1, 1, { count: 2, depthBuffer: false, samples: 0 });
  // 像の元の方式ごとの陰影のマテリアル。方式の切り替えでは持ち替えるだけにする — 組み直すとシェーダの再コンパイルが
  // フレームを止める。
  private readonly materials: Readonly<Record<ReflectionSource, THREE.MeshBasicNodeMaterial>>;
  private reflectionSource: ReflectionSource = 'specular';
  private readonly quad = new QuadMesh();

  // 照度と素材を掛け合わせる全画面の板ポリを、像の元の方式ごとに一度だけ組み立てる。
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
    this.materials = {
      'specular': shadingMaterial(lightPrepass, gbuffer, 'specular'),
      'lambert': shadingMaterial(lightPrepass, gbuffer, 'lambert'),
      'lambert-roughness': shadingMaterial(lightPrepass, gbuffer, 'lambert-roughness'),
    };
  }

  // 近くの物体の映り込みが置き換えない成分 keep = 拡散 + R × 直接の鏡面照度 + 自己発光(放射輝度)。
  public get keepTexture(): THREE.Texture { return this.target.textures[0]!; }
  // 映り込みの像の元 M0(放射輝度)。中身は setReflectionSource で選んだ方式(既定は specular の keep + R × 遠方の鏡面照度)。
  public get reflectionSourceTexture(): THREE.Texture { return this.target.textures[1]!; }

  // 次の render から、像の元を方式 source で書く。TODO: 方式を1つに確定したら外す。
  public setReflectionSource(source: ReflectionSource): void {
    this.reflectionSource = source;
  }

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
    this.quad.material = this.materials[this.reflectionSource];
    this.gpu.beginPass(GPU_PASS.material);
    this.quad.render(this.renderer);

    this.renderer.setRenderTarget(null);
    camera.layers.mask = savedMask;
  }

  // 背景を共有ターゲットへ、いま選んでいる像の元の方式の陰影の板を自分の描画先へ事前コンパイルする。
  public async compile(
    scene: THREE.Scene, camera: THREE.Camera, sharedTarget: THREE.RenderTarget, width: number, height: number,
  ): Promise<void> {
    if (this.target.width !== width || this.target.height !== height) this.target.setSize(width, height);
    // 背景専用レイヤーへ絞ったカメラで組み、呼び出し前のマスクへ戻す。
    const savedMask = camera.layers.mask;
    camera.layers.set(WORLD_BACKGROUND_LAYER);
    try {
      await compileInto(this.renderer, sharedTarget, scene, camera);
      this.quad.material = this.materials[this.reflectionSource];
      await compileInto(this.renderer, this.target, this.quad, this.quad.camera);
    } finally {
      camera.layers.mask = savedMask;
    }
  }

  // 保持している GPU 資源を解放する。QuadMesh の板は three が全インスタンスで共有するので解放しない。
  public dispose(): void {
    this.target.dispose();
    for (const material of Object.values(this.materials)) material.dispose();
  }
}
