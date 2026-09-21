// 天体 1 体の見た目を、基準点から見た方向の円板へ 1 枚に焼き、方向で読み直す写し。距離を持たない
// 「方向の球面」の、天体が張る円錐ぶんの図法なので、地表の模様はその天体が空を占める広さのまま残る。
// 焼く値は地表の放射輝度で、円板の被覆率を α に持つ。
import * as THREE from 'three/webgpu';
import {
  clamp, dot, float, int, length, log2, max, mix, normalize, screenUV, sqrt, texture, uniform, vec2, vec4,
} from 'three/tsl';
import { BakedField } from '../../baked-field';
import { EquidistantCap, equirectUvFromDirection } from '../../field-projection';
import { GPU_PASS } from '../../gpu-timings';
import type { WebGPURenderer } from 'three/webgpu';
import type { Albedo } from '../../celestial-albedo';
import type { GpuTimingSink } from '../../gpu-timings';
import type {
  ColorUniform, FloatNode, FloatUniform, Mat4Uniform, Vec2Node, Vec3Node, Vec3Uniform, Vec4Node,
} from '../../tsl-types';

// 天体 1 体ぶんの見た目。すべて描画座標系の値。
//
// **starDirection と bodyFromWorld は使い回しの実体**で、渡し手がフレームごとに書き換える。
// 受け取った側は掴んだまま持ち越さず、その場で写し取る。
export interface PlanetLightAppearance {
  // 全球の正距円筒テクスチャ。持たない天体と、画像がまだ届いていない天体は null。
  readonly map: THREE.Texture | null;
  // map の色へ掛けて、平均をボンドアルベドへ合わせる倍率。
  readonly albedoScale: number;
  // map を持たない天体の一様な拡散アルベド(線形 RGB)。
  readonly albedo: Albedo;
  // その天体の場所の太陽放射照度に、天体の食を掛けたもの。
  readonly sunIrradiance: number;
  // 天体中心から恒星への単位方向。
  readonly starDirection: THREE.Vector3;
  // 描画座標のベクトルを天体固定の向きへ回す行列。
  readonly bodyFromWorld: THREE.Matrix4;
}

// 写しの 1 辺 [texel]。円板の直径をこれで割るので、1 texel が張る角は 2σ / この値になる。
const PLANET_LIGHT_IMAGE_SIZE = 256;

// 選べる段の上限。1×1 まで畳んだ段が円板全体の平均になる。
const MAX_IMAGE_LEVEL = Math.log2(PLANET_LIGHT_IMAGE_SIZE);

// 焼く円錐の角半径 σ の床 [rad]。σ が 0 へ潰れると 1 texel の張る角も 0 になり、段の選択が発散する。
const MIN_CONE_ANGLE = 1e-4;

// 基準点が天体の中心から離れていなければならない、半径に対する比。これを下回る置き方では
// 円錐の軸が決まらない。
const MIN_REFERENCE_DISTANCE_RATIO = 1.001;

// 割り戻しに使う被覆率の下限。円板の外は 0 なので、そのまま割ると 0/0 になる。
const MIN_COVERAGE = 1e-4;

// テクスチャを持たない天体のベース色を、式を分岐させずに一様色へ落とすための 1 texel。
// **色空間は実写テクスチャと同じ sRGB で置く** — 色空間の変換は写しを組むときに焼き付くので、
// 変換の違うテクスチャへ差し替えると、そのぶんだけ黙って色がずれる。
function createWhiteTexture(): THREE.DataTexture {
  const white = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  white.colorSpace = THREE.SRGBColorSpace;
  white.needsUpdate = true;
  return white;
}

export class PlanetLightImage {
  // 写しの基準点と、天体の中心・半径。焼く式も読む式も、この 3 つで球との交点を解く。
  private readonly reference: Vec3Uniform = uniform(new THREE.Vector3());
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
  private readonly projection = new EquidistantCap(PLANET_LIGHT_IMAGE_SIZE, MIN_CONE_ANGLE);
  private readonly field: BakedField;
  // 円錐の軸を置けた置き方か。置けないフレームは焼かない。
  private aimed = false;
  // 中心方向の書き込み先。フレームごとに確保しない使い回し領域。
  private readonly axis = new THREE.Vector3();

  // 写しの資源を確保する。焼く中身は毎フレーム set() で置く。
  public constructor() {
    this.baseColor = texture(this.white);
    this.field = new BakedField(
      'planetLight', THREE.RGBAFormat, this.projection,
      (direction) => this.bakedRadiance(direction),
      GPU_PASS.lighting, true,
    );
  }

