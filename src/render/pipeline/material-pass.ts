// 本マテリアルのパス。ライトプリパスの照度・近傍補正・近くの物体の映り込みへ G バッファの素材(ベース色・金属度・
// 自己発光)を掛け合わせた面の画素の最終の陰影と、G バッファの深度を、共有の HDR ターゲットへ書く。映り込みは遠方の
// 鏡面光を置き換える。背景専用レイヤーの星野を共有ターゲットへ最初に描く(クリアする)のもこのパスが担う。
import * as THREE from 'three/webgpu';
import { QuadMesh, WebGPURenderer } from 'three/webgpu';
import { BRDF_Lambert, Discard, Fn, float, max, min, mix, screenUV, texture, vec3, vec4 } from 'three/tsl';
import { GPU_PASS, type GpuTimings } from '../gpu-timings';
import { WORLD_BACKGROUND_LAYER } from './lit-layer';
import type { GBufferPass } from './gbuffer';
import type { LightPrepass } from './light-prepass';
import type { DiffuseCorrection } from './screen-space/diffuse-correction';
import type { ScreenSpaceReflection } from './screen-space/screen-space-reflection';
import type { FloatNode, Vec2Node, Vec3Node, Vec4Node } from '../tsl-types';
import { compileInto } from './compile-into';

// G バッファの uv の画素の鏡面反射率 R — 照度バッファの鏡面へ掛ける F0(誘電体 0.04 と金属色を金属度で混ぜた値)。
// 鏡面へ届く光に掛ける係数はすべてこれを使う。一様でない分岐の中から読んでよい。
export function specularReflectanceAt(gbuffer: GBufferPass, uv: Vec2Node): Vec3Node {
  // 段を明示して読む — 暗黙の段は画素の間の微分で決まり、一様でない分岐の中では組めない。G バッファの段は 1 つだけ。
  const material = texture(gbuffer.basecolorTexture, uv).level(float(0));
  return mix(vec3(0.04), material.rgb, material.a);
}

// 近傍補正が遠方の拡散照度を引き切る所で、0 への折れ目を丸める幅(引く量に対する比)。1 を超えると遠方光の無い所に光が出る。
const UNDERSHOOT_KNEE = 0.5;

// 遠方の拡散照度に近傍補正を足した照度。引く量が遠方光に近づくと 0 へ滑らかに寄せ、負にしない。引く量と遠方光が
// 丸めの幅より離れていれば、足しただけの値か 0 そのもの。
export function diffuseIrradianceAt(distant: Vec3Node, correction: Vec3Node): Vec3Node {
  const subtraction = max(correction.negate(), vec3(0));
  const knee = subtraction.mul(UNDERSHOOT_KNEE);
  const overlap = max(knee.sub(subtraction.sub(distant).abs()), vec3(0));
  // 引く量と遠方光の 2 次の smooth min。引く量が 0 なら丸めも 0。
  const softMin = min(subtraction, distant).sub(overlap.mul(overlap).div(max(knee, vec3(1e-20)).mul(4)));
  return distant.add(max(correction, vec3(0))).sub(softMin);
}

// 画素 screenUV の拡散照度。correction が null でなければ近傍補正を足し(diffuseIrradianceAt)、null なら遠方の拡散照度そのもの
// (近傍補正が空のフレームで補正を読まずに済ませる)。
export function receivedIrradiance(lightPrepass: LightPrepass, correction: DiffuseCorrection | null): Vec3Node {
  const distant = texture(lightPrepass.diffuseTexture, screenUV).rgb;
  return correction === null ? distant : diffuseIrradianceAt(distant, correction.atUv(screenUV));
}

// BRDF_Lambert(反射率 albedo / π)。照度は放射照度なので、拡散へは反射率ではなく BRDF を掛ける — 1/π を落とすと
// π 倍明るくなる。@types/three 上の戻り値型はメソッドチェインを持たないため、Vec3Node へ読み替える。
function lambertOf(albedo: Vec3Node): Vec3Node {
  return BRDF_Lambert({ diffuseColor: albedo }) as unknown as Vec3Node;
}

// G バッファの uv の画素の拡散色(ベース色を金属度で弱めたもの)。段を明示して読む。
function diffuseColorAt(gbuffer: GBufferPass, uv: Vec2Node): Vec3Node {
  const material = texture(gbuffer.basecolorTexture, uv).level(float(0));
  return material.rgb.mul(material.a.oneMinus());
}

