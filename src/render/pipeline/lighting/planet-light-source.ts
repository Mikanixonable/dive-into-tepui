// 天体照の光源。恒星以外の天体が反射して届ける光を球光源としてスロット本数ぶん持ち、
// スロット 1 本がライティングパスの描画命令 1 本になる。球の放射輝度は、一様な色として持つか、
// その天体の見た目を焼いた写し(planet-light-image.ts)から向きごとに読むかを設定で選ぶ。
// 載せる天体とその値は、毎フレーム set() で受ける。
import * as THREE from 'three/webgpu';
import {
  Fn, PI, acos, asin, clamp, cos, dot, float, length, max, min, normalize, select, sin, sqrt, uniform,
} from 'three/tsl';
import { LAMBERT_SPHERE_GEOMETRIC_ALBEDO_RATIO } from '../../../physics/lambert-sphere';
import { contributionMaterial, type LightContribution, type LightSource } from './light-source';
import { PlanetLightImage } from './planet-light-image';
import { sphereIrradianceFactor, type SphereSpecular } from './sphere-light';
import type { WebGPURenderer } from 'three/webgpu';
import type { Albedo } from '../../celestial-albedo';
import type { GpuTimingSink } from '../../gpu-timings';
import type { PlanetLightAppearance, PlanetLightSubject } from './planet-light-subject';
import type {
  BoolUniform, ColorUniform, FloatNode, FloatUniform, Vec2Node, Vec3Node, Vec3Uniform,
} from '../../tsl-types';
import type { CloudSpecies } from '../cloud-atmosphere-renderer';
import type { BodyShadow } from '../shadow/body-shadow';
import type { SunLight } from '../sun-light';
import type { ShadingSample } from './shading-sample';

// 用意するスロットの本数。同時に使う本数は描画設定 planetLightCount(0〜この値)で決まる。
// 3 体目の放射照度が描画結果に視覚的影響を与えるほど明るい構図は、低高度のイオ周回軌道（イオ本体＋木星）のような場合に
// 限られる。
export const MAX_PLANET_LIGHT_SLOTS = 2;

// 受け手から見えている地表のキャップの半角へ張る床 [rad]。球に接する受け手ではキャップが
// 1 点へ縮退するため、下限ガードが無いと半角 0 の除算で NaN が発生する。下限ガードが適用される区間は位相角にして 2 倍の
// この値 — 地球の中心角で 1.3 km と、どの構図でも 1 画素を切る。
const MIN_VISIBLE_CAP_ANGLE = 1e-4;

// 光源モデルの選択値。graphics-settings.ts の planetLightModel の選択肢と対応する。
const PLANET_LIGHT_MODEL = { uniformSphere: 0, textured: 1 } as const;

// 拡散のローブを覆うフィルタの角幅 [rad]。クランプドコサイン(立体角 π)と同じ立体角の円錐の半角。
const DIFFUSE_FILTER_ANGLE = 1.05;

// スロット 1 本の値。中心・半径は描画座標、放射輝度は色つき(SUN_IRRADIANCE_1AU の目盛り)。
export interface PlanetLightValue {
  readonly center: THREE.Vector3;
  readonly radius: number;
  readonly radiance: Albedo;
  // 写しへ焼くのに要る見た目。写しから描けない天体では null。
  readonly appearance: PlanetLightAppearance | null;
}

// 一様球としての放射輝度(色つき)。albedo は輝度がボンドアルベドに一致する線形 RGB、
// sunIrradiance はその天体の場所の太陽放射照度。満相のランバート球の全放射強度と一致する
// 取り方(L̄ = (2/3)·A·E_b/π)なので、距離とともに点光源へ連続に縮退する。満相の値で、
// 満ち欠けは受け手が掛ける。
export function planetRadiance(albedo: Albedo, sunIrradiance: number): Albedo {
  const scale = LAMBERT_SPHERE_GEOMETRIC_ALBEDO_RATIO * sunIrradiance / Math.PI;
  return [albedo[0] * scale, albedo[1] * scale, albedo[2] * scale];
}

// スロット 1 本ぶんの uniform。
interface SlotUniforms {
  readonly center: Vec3Uniform;
  readonly radius: FloatUniform;
  readonly radiance: ColorUniform;
}

