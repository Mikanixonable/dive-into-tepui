// 天体照の写しが撮る天体の簡易な見え方。天体を中心と半径で置いた地表の球として持ち、視線 1 本が
// 受け取る放射輝度を返す。写すのは地表・不透明な積雲(視差を省いてアルベドへ焼き込む)・視線が地表まで
// 通る大気(巻雲と半透明の積雲の殻を含む)。
import * as THREE from 'three/webgpu';
import {
  If, and, dot, float, int, length, log2, max, mix, normalize, sqrt, texture, uniform, vec2, vec3, vec4,
} from 'three/tsl';
import { cutoffRadius } from '../../atmosphere';
import { CloudFieldSampler } from '../../cloud/cloud-field-sampler';
import { CloudShapeEvaluator } from '../../cloud/cloud-shape-evaluator';
import { CLOUD_ALBEDO } from '../../cloud/cumulus-shape';
import { equirectUvFromDirection } from '../../field-projection';
import { AtmosphereIntegrator } from '../atmosphere-integrator';
import type { AtmosphereBody } from '../../atmosphere';
import type { Albedo } from '../../celestial-albedo';
import type { LightSourceMap } from '../../celestial/celestial-surface';
import type {
  BoolUniform, ColorUniform, FloatNode, FloatUniform, Mat4Uniform, Vec3Node, Vec3Uniform,
} from '../../tsl-types';
import type { CloudSpecies } from '../cloud-atmosphere-renderer';
import type { BodyShadow } from '../shadow/body-shadow';
import type { SunLight } from '../sun-light';

// 天体 1 体ぶんの見た目。すべて描画座標系の値。
//
// **starDirection と bodyFromWorld は使い回しの実体**で、渡し手がフレームごとに書き換える。
// 受け取った側は掴んだまま持ち越さず、その場で写し取る。
export interface PlanetLightAppearance {
  // 地表の色を引く全球のテクスチャ。持たない天体と、画像がまだ届いていない天体は null。
  readonly map: LightSourceMap | null;
  // map を持たない天体の一様な拡散アルベド(線形 RGB)。
  readonly albedo: Albedo;
  // その天体の場所の太陽放射照度に、天体の食を掛けたもの。
  readonly sunIrradiance: number;
  // 天体中心から恒星への単位方向。
  readonly starDirection: THREE.Vector3;
  // 描画座標のベクトルを天体固定の向きへ回す行列。
  readonly bodyFromWorld: THREE.Matrix4;
  // 大気と、その中に立つ雲(雲を描かない設定では clouds が null)。大気を持たない天体では null。
  readonly atmosphere: AtmosphereBody | null;
}

// 大気を積むサンプル点の数。積分器は刻みを写しの texel ごとに blue noise でずらすので、粗さの小さい
// 鏡面の映り込みに粒が見えたら上げる(段の上では均されて消える)。
const ATMOSPHERE_STEPS = 4;

// テクスチャを持たない天体のベース色を、式を分岐させずに一様色へ落とすための 1 texel。
// **色空間は実写テクスチャと同じ sRGB で置く** — 色空間の変換は写しを組むときに焼き付くので、
// 変換の違うテクスチャへ差し替えると、そのぶんだけ黙って色がずれる。
function createWhiteTexture(): THREE.DataTexture {
  const white = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  white.colorSpace = THREE.SRGBColorSpace;
  white.needsUpdate = true;
  return white;
}