// G バッファの uv の画素の面を、反射率 ρ = 拡散色 + r × R(r は知覚的粗さ、R は specularReflectanceAt)のランバート面と
// みなし、照度 irradiance [SUN_IRRADIANCE_1AU の目盛り] の下で放つ放射輝度に自己発光を足したもの。一様でない分岐の中から読んでよい。
export function lambertianRadianceAt(gbuffer: GBufferPass, uv: Vec2Node, irradiance: Vec3Node): Vec3Node {
  // R を足すと一様な環境光の下で描く面と一致し、粗さで弱めるのは一様に広げた見え方が滑らかな面ほど元の鏡面から離れるため。
  // 描いた鏡面をそのまま入れると、小さく明るいハイライトに当たる回数が画素ごとに揺らいでブロック状に明滅し、向きも
  // カメラへ向けた鏡面になる。
  const roughness = texture(gbuffer.roughnessTexture, uv).level(float(0)).r;
  const reflectance = specularReflectanceAt(gbuffer, uv);
  const albedo = diffuseColorAt(gbuffer, uv).add(reflectance.mul(roughness));
  return irradiance.mul(lambertOf(albedo)).add(texture(gbuffer.emissiveTexture, uv).level(float(0)).rgb);
}

// 画素の最終の陰影 拡散 + R × 直接の鏡面照度 + 自己発光 + R × farSpecular。farSpecular は映り込みが置き換えた後の
// 遠方の鏡面照度。物体の無い画素は捨てる。
function shadedColor(
  lightPrepass: LightPrepass, gbuffer: GBufferPass, correction: DiffuseCorrection | null, farSpecular: Vec3Node,
): Vec4Node {
  return Fn(() => {
    Discard(gbuffer.covered().not());
    // 拡散は照度へ近傍補正を足してから BRDF を掛け、鏡面は照度へ R を掛ける。
    const diffuse = receivedIrradiance(lightPrepass, correction).mul(lambertOf(diffuseColorAt(gbuffer, screenUV)));
    const reflectance = specularReflectanceAt(gbuffer, screenUV);
    const directSpecular = texture(lightPrepass.directSpecularTexture, screenUV).rgb.mul(reflectance);
    const emissive = texture(gbuffer.emissiveTexture, screenUV).rgb;
    return vec4(diffuse.add(directSpecular).add(emissive).add(farSpecular.mul(reflectance)), 1);
  })();
}

// 陰影の板のマテリアル。深度は G バッファのものを複製する。depthTest を切ったまま depthWrite を立てるので、捨てなかった
// 画素が無条件に書かれる。
function shadingMaterial(
  lightPrepass: LightPrepass, gbuffer: GBufferPass, correction: DiffuseCorrection | null, farSpecular: Vec3Node,
): THREE.MeshBasicNodeMaterial {
  const material = new THREE.MeshBasicNodeMaterial({
    depthTest: false, depthWrite: true, transparent: false, blending: THREE.NoBlending,
  });
  material.colorNode = shadedColor(lightPrepass, gbuffer, correction, farSpecular);
  material.depthNode = texture(gbuffer.depthTexture, screenUV).r;
  return material;
}

// 遠方の鏡面照度を、重み w と重みを掛けた像 w × I(映り込みの同じ描画先の同じ texel から読んだもの)で置き換えた鏡面照度。
function replacedFarSpecular(lightPrepass: LightPrepass, weight: FloatNode, weightedImage: Vec3Node): Vec3Node {
  return texture(lightPrepass.farSpecularTexture, screenUV).rgb.mul(weight.oneMinus()).add(weightedImage);
}

// 映り込みを読まない・均す前を読む・均したを読むの 3 枚の組。
interface ReflectionMaterials {
  readonly off: THREE.MeshBasicNodeMaterial;
  readonly raw: THREE.MeshBasicNodeMaterial;
  readonly denoised: THREE.MeshBasicNodeMaterial;
}

// 近傍補正を読む(correction が null でない)か読まないかの 1 通りについて、映り込みの読み方 3 通りの板を組む。読まない板は
// 遠方の鏡面照度をそのまま使い、読む 2 枚は均す前・均した映り込みで置き換える。
function reflectionMaterials(
  lightPrepass: LightPrepass, gbuffer: GBufferPass, correction: DiffuseCorrection | null,
  reflection: ScreenSpaceReflection,
): ReflectionMaterials {
  // 映り込みを読む 2 枚は、同じ描画先の同じ texel から w と w × I を読む。
  return {
    off: shadingMaterial(lightPrepass, gbuffer, correction, texture(lightPrepass.farSpecularTexture, screenUV).rgb),
    raw: shadingMaterial(
      lightPrepass, gbuffer, correction,
      replacedFarSpecular(lightPrepass, reflection.rawWeightAt(screenUV), reflection.rawWeightedImageAt(screenUV)),
    ),
    denoised: shadingMaterial(
      lightPrepass, gbuffer, correction,
      replacedFarSpecular(
        lightPrepass, reflection.denoisedWeightAt(screenUV), reflection.denoisedWeightedImageAt(screenUV),
      ),
    ),
  };
}

