// 天体照の光源。恒星以外の天体が反射して届ける光を、一様な放射輝度の球光源として
// スロット本数ぶん持ち、スロット 1 本がライティングパスの描画命令 1 本になる。
// 値は毎フレーム呼び出し側(EnvironmentScene / 描画テスト環境)が書き、どの天体を載せるかの
// 選定は game/celestial/planet-light.ts が行う。
import * as THREE from 'three/webgpu';
import { PI, clamp, dot, length, max, uniform } from 'three/tsl';
import type { Albedo } from '../../celestial-albedo';
import type { ColorUniform, FloatUniform, Vec3Node, Vec3Uniform } from '../../tsl-types';
import { ggxSpecularFactor } from './ggx';
import { contributionMaterial, type LightContribution, type LightSource } from './light-source';
import type { ShadingSample } from './shading-sample';
import { sphereIrradianceFactor } from './sphere-light';

// 同時に扱う天体光源の本数。3 体目が絵に効くほど明るい構図は、低いイオ周回軌道
// (イオ本体 + 木星)のような場合に限られる。
export const PLANET_LIGHT_SLOTS = 2;

// 光源モデルの選択値。graphics-settings.ts の planetLightModel の選択肢と対応する。
export const PLANET_LIGHT_MODEL = { none: 0, sphere: 1 } as const;

// スロット 1 本の値。中心・半径は描画座標、放射輝度は色つき(SUN_IRRADIANCE_1AU の目盛り)。
export type PlanetLightValue = {
  readonly center: THREE.Vector3;
  readonly radius: number;
  readonly radiance: Albedo;
};

// 一様球としての放射輝度(色つき)。albedo は輝度がボンドアルベドに一致する線形 RGB、
// sunIrradiance はその天体の場所の太陽放射照度。遠方でランバート球の全放射強度と一致する
// 取り方(L̄ = (2/3)·A·E_b/π)なので、距離とともに点光源へ連続に縮退する。
export function planetRadiance(albedo: Albedo, sunIrradiance: number): Albedo {
  const scale = (2 / 3) * sunIrradiance / Math.PI;
  return [albedo[0] * scale, albedo[1] * scale, albedo[2] * scale];
}

// ランバート球の位相関数 Φ(α)。α [rad] は天体から見た太陽と受け手のなす角で、Φ(0) = 1。
// 放射輝度へ掛けると、満ち欠けぶんの明るさの変調になる。
export function lambertPhase(alpha: number): number {
  return (Math.sin(alpha) + (Math.PI - alpha) * Math.cos(alpha)) / Math.PI;
}

type SlotUniforms = {
  readonly center: Vec3Uniform;
  readonly radius: FloatUniform;
  readonly radiance: ColorUniform;
};

// スロット 1 本ぶんの光源。拡散は一様球の閉じた解(sphere-light.ts)、鏡面は点光源近似の
// GGX で、太陽と違って遮蔽は受けない(天体照の遮蔽はこの計画の範囲外)。
class PlanetLightSlot implements LightSource {
  private cached: THREE.MeshBasicNodeMaterial | null = null;

  constructor(
    private readonly slot: SlotUniforms,
    private readonly host: PlanetLightSource,
  ) {}

  hasContribution(): boolean {
    return this.host.sphereModelEnabled && this.slot.radius.value > 0;
  }

  material(sample: ShadingSample): THREE.MeshBasicNodeMaterial {
    this.cached ??= contributionMaterial(sample, this.contribution(sample));
    return this.cached;
  }

  private contribution(sample: ShadingSample): LightContribution {
    const toCenter = sample.viewPositionOf(this.slot.center).sub(sample.position);
    const lightDir = toCenter.div(max(length(toCenter), 1));
    const cosBeta = dot(sample.normal, lightDir);
    const sinSigmaSqr = clamp(
      this.slot.radius.mul(this.slot.radius).div(dot(toCenter, toCenter)), 0, 1,
    );
    // 一様球の放射照度 E = π·L̄·sin²σ × クリップ係数(全可視では saturate(cosβ) に一致)。
    const irradiance: Vec3Node = this.slot.radiance.mul(PI).mul(sinSigmaSqr)
      .mul(sphereIrradianceFactor(cosBeta, sinSigmaSqr));
    return { diffuse: irradiance, specular: irradiance.mul(ggxSpecularFactor(sample, lightDir)) };
  }

  dispose(): void {
    this.cached?.dispose();
  }
}

export class PlanetLightSource {
  private readonly slots: readonly SlotUniforms[] = Array.from(
    { length: PLANET_LIGHT_SLOTS },
    () => ({ center: uniform(new THREE.Vector3()), radius: uniform(0), radiance: uniform(new THREE.Color(0, 0, 0)) }),
  );
  private readonly slotSources: readonly PlanetLightSlot[];

  constructor(private model: number) {
    this.slotSources = this.slots.map((slot) => new PlanetLightSlot(slot, this));
  }

  // 描画設定 planetLightModel の値をそのまま受ける。次のフレームから効く。
  setModel(model: number): void { this.model = model; }

  get sphereModelEnabled(): boolean { return this.model === PLANET_LIGHT_MODEL.sphere; }

  // ライティングパスへ渡す光源の列。スロット 1 本が描画命令 1 本になる。
  get lightSources(): readonly LightSource[] { return this.slotSources; }

  // このフレームの光源の列。PLANET_LIGHT_SLOTS を超えたぶんは捨て、足りないスロットは消灯する。
  set(lights: readonly PlanetLightValue[]): void {
    for (const [i, slot] of this.slots.entries()) {
      const light = lights[i];
      slot.radius.value = light === undefined ? 0 : light.radius;
      if (light === undefined) continue;
      slot.center.value.copy(light.center);
      slot.radiance.value.setRGB(light.radiance[0], light.radiance[1], light.radiance[2]);
    }
  }
}