export class PlanetLightSubject {
  // 天体の地表の球。中心は描画座標、半径は [m]。
  private readonly center: Vec3Uniform = uniform(new THREE.Vector3());
  private readonly radius: FloatUniform = uniform(0);
  // 地表のベース色と、それへ掛ける係数。テクスチャを持つ天体では albedoScale の灰色、
  // 持たない天体では一様アルベドそのものが係数になる。
  private readonly baseColor: THREE.TextureNode;
  // ベース色の画像が flipY なら 1、でなければ 0。map は借り物で行の並びを変えられないので、読む側が
  // その flipY に従う — flipY の画像は GPU 上で行が上下逆に並び、v = 0 が南極になる。
  private readonly baseColorFlipY: FloatUniform = uniform(0);
  private readonly albedoFactor: ColorUniform = uniform(new THREE.Color(1, 1, 1));
  private readonly white = createWhiteTexture();
  private readonly sunIrradiance: FloatUniform = uniform(0);
  private readonly starDirection: Vec3Uniform = uniform(new THREE.Vector3());
  private readonly bodyFromWorld: Mat4Uniform = uniform(new THREE.Matrix4());
  // 不透明な積雲を引く雲の場と、被覆率から雲頂の見える割合を出す積雲の殻と共通の規則。
  private readonly cloudField = new CloudFieldSampler();
  private readonly cloudShape = new CloudShapeEvaluator(0);
  private readonly integrator: AtmosphereIntegrator;
  // このフレームの天体が大気・雲を持つか。
  private readonly atmospherePresent: BoolUniform = uniform(false);
  private readonly cloudsPresent: BoolUniform = uniform(false);
  // 描画設定が大気・積雲を写すとしているか。
  private readonly atmosphereEnabled: BoolUniform = uniform(true);
  private readonly cumulusEnabled: BoolUniform = uniform(true);

  // sunLight と bodyShadow は、大気の中の点へ届く太陽光を引くのに使う。
  public constructor(sunLight: SunLight, bodyShadow: BodyShadow) {
    this.baseColor = texture(this.white);
    this.integrator = new AtmosphereIntegrator(sunLight, bodyShadow);
  }

  // このフレームの天体を置く。center は描画座標、radius は地表の球の半径 [m]。
  public set(center: THREE.Vector3, radius: number, appearance: PlanetLightAppearance): void {
    // 渡された見た目は使い回しの実体なので、uniform へ写し取る。
    this.center.value.copy(center);
    this.radius.value = radius;
    this.sunIrradiance.value = appearance.sunIrradiance;
    this.starDirection.value.copy(appearance.starDirection);
    this.bodyFromWorld.value.copy(appearance.bodyFromWorld);
    const map = appearance.map;
    const baseColor = map?.texture ?? this.white;
    this.baseColor.value = baseColor;
    this.baseColorFlipY.value = baseColor.flipY ? 1 : 0;
    if (map === null) {
      const [r, g, b] = appearance.albedo;
      this.albedoFactor.value.setRGB(r, g, b, THREE.LinearSRGBColorSpace);
    } else {
      this.albedoFactor.value.setRGB(map.albedoScale, map.albedoScale, map.albedoScale, THREE.LinearSRGBColorSpace);
    }
    // 大気と、その中に立つ雲。
    const atmosphere = appearance.atmosphere;
    const clouds = atmosphere?.clouds ?? null;
    this.atmospherePresent.value = atmosphere !== null;
    this.cloudsPresent.value = clouds !== null;
    if (clouds !== null) this.cloudField.bind(clouds.cloud.field);
    if (atmosphere === null) return;
    this.integrator.write(
      atmosphere, ATMOSPHERE_STEPS, cutoffRadius(atmosphere.optics, atmosphere.surfaceRadius));
  }

  // 大気を積分するか(描画設定「大気」がオフでない)。
  public setAtmosphereEnabled(enabled: boolean): void { this.atmosphereEnabled.value = enabled; }

  // 不透明な積雲を焼き込むか(描画設定「積雲の精細さ」がオフでない)。
  public setCumulusEnabled(enabled: boolean): void { this.cumulusEnabled.value = enabled; }

  // 種類ごとに、大気の中の雲の殻を描くかを置き直す。
  public setCloudShellEnabled(species: CloudSpecies, enabled: boolean): void {
    this.integrator.setCloudShellEnabled(species, enabled);
  }

