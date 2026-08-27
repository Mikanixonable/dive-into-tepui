// 天体照の光源。恒星以外の天体が反射して届ける光を、一様な放射輝度の球光源として
// スロット本数ぶん持ち、スロット 1 本がライティングパスの描画命令 1 本になる。
// 値は毎フレーム呼び出し側(EnvironmentScene / 描画テスト環境)が書き、どの天体を載せるかの
// 選定は game/celestial/planet-light.ts が行う。
import * as THREE from 'three/webgpu';
import { PI, clamp, dot, length, max, uniform } from 'three/tsl';
import { LAMBERT_SPHERE_GEOMETRIC_ALBEDO_RATIO } from '../../../physics/lambert-sphere';
import type { Albedo } from '../../celestial-albedo';
import type { ColorUniform, FloatUniform, Vec3Node, Vec3Uniform } from '../../tsl-types';
import { ggxSpecularFactor } from './ggx';
import { contributionMaterial, type LightContribution, type LightSource } from './light-source';
import type { ShadingSample } from './shading-sample';
import { sphereIrradianceFactor } from './sphere-light';

// 用意するスロットの本数。同時に使う本数は描画設定 planetLightCount(0〜この値)で決まる。
// 3 体目が絵に効くほど明るい構図は、低いイオ周回軌道(イオ本体 + 木星)のような場合に
// 限られる。
export const MAX_PLANET_LIGHT_SLOTS = 2;

// スロット 1 本の値。中心・半径は描画座標、放射輝度は色つき(SUN_IRRADIANCE_1AU の目盛り)。
export type PlanetLightValue = {
  readonly center: THREE.Vector3;
  readonly radius: number;
  readonly radiance: Albedo;
};

// 一様球としての放射輝度(色つき)。albedo は輝度がボンドアルベドに一致する線形 RGB、
// sunIrradiance はその天体の場所の太陽放射照度。満相のランバート球の全放射強度と一致する
// 取り方(L̄ = (2/3)·A·E_b/π)なので、距離とともに点光源へ連続に縮退する。満ち欠けは
// physics/lambert-sphere.ts の位相関数を別途掛ける。
export function planetRadiance(albedo: Albedo, sunIrradiance: number): Albedo {
  const scale = LAMBERT_SPHERE_GEOMETRIC_ALBEDO_RATIO * sunIrradiance / Math.PI;
  return [albedo[0] * scale, albedo[1] * scale, albedo[2] * scale];
}

type SlotUniforms = {
  readonly center: Vec3Uniform;
  readonly radius: FloatUniform;
  readonly radiance: ColorUniform;
};

// スロット 1 本ぶんの光源。拡散は一様球の閉じた解(sphere-light.ts)、鏡面は点光源近似の GGX。
// TODO: 遮蔽を受けない — 受け手と天体の間に別の天体や艦の構造があっても届く。
class PlanetLightSlot implements LightSource {
  private cached: THREE.MeshBasicNodeMaterial | null = null;

  constructor(private readonly slot: SlotUniforms) {}

  hasContribution(): boolean { return this.slot.radius.value > 0; }

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
    { length: MAX_PLANET_LIGHT_SLOTS },
    () => ({ center: uniform(new THREE.Vector3()), radius: uniform(0), radiance: uniform(new THREE.Color(0, 0, 0)) }),
  );
  private readonly slotSources = this.slots.map((slot) => new PlanetLightSlot(slot));

  // count は同時に使うスロットの本数。描画設定 planetLightCount の値をそのまま受ける。
  constructor(private count: number) {}

  // 同時に使うスロットの本数を差し替える。次の set() から効く。
  setCount(count: number): void { this.count = count; }

  // ライティングパスへ渡す光源の列。スロット 1 本が描画命令 1 本になる。
  get lightSources(): readonly LightSource[] { return this.slotSources; }

  // このフレームの光源の列。本数を超えたぶんは捨て、足りないスロットは消灯する。
  set(lights: readonly PlanetLightValue[]): void {
    const used = lights.slice(0, this.count);
    for (const [i, slot] of this.slots.entries()) {
      const light = used[i];
      slot.radius.value = light === undefined ? 0 : light.radius;
      if (light === undefined) continue;
      slot.center.value.copy(light.center);
      slot.radiance.value.setRGB(light.radiance[0], light.radiance[1], light.radiance[2]);
    }
  }
}
