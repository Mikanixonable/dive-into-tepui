// 天体照の光源。恒星以外の天体が反射して届ける光を、一様な放射輝度の球光源として
// スロット本数ぶん持ち、スロット 1 本がライティングパスの描画命令 1 本になる。
// どの天体を載せるかは決めず、毎フレーム set() で渡された値をそのまま照らす。
import * as THREE from 'three/webgpu';
import { Fn, PI, acos, clamp, cos, dot, float, length, max, normalize, sin, sqrt, uniform } from 'three/tsl';
import { LAMBERT_SPHERE_GEOMETRIC_ALBEDO_RATIO } from '../../../physics/lambert-sphere';
import type { Albedo } from '../../celestial-albedo';
import type { ColorUniform, FloatNode, FloatUniform, Vec3Node, Vec3Uniform } from '../../tsl-types';
import type { SunLight } from '../sun-light';
import { contributionMaterial, type LightContribution, type LightSource } from './light-source';
import type { ShadingSample } from './shading-sample';
import { sphereIrradianceFactor, type SphereSpecular } from './sphere-light';

// 用意するスロットの本数。同時に使う本数は描画設定 planetLightCount(0〜この値)で決まる。
// 3 体目が絵に効くほど明るい構図は、低いイオ周回軌道(イオ本体 + 木星)のような場合に
// 限られる。
export const MAX_PLANET_LIGHT_SLOTS = 2;

// 受け手から見えている地表のキャップの半角へ張る床 [rad]。球に接する受け手ではキャップが
// 1 点へ潰れるので、床が無いと半角 0 の割り算が NaN を出す。床が効く幅は位相角にして 2 倍の
// この値 — 地球の中心角で 1.3 km と、どの構図でも 1 画素を切る。
const MIN_VISIBLE_CAP_ANGLE = 1e-4;

// スロット 1 本の値。中心・半径は描画座標、放射輝度は色つき(SUN_IRRADIANCE_1AU の目盛り)。
type PlanetLightValue = {
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

// 半角 capAngle のキャップのうち、日が当たっている面積の割合 0..1。alpha はキャップの中心が
// 太陽直下点から離れた角で、昼夜境界は中心から π/2 − alpha の位置を通る。
//
// **球面のキャップを平面の円板と見なした近似。** 球面での厳密な面積は初等関数で書けないが、
// キャップが広いほど誤差が乗るこの近似は、下の receiverPhase が遠方極限との比で使うので
// 分子と分母で打ち消し合う。
const sunlitCapFraction = Fn(([alpha, capAngle]: readonly FloatNode[]) => {
  const u = clamp(PI.mul(0.5).sub(alpha!).div(capAngle!), -1, 1);
  return acos(u.negate()).add(u.mul(sqrt(max(float(1).sub(u.mul(u)), 0)))).div(PI);
});

// 受け手ごとの満ち欠けの係数 0..1。遠方の円板として見たときのランバート位相
// (physics/lambert-sphere.ts の lambertPhase と同じ式)を、その受け手から見えている地表の
// 日照割合で頭打ちにする。キャップが半球まで広がる遠方と、昼側(alpha ≤ π/2)では位相そのもの。
const receiverPhase = Fn(([alpha, capAngle]: readonly FloatNode[]) => {
  const phase = sin(alpha!).add(PI.sub(alpha!).mul(cos(alpha!))).div(PI);
  const visible = sunlitCapFraction(alpha!, capAngle!);
  const whole = sunlitCapFraction(alpha!, float(Math.PI / 2));
  // visible / max(visible, whole) は min(1, visible/whole) と同値で、どちらも 0 の
  // 新相でも 0 を返す。
  return phase.mul(visible.div(max(max(visible, whole), 1e-6)));
});

// スロット 1 本ぶんの光源。拡散も鏡面も、視半径を持つ一様球として解く(sphere-light.ts)。
// TODO: 遮蔽を受けない — 受け手と天体の間に別の天体や艦の構造があっても届く。
class PlanetLightSlot implements LightSource {
  private cached: THREE.MeshBasicNodeMaterial | null = null;

  // sunLight からは、満ち欠けを測る恒星の位置を読む。
  constructor(
    private readonly sunLight: SunLight,
    private readonly sphereSpecular: SphereSpecular,
    private readonly slot: SlotUniforms,
  ) {}

  hasContribution(): boolean { return this.slot.radius.value > 0; }

  material(sample: ShadingSample): THREE.MeshBasicNodeMaterial {
    this.cached ??= contributionMaterial(sample, this.contribution(sample));
    return this.cached;
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
    // 位相角 = 天体中心から見た恒星と受け手のなす角。sin σ = R/d の余角が、受け手から見えて
    // いる地表のキャップの半角になる。
    const toStar = normalize(sample.viewPositionOf(this.sunLight.position).sub(center));
    const alpha = acos(clamp(dot(lightDir.negate(), toStar), -1, 1));
    const capAngle = max(acos(clamp(sqrt(sinSigmaSqr), 0, 1)), MIN_VISIBLE_CAP_ANGLE);
    // 満ち欠けは「見えている面のうちどれだけが光っているか」なので、球の放射輝度を下げる形で
    // 効かせる — 拡散と鏡面のどちらにも同じだけ掛かる。
    const radiance: Vec3Node = this.slot.radiance.mul(receiverPhase(alpha, capAngle));
    // 一様球の放射照度 E = π·L̄·sin²σ × クリップ係数(全可視では saturate(cosβ) に一致)。
    const diffuse: Vec3Node = radiance.mul(PI).mul(sinSigmaSqr)
      .mul(sphereIrradianceFactor(cosBeta, sinSigmaSqr));
    const specular: Vec3Node = radiance
      .mul(this.sphereSpecular.factor(sample, center, this.slot.radius));
    return { diffuse, specular };
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
  private readonly slotSources: readonly PlanetLightSlot[];

  // sunLight は満ち欠けを測る恒星、count は同時に使うスロットの本数(描画設定
  // planetLightCount の値をそのまま受ける)。
  constructor(sunLight: SunLight, sphereSpecular: SphereSpecular, private count: number) {
    this.slotSources = this.slots.map(
      (slot) => new PlanetLightSlot(sunLight, sphereSpecular, slot));
  }

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
