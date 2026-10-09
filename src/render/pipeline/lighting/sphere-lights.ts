// 影を持たない一様な球光源の並び。自己発光の物体と同じ場所・大きさ・放射輝度に置くと、近くの物体の映り込みの像と
// 比べる対照になる。寄与は恒星の球光源モデルと同じ閉じた解(拡散は Snyder の解析解、
// 鏡面は LTC)で、影パスの透過率を掛けず、近くの物体の像との置換でも弱めない。光源 1 つが LightSource 1 つで、
// 置いていない枠は描画命令を出さない。
import * as THREE from 'three/webgpu';
import { PI, clamp, dot, length, max, uniform } from 'three/tsl';
import { sphereIrradianceFactor, type SphereSpecular } from './sphere-light';
import { contributionMaterial, type LightContribution, type LightSource } from './light-source';
import type { ColorUniform, FloatUniform, Vec3Uniform } from '../../tsl-types';
import type { ShadingSample } from './shading-sample';

// 置ける球光源の数。
export const SPHERE_LIGHT_CAPACITY = 16;

// 置く球光源 1 つ。中心は描画座標 [m]、半径 [m]、放射輝度は線形 RGB(恒星の放射照度の目盛りで、自己発光の
// emissive × emissiveIntensity と同じ値を渡すと同じ明るさの球になる)。
export interface SphereLightValue {
  readonly center: THREE.Vector3;
  readonly radius: number;
  readonly radiance: THREE.Color;
}

// 球光源の枠 1 つ。放射輝度が黒の間は寄与が無い。
class SphereLightSource implements LightSource {
  private readonly centerUniform: Vec3Uniform = uniform(new THREE.Vector3());
  private readonly radiusUniform: FloatUniform = uniform(1);
  private readonly radianceUniform: ColorUniform = uniform(new THREE.Color(0, 0, 0));
  private materialValue: THREE.MeshBasicNodeMaterial | null = null;

  public constructor(private readonly sphereSpecular: SphereSpecular) {}

  // この枠の光源を value にする。null で消す。
  public set(value: SphereLightValue | null): void {
    if (value === null) {
      this.radianceUniform.value.setRGB(0, 0, 0);
      return;
    }
    this.centerUniform.value.copy(value.center);
    this.radiusUniform.value = value.radius;
    this.radianceUniform.value.copy(value.radiance);
  }

  // 光源を置いているか。
  public hasContribution(): boolean {
    const { r, g, b } = this.radianceUniform.value;
    return r > 0 || g > 0 || b > 0;
  }

  // 寄与のマテリアル。位置と明るさはユニフォームで切り替える。
  public material(sample: ShadingSample): THREE.MeshBasicNodeMaterial {
    this.materialValue ??= contributionMaterial(sample, this.contribution(sample));
    return this.materialValue;
  }

  // 組んだマテリアルを解放する。
  public dispose(): void {
    this.materialValue?.dispose();
  }

  // 一様な放射輝度 L・半径 R の球が届ける照度。拡散の放射照度は、正対したときの π L R² / d² に地平線で
  // 切られる割合を掛けたもの。
  private contribution(sample: ShadingSample): LightContribution {
    // 中心は view 空間で、面からの向きと距離・視半径を引く。
    const center = sample.viewPositionOf(this.centerUniform);
    const toLight = center.sub(sample.position);
    const distSqr = dot(toLight, toLight);
    const radius = this.radiusUniform;
    const cosBeta = dot(sample.normal, toLight.div(max(length(toLight), 1e-6)));
    const sinSigmaSqr = clamp(radius.mul(radius).div(distSqr), 0, 1);
    const diffuse = this.radianceUniform.mul(PI).mul(radius).mul(radius).div(distSqr)
      .mul(sphereIrradianceFactor(cosBeta, sinSigmaSqr));
    const specular = this.radianceUniform.mul(this.sphereSpecular.factor(sample, center, radius));
    return { diffuse, specular };
  }
}

export class SphereLights {
  private readonly slots: readonly SphereLightSource[];

  // sphereSpecular は鏡面の係数表で、生成した側が解放する。
  public constructor(sphereSpecular: SphereSpecular) {
    this.slots = Array.from({ length: SPHERE_LIGHT_CAPACITY }, () => new SphereLightSource(sphereSpecular));
  }

  // ライトプリパスへ渡す光源の列。
  public get sources(): readonly LightSource[] { return this.slots; }

  // 置く球光源を values にする。SPHERE_LIGHT_CAPACITY を超えたら投げる。
  public set(values: readonly SphereLightValue[]): void {
    if (values.length > SPHERE_LIGHT_CAPACITY) {
      throw new Error(`too many sphere lights: ${values.length} > ${SPHERE_LIGHT_CAPACITY}`);
    }
    for (const [index, slot] of this.slots.entries()) slot.set(values[index] ?? null);
  }
}
