// 天体照の光源スロット。恒星以外の天体が反射して届ける光を、一様な放射輝度の球光源として
// スロット本数ぶん持つ。値は毎フレーム呼び出し側(EnvironmentScene / 描画テスト環境)が書き、
// どの天体を載せるかの選定は game/celestial/planet-light.ts が行う。
import * as THREE from 'three/webgpu';
import { PI, clamp, dot, uniform, vec3 } from 'three/tsl';
import type { Albedo } from '../../celestial-albedo';
import type { ColorUniform, FloatUniform, Vec3Node, Vec3Uniform } from '../../tsl-types';
import type { ShadingSample } from './shading-sample';

// 同時に扱う天体光源の本数。表示に効く閾値(planet-light.ts)を上回る天体が 3 体以上並ぶ
// 構図は、低いイオ周回軌道(イオ本体 + 木星)のような場合に限られる。
export const PLANET_LIGHT_SLOTS = 2;

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

type SlotUniforms = {
  readonly center: Vec3Uniform;
  readonly radius: FloatUniform;
  readonly radiance: ColorUniform;
};

export class PlanetLightSource {
  private readonly slots: readonly SlotUniforms[] = Array.from(
    { length: PLANET_LIGHT_SLOTS },
    () => ({ center: uniform(new THREE.Vector3()), radius: uniform(0), radiance: uniform(new THREE.Color(0, 0, 0)) }),
  );

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

  // シェーディング点が全スロットから受け取る、方向を持たない近似の放射照度。一様球の
  // 全可視の放射照度 π·L̄·sin²θ から向きの因子を落としたもので、距離の減衰だけが画素ごとに掛かる。
  ambientIrradiance(sample: ShadingSample): Vec3Node {
    let sum: Vec3Node = vec3(0);
    for (const slot of this.slots) {
      const toCenter = sample.viewPositionOf(slot.center).sub(sample.position);
      const sinSqr = clamp(slot.radius.mul(slot.radius).div(dot(toCenter, toCenter)), 0, 1);
      sum = sum.add(slot.radiance.mul(PI).mul(sinSqr));
    }
    return sum;
  }
}