export class MaterialPass {
  // 近傍補正を読む組と読まない組の、それぞれ 3 枚(計 6 枚)。設定の切り替えでは持ち替える — 組み直すとシェーダの
  // 再コンパイルがフレームを止める。読むテクスチャは WebGPU が保証する 16 枚に収めること — 超えるとパイプラインの
  // 生成に失敗して画面全体が黒くなる。
  private readonly correctedMaterials: ReflectionMaterials;
  private readonly uncorrectedMaterials: ReflectionMaterials;
  private readonly quad = new QuadMesh();

  // reflectionEnabled / reflectionDenoised / corrected は構築時点の描画設定 screenSpaceSpecular / screenSpaceSpecularDenoise /
  // 「遮蔽と照り返し」がオフでないか、の値。
  public constructor(
    private readonly renderer: WebGPURenderer,
    lightPrepass: LightPrepass,
    gbuffer: GBufferPass,
    correction: DiffuseCorrection,
    reflection: ScreenSpaceReflection,
    private readonly gpu: GpuTimings,
    private reflectionEnabled: boolean,
    private reflectionDenoised: boolean,
    private corrected: boolean,
  ) {
    this.correctedMaterials = reflectionMaterials(lightPrepass, gbuffer, correction, reflection);
    this.uncorrectedMaterials = reflectionMaterials(lightPrepass, gbuffer, null, reflection);
  }

  // 次の render から、enabled が偽なら映り込みを読まず、真なら均した(denoised)か均す前の映り込みを読む。
  public setReflection(enabled: boolean, denoised: boolean): void {
    this.reflectionEnabled = enabled;
    this.reflectionDenoised = denoised;
  }

  // 次の render から、corrected が真なら近傍補正を照度へ足して読み、偽なら読まない。
  public setCorrected(corrected: boolean): void {
    this.corrected = corrected;
  }

  // 背景専用レイヤーを sharedTarget へ(クリアして)描き、その上へ面の画素を上書きする。camera の layers.mask は
  // 呼び出し前の値へ戻して返る。
  public render(scene: THREE.Scene, camera: THREE.Camera, sharedTarget: THREE.RenderTarget): void {
    const savedMask = camera.layers.mask;
    camera.layers.set(WORLD_BACKGROUND_LAYER);

    this.renderer.setRenderTarget(sharedTarget);
    // beginPass は描画命令ごとに申告する — 板ポリのぶんも同じパスへ計上する。
    this.gpu.beginPass(GPU_PASS.material);
    this.renderer.autoClear = true;
    this.renderer.render(scene, camera);

    this.quad.material = this.currentMaterial();
    this.gpu.beginPass(GPU_PASS.material);
    this.renderer.autoClear = false;
    this.quad.render(this.renderer);
    this.renderer.autoClear = true;

    this.renderer.setRenderTarget(null);
    camera.layers.mask = savedMask;
  }

  // 背景と 6 枚の陰影の板を共有ターゲットへ事前コンパイルする。
  public async compile(scene: THREE.Scene, camera: THREE.Camera, sharedTarget: THREE.RenderTarget): Promise<void> {
    const savedMask = camera.layers.mask;
    camera.layers.set(WORLD_BACKGROUND_LAYER);
    try {
      await compileInto(this.renderer, sharedTarget, scene, camera);
      // 設定の切り替えで持ち替える 6 枚とも、初回の切り替えでコンパイルを待たないよう先に組む。
      for (const material of this.allMaterials()) {
        this.quad.material = material;
        await compileInto(this.renderer, sharedTarget, this.quad, this.quad.camera);
      }
    } finally {
      camera.layers.mask = savedMask;
    }
  }

  // 保持している GPU 資源を解放する。QuadMesh の板は three が全インスタンスで共有するので解放しない。
  public dispose(): void {
    for (const material of this.allMaterials()) material.dispose();
  }

  // 持っている 6 枚すべて。
  private allMaterials(): THREE.MeshBasicNodeMaterial[] {
    return [this.correctedMaterials, this.uncorrectedMaterials].flatMap((set) => [set.off, set.raw, set.denoised]);
  }

  // いまの設定が読む補正と映り込みのマテリアル。
  private currentMaterial(): THREE.MeshBasicNodeMaterial {
    const set = this.corrected ? this.correctedMaterials : this.uncorrectedMaterials;
    if (!this.reflectionEnabled) return set.off;
    return this.reflectionDenoised ? set.denoised : set.raw;
  }
}
