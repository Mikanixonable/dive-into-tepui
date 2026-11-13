// 建造モードの作業灯: カメラに追従する球光源で、注視中の船体を照らし、太陽の当たらない
// 側でもモジュールの形と継ぎ目が読めるようにする。影は掛けず、離れるほど逆二乗で弱まり、
// 遠くの天体の見え方を変えない。値は毎フレーム set() で受け、強さ 0 で消灯する
// (DEVELOP/SPEC/RENDERING.md「宇宙船の描画」建造の項)。
import * as THREE from 'three/webgpu';
import { PI, clamp, dot, length, max, uniform, vec3 } from 'three/tsl';
import { contributionMaterial, type LightContribution, type LightSource } from './light-source';
import { sphereIrradianceFactor, type SphereSpecular } from './sphere-light';
import type { FloatUniform, Vec3Node, Vec3Uniform } from '../../tsl-types';
import type { ShadingSample } from './shading-sample';

// 灯の放射強度(SUN_IRRADIANCE_1AU の目盛り)。建造時、灯から船体までの距離は注視距離の
// 約 3.5 倍(灯距 2.5 倍 + カメラ距 1 倍)になり、注視距離 12〜30 m では灯距 42〜105 m、
// その点の放射照度は約 0.54π〜0.08π — 1 天文単位の日光の 54%〜8%。影側が読める程度に
// 抑え、直射日光を圧倒しない値。
export const WORK_LIGHT_INTENSITY = 3000;

// 灯距と注視距離の比、および灯球の半径と灯距の比。灯距を注視距離に比例させるので、
// カメラが寄れば灯も近付き、離れれば退いて弱まる。半径は灯距の小さな割合で、柔らかい
// 近距離照明になる。
export const WORK_LIGHT_DISTANCE_RATIO = 2.5;
export const WORK_LIGHT_RADIUS_RATIO = 0.15;

// 灯のカメラ基準オフセット(右・上・後の重み)。「右上後方」はカメラの右肩越し —
// 視線の後ろへ置くので、照らされるのはカメラから見えている面である。
const WORK_LIGHT_OFFSET = new THREE.Vector3(0.55, 0.45, 1.0).normalize();

// カメラと注視距離から作業灯の置き方を引く。灯心(描画座標、新規確保)と灯球半径 [m]
// を返す。camera は行列が確定済みの THREE カメラ、focusDistance は視点から注視点への
// 距離 [m]。
export function workLightPlacement(
  camera: THREE.Camera, focusDistance: number,
): { readonly position: THREE.Vector3; readonly radius: number } {
  const e = camera.matrixWorld.elements;
  // カメラの基ベクトル: 右 = 列 0、上 = 列 1、後 = 列 2(視線は -Z 向き)。
  const dist = WORK_LIGHT_DISTANCE_RATIO * focusDistance;
  const position = new THREE.Vector3(e[12], e[13], e[14])
    .addScaledVector(new THREE.Vector3(e[0], e[1], e[2]), WORK_LIGHT_OFFSET.x * dist)
    .addScaledVector(new THREE.Vector3(e[4], e[5], e[6]), WORK_LIGHT_OFFSET.y * dist)
    .addScaledVector(new THREE.Vector3(e[8], e[9], e[10]), WORK_LIGHT_OFFSET.z * dist);
  return { position, radius: WORK_LIGHT_RADIUS_RATIO * dist };
}

export class WorkLightSource implements LightSource {
  private readonly center: Vec3Uniform = uniform(new THREE.Vector3());
  private readonly radius: FloatUniform = uniform(1);
  private readonly intensity: FloatUniform = uniform(0);
  private cached: THREE.MeshBasicNodeMaterial | null = null;

  // sphereSpecular は他の球光源と共有する係数表(パイプラインが 1 つを保有する)。
  public constructor(private readonly sphereSpecular: SphereSpecular) {}

  // 1 フレームぶんの灯の値。中心・半径は描画座標、強さ 0 で消灯(消灯時は位置・半径を
  // 読まない)。
  public set(center: THREE.Vector3, radius: number, intensity: number): void {
    this.center.value.copy(center);
    this.radius.value = radius;
    this.intensity.value = intensity;
  }

  // 強さだけの書き換え。消灯だけの呼び出しで位置・半径を要求しない。
  public setIntensity(intensity: number): void { this.intensity.value = intensity; }

  public hasContribution(): boolean { return this.intensity.value > 0; }

  // 作業灯の寄与を描くマテリアル。値はすべてユニフォームなので初回だけ組めば足りる。
  public material(sample: ShadingSample): THREE.MeshBasicNodeMaterial {
    this.cached ??= contributionMaterial(sample, this.contribution(sample));
    return this.cached;
  }

  // 一様な球光源の寄与(sphere-light.ts と同じモデル、影は掛けない)。拡散は放射照度
  // I/d² に球光源のクリップ係数を、鏡面は放射輝度 I/(πR²) に LTC の係数を掛ける。
  private contribution(sample: ShadingSample): LightContribution {
    const center = sample.viewPositionOf(this.center);
    const toCenter = center.sub(sample.position);
    const distSqr = dot(toCenter, toCenter);
    const dist = max(length(toCenter), 1);
    const cosBeta = dot(sample.normal, toCenter.div(dist));
    const sinSigmaSqr = clamp(
      this.radius.mul(this.radius).div(distSqr), 0, 1);
    const diffuse: Vec3Node = vec3(this.intensity).div(distSqr)
      .mul(sphereIrradianceFactor(cosBeta, sinSigmaSqr));
    const radiance: Vec3Node = vec3(this.intensity)
      .div(this.radius.mul(this.radius).mul(PI));
    const specular: Vec3Node = radiance
      .mul(this.sphereSpecular.factor(sample, center, this.radius));
    return { diffuse, specular };
  }

  // 組んだマテリアルを解放する。
  public dispose(): void {
    this.cached?.dispose();
  }
}