// 半角 capAngle のキャップのうち、日が当たっている面積の割合 0..1。alpha はキャップの中心が
// 太陽直下点から離れた角で、昼夜境界は中心から π/2 − alpha の位置を通る。
//
// **球面のキャップを平面の円板と見なした近似。** キャップが広いほど乗る誤差は、receiverPhase が
// 遠方極限との比で使うので分子と分母で打ち消し合う。
const sunlitCapFraction = Fn(([alpha, capAngle]: readonly [FloatNode, FloatNode]) => {
  const u = clamp(PI.mul(0.5).sub(alpha).div(capAngle), -1, 1);
  return acos(u.negate()).add(u.mul(sqrt(max(float(1).sub(u.mul(u)), 0)))).div(PI);
});

// 受け手ごとの満ち欠けの係数 0..1。遠方の円板として見たときのランバート位相
// (physics/lambert-sphere.ts の lambertPhase と同じ式)を、その受け手から見えている地表の
// 日照割合で頭打ちにする。キャップが半球まで広がる遠方と、昼側(alpha ≤ π/2)では位相そのもの。
const receiverPhase = Fn(([alpha, capAngle]: readonly [FloatNode, FloatNode]) => {
  const phase = sin(alpha).add(PI.sub(alpha).mul(cos(alpha))).div(PI);
  const visible = sunlitCapFraction(alpha, capAngle);
  const whole = sunlitCapFraction(alpha, float(Math.PI / 2));
  // visible / max(visible, whole) は min(1, visible/whole) と同値で、どちらも 0 の
  // 新相でも 0 を返す。
  return phase.mul(visible.div(max(max(visible, whole), 1e-6)));
});

// 向き v を、軸 axis・半角 σ の円錐へ収めた向き。円錐の中なら v そのもの、外なら縁のうち v に
// 最も近い向き。σ → 0 で軸へ、σ → π/2 で v へ連続に落ちるので、分岐点で絵が飛ばない。
const clampedToCone = Fn((
  [v, axis, cosSigma, sinSigma]: readonly [Vec3Node, Vec3Node, FloatNode, FloatNode],
) => {
  const cosVA = dot(v, axis);
  const perp = v.sub(axis.mul(cosVA));
  // 軸に平行な向きでは面内成分が 0 なので、下限で割って縁の向きを軸そのものへ落とす。
  const edge = axis.mul(cosSigma).add(perp.div(max(length(perp), 1e-6)).mul(sinSigma));
  return select(cosVA.greaterThanEqual(cosSigma), v, edge);
});

// スロット 1 本ぶんの光源。拡散反射も鏡面反射も、視半径を持つ球光源モデルとして評価する
// (sphere-light.ts)。大きさはその閉じた解が持ち、写しは色の倍率としてしか効かない。
// TODO: 影を受けない — 受け手と天体の間に別の天体や艦の構造があっても届く。
class PlanetLightSlot implements LightSource {
  // モードごとに 1 枚を遅延生成して持つ。切り替えのたびに作り直すと、シェーダの再コンパイルが
  // フレームを止める。
  private readonly materials = new Map<number, THREE.MeshBasicNodeMaterial>();
  // このスロットの天体の見た目を持つ写しと、そこへ焼く内容。消灯している間は null。
  private readonly image: PlanetLightImage;
  private appearance: PlanetLightAppearance | null = null;
  // 写しへ焼く見た目があるか。無いスロットはテクスチャのモードでも一様球で描く。
  private readonly imaged: BoolUniform = uniform(false);

  // sunLight からは、満ち欠けを測る恒星の位置を読む。bodyShadow は写しの大気が読む天体の影。
  // model は描画設定 planetLightModel の値。
  public constructor(
    private readonly sunLight: SunLight,
    bodyShadow: BodyShadow,
    private readonly sphereSpecular: SphereSpecular,
    private readonly slot: SlotUniforms,
    private model: number,
  ) {
    this.image = new PlanetLightImage(sunLight, bodyShadow);
  }

  public hasContribution(): boolean { return this.slot.radius.value > 0; }

  // このスロットの写しが写す天体。
  public get subject(): PlanetLightSubject { return this.image.subject; }

  // 描画設定 planetLightModel の値を設定する。次回の material() 取得時から適用される。
  public setModel(model: number): void { this.model = model; }

  // このフレームに写しへ焼く見た目を置く。消灯するスロットへは null を置く。
  public setAppearance(appearance: PlanetLightAppearance | null): void {
    this.appearance = appearance;
    this.imaged.value = appearance !== null;
  }