  // origin から向き direction(どちらも描画座標)の視線が受け取る放射輝度。texelAngle は写しの
  // 1 texel が張る角 [rad] で、地表の画像を読む段を決める。**Fn の中から呼ぶこと。**
  public radianceAlong(origin: Vec3Node, direction: Vec3Node, texelAngle: FloatNode): Vec3Node {
    const hit = this.surfaceHit(origin, direction);
    const normal = normalize(hit.sub(this.center));
    const bodyNormal: Vec3Node = this.bodyFromWorld.mul(vec4(normal, 0)).xyz;
    // 不透明な積雲は、地表のアルベドの上へ雲頂の見える割合ぶん重ねる。粒 0 で読んだ割合が、殻の
    // ディザを均した割合になる。
    const albedo = this.groundAlbedo(bodyNormal, origin, texelAngle).toVar();
    If(and(this.cumulusEnabled, this.cloudsPresent), () => {
      const opaque = this.cloudShape.opaqueFraction(this.cloudField.sampleCloud(bodyNormal).coverage, float(0));
      albedo.assign(mix(albedo, vec3(CLOUD_ALBEDO), opaque));
    });
    // ランバート面の放射輝度。昼側だけが光る。
    const radiance = albedo.mul(this.sunIrradiance).mul(max(dot(normal, this.starDirection), 0)).div(Math.PI)
      .toVar();
    // 視線が地表まで通る大気の透過率と内部散乱。
    If(and(this.atmosphereEnabled, this.atmospherePresent), () => {
      const layer = this.integrator.contribution(origin, normalize(direction), length(hit.sub(origin)));
      radiance.assign(radiance.mul(layer.transmittance).add(layer.inscatter));
    });
    return radiance;
  }

  // origin から向き direction のレイが天体の地表の球と交わる、手前側の点。当たらない向きでは
  // レイ上で球に最も近い点を返す。
  //
  // **向きは正規化し、軸から外れた量はベクトルの差で測る。** GPU の cos() には仕様上 2⁻¹¹ までの
  // 絶対誤差が許されていて、円錐の向きはその誤差ぶん長さがずれる。外れを |toCenter|² − along² の
  // 差で測ると、そのずれが (距離/半径)² 倍されて交点ごと壊れる。
  public surfaceHit(origin: Vec3Node, direction: Vec3Node): Vec3Node {
    const ray = normalize(direction);
    const toCenter = this.center.sub(origin);
    const along = dot(toCenter, ray);
    const offAxis = toCenter.sub(ray.mul(along));
    // 判別式は円錐の縁で 0 になるので、数値で負へ落ちたぶんは止める。
    const half = sqrt(max(this.radius.mul(this.radius).sub(dot(offAxis, offAxis)), 0));
    return origin.add(ray.mul(along.sub(half)));
  }

  // 天体固定の向き bodyNormal の地表の拡散アルベド(線形 RGB)。origin は写しの基準点。
  private groundAlbedo(bodyNormal: Vec3Node, origin: Vec3Node, texelAngle: FloatNode): Vec3Node {
    // **ベース色を読む段は、写し 1 枚につき 1 つに決める** — 画面微分に任せると、経度の巻き目
    // (u が 1 から 0 へ跳ぶ列)で最も粗い段が選ばれ、日付変更線に 1 本の線が出る。段は、写しの
    // 1 texel が正対する地表へ張る角と、画像の 1 texel が張る角 π/高さ の比。
    const distance = length(this.center.sub(origin));
    const surfaceAngle = texelAngle.mul(distance.sub(this.radius)).div(this.radius);
    const imageHeight = float((this.baseColor.size(int(0)) as THREE.Node<'uvec2'>).y);
    const level = max(log2(surfaceAngle.mul(imageHeight).div(Math.PI)), 0);
    const uv = equirectUvFromDirection(bodyNormal);
    const imageUv = vec2(uv.x, mix(uv.y, uv.y.oneMinus(), this.baseColorFlipY));
    return this.baseColor.sample(imageUv).level(level).rgb.mul(this.albedoFactor);
  }

  // 保持している GPU 資源を解放する。
  public dispose(): void {
    this.integrator.dispose();
    this.white.dispose();
  }
}