  // このフレームに焼く内容を置く。reference / center は描画座標、radius は [m]。
  public set(
    reference: THREE.Vector3, center: THREE.Vector3, radius: number, appearance: PlanetLightAppearance,
  ): void {
    // 渡された見た目は使い回しの実体なので、uniform へ写し取る。
    this.reference.value.copy(reference);
    this.center.value.copy(center);
    this.radius.value = radius;
    this.sunIrradiance.value = appearance.sunIrradiance;
    this.starDirection.value.copy(appearance.starDirection);
    this.bodyFromWorld.value.copy(appearance.bodyFromWorld);
    const baseColor = appearance.map ?? this.white;
    this.baseColor.value = baseColor;
    this.baseColorFlipY.value = baseColor.flipY ? 1 : 0;
    if (appearance.map === null) {
      const [r, g, b] = appearance.albedo;
      this.albedoFactor.value.setRGB(r, g, b, THREE.LinearSRGBColorSpace);
    } else {
      const scale = appearance.albedoScale;
      this.albedoFactor.value.setRGB(scale, scale, scale, THREE.LinearSRGBColorSpace);
    }
    // 基準点が天体の表面に触れていると中心方向が決まらないので、その置き方は焼かずに見送る。
    const distance = center.distanceTo(reference);
    this.aimed = distance > radius * MIN_REFERENCE_DISTANCE_RATIO;
    if (!this.aimed) return;
    this.axis.subVectors(center, reference).divideScalar(distance);
    this.projection.aimAt(this.axis, Math.max(Math.asin(radius / distance), MIN_CONE_ANGLE));
  }

  // 置いた内容を写しへ描く。毎フレーム、写しを読むより前に呼ぶ。
  public render(renderer: WebGPURenderer, gpu?: GpuTimingSink): void {
    if (!this.aimed) return;
    this.field.render(renderer, gpu);
  }

  // 写しの uv(0..1)で読んだ放射輝度。被覆率で割り戻すので、円板の外は黒になる。
  public radianceAtUv(uv: Vec2Node): Vec3Node {
    const sampled = texture(this.field.texture, uv);
    return sampled.rgb.div(max(sampled.a, MIN_COVERAGE));
  }

  // 受け手 position から向き direction を、角幅 filterAngle [rad] のフィルタで読んだ放射輝度。
  // どちらも描画座標。
  public radianceAt(position: Vec3Node, direction: Vec3Node, filterAngle: FloatNode): Vec3Node {
    // 受け手が見ている地表の点を、基準点から見た向きへ引き直す(視差の補正)。
    const omega = normalize(this.surfaceHit(position, direction).sub(this.reference));
    const level = clamp(log2(filterAngle.div(this.projection.texelAngle)), 0, MAX_IMAGE_LEVEL);
    const sampled = this.field.atLevel(omega, level);
    return sampled.rgb.div(max(sampled.a, MIN_COVERAGE));
  }

  // uv の指す方向(基準点から)に見える地表の放射輝度と、円板の被覆率。
  private bakedRadiance(direction: Vec3Node): Vec4Node {
    const normal = normalize(this.surfaceHit(this.reference, direction).sub(this.center));
    const bodyNormal: Vec3Node = this.bodyFromWorld.mul(vec4(normal, 0)).xyz;
    // **ベース色を読む段は、写し 1 枚につき 1 つに決める** — 画面微分に任せると、経度の巻き目
    // (u が 1 から 0 へ跳ぶ列)で最も粗い段が選ばれ、日付変更線に 1 本の線が出る。段は、写しの
    // 1 texel が正対する地表へ張る角と、画像の 1 texel が張る角 π/高さ の比。
    const distance = length(this.center.sub(this.reference));
    const surfaceAngle = this.projection.texelAngle.mul(distance.sub(this.radius)).div(this.radius);
    const imageHeight = float((this.baseColor.size(int(0)) as THREE.Node<'uvec2'>).y);
    const level = max(log2(surfaceAngle.mul(imageHeight).div(Math.PI)), 0);
    const uv = equirectUvFromDirection(bodyNormal);
    const imageUv = vec2(uv.x, mix(uv.y, uv.y.oneMinus(), this.baseColorFlipY));
    const albedo = this.baseColor.sample(imageUv).level(level).rgb.mul(this.albedoFactor);
    // ランバート面の放射輝度。昼側だけが光る。
    const radiance = albedo.mul(this.sunIrradiance).mul(max(dot(normal, this.starDirection), 0)).div(Math.PI);
    // 被覆率を持たせておき、読む側が割り戻す。**省くと、段が上がるほど写しが暗くなる** —
    // 円板の外(正方形の四隅、面積の 21.5%)が 0 のまま平均へ混ざる。
    const inside = this.projection.insideAt(screenUV);
    return vec4(radiance.mul(inside), inside);
  }

  // origin から向き direction のレイが天体の球面と交わる、手前側の点。
  //
  // **向きは正規化し、軸から外れた量はベクトルの差で測る。** GPU の cos() には仕様上 2⁻¹¹ までの
  // 絶対誤差が許されていて、円錐の向きはその誤差ぶん長さがずれる。外れを |toCenter|² − along² の
  // 差で測ると、そのずれが (距離/半径)² 倍されて交点ごと壊れる。
  private surfaceHit(origin: Vec3Node, direction: Vec3Node): Vec3Node {
    const ray = normalize(direction);
    const toCenter = this.center.sub(origin);
    const along = dot(toCenter, ray);
    const offAxis = toCenter.sub(ray.mul(along));
    // 判別式は円錐の縁で 0 になるので、数値で負へ落ちたぶんは止める。
    const half = sqrt(max(this.radius.mul(this.radius).sub(dot(offAxis, offAxis)), 0));
    return origin.add(ray.mul(along.sub(half)));
  }

  // 保持している GPU 資源を解放する。
  public dispose(): void {
    this.field.dispose();
    this.white.dispose();
  }
}
