// 面の向きによらない一様な環境光。ゲームプレイのために物理から外す光源で、恒星の色にも明るさにも
// 依らない無彩色の定数を、恒星からの距離の逆二乗で減衰させ、太陽の影に遮られずに届ける
// (DEVELOP/SPEC/RENDERING.md「地球の描画」)。「夜側の観察」は同じ光を、決められた天体の球の内側
// へだけ強めて足す項。強さは setFraction()、観察の強さと観察球は setNightObservation() で毎フレーム受ける。
import * as THREE from 'three/webgpu';
import { PI, dot, smoothstep, uniform, vec3 } from 'three/tsl';
import type { FloatUniform, Vec3Node, Vec3Uniform } from '../../tsl-types';
import { REFERENCE_RADIANT_INTENSITY, type SunLight } from '../sun-light';
import type { GraphicsSettingsData } from '../../graphics-settings';
import { contributionMaterial, type LightContribution, type LightSource, type SpecularReach } from './light-source';
import type { ShadingSample } from './shading-sample';

// 1 天文単位で SUN_IRRADIANCE_1AU になる放射照度へ掛ける割合。
const AMBIENT_FRACTION = 0.03;
// 「夜側の観察」で観察球の内側へ足す割合。夜側の雲の配置が読める明るさで、昼側の
// 直射光の3割にも満たないので昼の絵には埋もれる。
const NIGHT_OBSERVATION_FRACTION = 0.3;
// 観察球の縁を滲ませる幅。球の半径へ掛ける比で、球をまたぐ物(大気・雲の殻・低空の艦)の
// 明るさが急に切り替わらないようにする。
const OBSERVATION_EDGE_RATIO = 1.05;

// 描画設定から、この場面で使う割合を選ぶ。切ってあれば 0。
export function ambientFraction(graphics: GraphicsSettingsData): number {
  return graphics.ambient ? AMBIENT_FRACTION : 0;
}

// 描画設定から、「夜側の観察」で足す割合を選ぶ。切ってあれば 0。
export function nightObservationFraction(graphics: GraphicsSettingsData): number {
  return graphics.nightObservation ? NIGHT_OBSERVATION_FRACTION : 0;
}

export class AmbientSource implements LightSource {
  public readonly specularReach: SpecularReach = 'far';
  private readonly fractionUniform: FloatUniform = uniform(0);
  // 「夜側の観察」の強化。球の内側へだけ掛ける割合と、その観察球(描画座標・[m])。
  private readonly observationUniform: FloatUniform = uniform(0);
  private readonly observationCenter: Vec3Uniform = uniform(new THREE.Vector3());
  private readonly observationRadius: FloatUniform = uniform(1);
  private materialValue: THREE.MeshBasicNodeMaterial | null = null;

  // sunLight からは減衰の中心となる位置を読む。
  public constructor(private readonly sunLight: SunLight) {}

  // 基準の放射照度へ掛ける割合。0 で消灯。
  public get fraction(): number { return this.fractionUniform.value; }
  public setFraction(fraction: number): void { this.fractionUniform.value = fraction; }

  // 「夜側の観察」の強化を置く。center・radius は観察球(描画座標・[m])、fraction は基準の
  // 放射照度へ掛ける割合。fraction 0 で消灯 — 半径は滲みの割合の分母なので 0 にはしない。
  public setNightObservation(center: THREE.Vector3, radius: number, fraction: number): void {
    this.observationCenter.value.copy(center);
    this.observationRadius.value = Math.max(radius, 1);
    this.observationUniform.value = fraction;
  }

  public hasContribution(): boolean {
    return this.fraction > 0 || this.observationUniform.value > 0;
  }

  // 環境光の寄与のマテリアル。強さはユニフォームで切り替える。
  public material(sample: ShadingSample): THREE.MeshBasicNodeMaterial {
    this.materialValue ??= contributionMaterial(sample, this.contribution(sample), this.specularReach);
    return this.materialValue;
  }

  // 受け手 sample へ届く環境光の放射照度。空が遮られないとしたときの値で、消灯していれば 0。「夜側の観察」は
  // 同じ光を観察球の内側へだけ足す項 — 位置は画素の面と同じ描画座標で測る。
  private irradiance(sample: ShadingSample): Vec3Node {
    const toSun = sample.viewPositionOf(this.sunLight.position).sub(sample.position);
    const inside = smoothstep(
      this.observationRadius, this.observationRadius.mul(OBSERVATION_EDGE_RATIO),
      sample.worldPosition.sub(this.observationCenter).length(),
    ).oneMinus();
    return vec3(REFERENCE_RADIANT_INTENSITY)
      .div(dot(toSun, toSun))
      .mul(this.fractionUniform.add(this.observationUniform.mul(inside)));
  }

  // 拡散は、その画素へ届く環境光の放射照度そのもの。鏡面は同じ光を放射輝度 E/π の一様な環境と
  // して映したもので、粗さによらず一定 — 拡散を持たない金属面が影の中で真っ黒に残らないための項。
  private contribution(sample: ShadingSample): LightContribution {
    const irradiance = this.irradiance(sample);
    return { diffuse: irradiance, specular: irradiance.div(PI) };
  }

  // 組んだマテリアルを解放する。
  public dispose(): void {
    this.materialValue?.dispose();
  }
}