  // 置かれた見た目を写しへ焼く。reference は写しの基準点(描画座標)。一様球のモードでは、
  // 写しを読む経路が無いので焼かない。
  public bake(renderer: WebGPURenderer, reference: THREE.Vector3, gpu?: GpuTimingSink): void {
    if (this.appearance === null || this.model === PLANET_LIGHT_MODEL.uniformSphere) return;
    this.image.set(reference, this.slot.center.value, this.slot.radius.value, this.appearance);
    this.image.render(renderer, gpu);
  }

  // このスロットの写しを uv(0..1)で読んだ放射輝度。
  public imageRadianceAt(uv: Vec2Node): Vec3Node { return this.image.radianceAtUv(uv); }

  // このスロットの寄与を描くマテリアル。モードごとに初回だけ組む。
  public material(sample: ShadingSample): THREE.MeshBasicNodeMaterial {
    const cached = this.materials.get(this.model);
    if (cached !== undefined) return cached;
    const material = contributionMaterial(sample, this.contribution(sample));
    this.materials.set(this.model, material);
    return material;
  }

  // このスロットの球光源がシェーディング点へ届ける照度。
  private contribution(sample: ShadingSample): LightContribution {
    const center = sample.viewPositionOf(this.slot.center);
    const toCenter = center.sub(sample.position);
    const lightDir = toCenter.div(max(length(toCenter), 1));
    const cosBeta = dot(sample.normal, lightDir);
    const sinSigmaSqr = clamp(
      this.slot.radius.mul(this.slot.radius).div(dot(toCenter, toCenter)), 0, 1,
    );
    // 受け手へ届く放射輝度。テクスチャのモードでは、拡散はクランプドコサインの峰(法線)、
    // 鏡面は GGX のローブの峰(反射ベクトル)の向きで写しから読む。
    const sphereRadiance = this.uniformSphereRadiance(sample, center, lightDir, sinSigmaSqr);
    const textured = this.model === PLANET_LIGHT_MODEL.textured;
    const reflected = sample.normal.mul(dot(sample.normal, sample.viewDir).mul(2))
      .sub(sample.viewDir);
    const diffuseRadiance = textured
      ? this.imageRadiance(
        sample, sample.normal, float(DIFFUSE_FILTER_ANGLE), lightDir, sinSigmaSqr, sphereRadiance)
      : sphereRadiance;
    const specularRadiance = textured
      ? this.imageRadiance(
        sample, reflected, this.specularFilterAngle(sample, sinSigmaSqr), lightDir, sinSigmaSqr,
        sphereRadiance)
      : sphereRadiance;
    // 一様球の放射照度 E = π·L̄·sin²σ × クリップ係数(全可視では saturate(cosβ) に一致)。
    // **大きさを作るのはこの 2 つの係数だけ**で、写しは色の倍率としてしか効かない — 写しの値で
    // エネルギーを作ると、高周波の地表で総光量が破れる。
    const diffuse: Vec3Node = diffuseRadiance.mul(PI).mul(sinSigmaSqr)
      .mul(sphereIrradianceFactor(cosBeta, sinSigmaSqr));
    const specular: Vec3Node = specularRadiance
      .mul(this.sphereSpecular.factor(sample, center, this.slot.radius));
    return { diffuse, specular };
  }

  // 一様な球として描くときの放射輝度。満ち欠けは受け手ごとに決まるのでここで掛ける。
  // center・lightDir は view 空間、sinSigmaSqr は視半径 σ の正弦の 2 乗。
  private uniformSphereRadiance(
    sample: ShadingSample, center: Vec3Node, lightDir: Vec3Node, sinSigmaSqr: FloatNode,
  ): Vec3Node {
    // 位相角 = 天体中心から見た恒星と受け手のなす角。sin σ = R/d の余角が、受け手から見えて
    // いる地表のキャップの半角になる。
    const toStar = normalize(sample.viewPositionOf(this.sunLight.position).sub(center));
    const alpha = acos(clamp(dot(lightDir.negate(), toStar), -1, 1));
    const capAngle = max(acos(clamp(sqrt(sinSigmaSqr), 0, 1)), MIN_VISIBLE_CAP_ANGLE);
    return this.slot.radiance.mul(receiverPhase(alpha, capAngle));
  }

  // 鏡面が写しを読むフィルタの角幅 [rad]。GGX のローブ半幅 2α と、光源の円錐の半角 σ の小さい方。
  private specularFilterAngle(sample: ShadingSample, sinSigmaSqr: FloatNode): FloatNode {
    const ggxAlpha = sample.roughness.mul(sample.roughness);
    return min(ggxAlpha.mul(2), asin(clamp(sqrt(sinSigmaSqr), 0, 1)));
  }

  // 写しをローブの峰の向きで読んだ放射輝度。lobe は view 空間のローブの峰、filterAngle はその
  // 角幅 [rad]、axis は光源の円錐の軸(view 空間)。峰を円錐へ収め、描画座標へ戻して引く。
  // 写しを持たないスロットは sphereRadiance をそのまま返す。
  private imageRadiance(
    sample: ShadingSample, lobe: Vec3Node, filterAngle: FloatNode,
    axis: Vec3Node, sinSigmaSqr: FloatNode, sphereRadiance: Vec3Node,
  ): Vec3Node {
    const sinSigma = sqrt(sinSigmaSqr);
    const cosSigma = sqrt(max(float(1).sub(sinSigmaSqr), 0));
    const direction = clampedToCone(lobe, axis, cosSigma, sinSigma) as unknown as Vec3Node;
    const sampled = this.image.radianceAt(
      sample.worldPosition, sample.worldDirectionOf(direction), filterAngle);
    return select(this.imaged, sampled, sphereRadiance);
  }

  // 組んだマテリアルと写しを解放する。
  public dispose(): void {
    for (const material of this.materials.values()) material.dispose();
    this.image.dispose();
  }
}

export class PlanetLightSource {
  private readonly slots: readonly SlotUniforms[] = Array.from(
    { length: MAX_PLANET_LIGHT_SLOTS },
    () => ({ center: uniform(new THREE.Vector3()), radius: uniform(0), radiance: uniform(new THREE.Color(0, 0, 0)) }),
  );
  private readonly slotSources: readonly PlanetLightSlot[];

  // sunLight は満ち欠けを測る恒星、bodyShadow は写しの大気が読む天体の影、count は同時に使う
  // スロットの本数(描画設定 planetLightCount の値)、model は光源モデル(描画設定 planetLightModel の値)。
  public constructor(
    sunLight: SunLight, bodyShadow: BodyShadow, sphereSpecular: SphereSpecular, private count: number,
    model: number,
  ) {
    this.slotSources = this.slots.map(
      (slot) => new PlanetLightSlot(sunLight, bodyShadow, sphereSpecular, slot, model));
  }

  // 同時に使用するスロット本数を変更する。次回の set() 呼び出し時から適用される。
  public setCount(count: number): void { this.count = count; }

  // 描画設定 planetLightModel の値を全スロットへ配る。
  public setModel(model: number): void {
    for (const source of this.slotSources) source.setModel(model);
  }

  // 写しへ大気を写すか(描画設定「大気」がオフでない)を全スロットへ配る。
  public setAtmosphereEnabled(enabled: boolean): void {
    for (const source of this.slotSources) source.subject.setAtmosphereEnabled(enabled);
  }

  // 写しへ不透明な積雲を焼き込むか(描画設定「積雲の精細さ」がオフでない)を全スロットへ配る。
  public setCumulusEnabled(enabled: boolean): void {
    for (const source of this.slotSources) source.subject.setCumulusEnabled(enabled);
  }

  // 写しの大気の中に、種類ごとの雲の殻を描くかを全スロットへ配る。
  public setCloudShellEnabled(species: CloudSpecies, enabled: boolean): void {
    for (const source of this.slotSources) source.subject.setCloudShellEnabled(species, enabled);
  }

  // ライティングパスへ渡す光源の列。スロット 1 本が描画命令 1 本になる。
  public get lightSources(): readonly LightSource[] { return this.slotSources; }

  // スロット 0 の写しを uv(0..1)で読んだ放射輝度。
  public imageRadianceAt(uv: Vec2Node): Vec3Node { return this.slotSources[0]!.imageRadianceAt(uv); }

  // 各スロットの写しを、このフレームの見た目で焼き直す。reference は写しの基準点(描画座標)。
  public bake(renderer: WebGPURenderer, reference: THREE.Vector3, gpu?: GpuTimingSink): void {
    for (const source of this.slotSources) source.bake(renderer, reference, gpu);
  }

  // このフレームの光源の列。本数を超えたぶんは捨て、足りないスロットは消灯する。
  public set(lights: readonly PlanetLightValue[]): void {
    const used = lights.slice(0, this.count);
    for (const [i, slot] of this.slots.entries()) {
      const light = used[i];
      slot.radius.value = light === undefined ? 0 : light.radius;
      this.slotSources[i]!.setAppearance(light?.appearance ?? null);
      if (light === undefined) continue;
      slot.center.value.copy(light.center);
      slot.radiance.value.setRGB(light.radiance[0], light.radiance[1], light.radiance[2]);
    }
  }
}
