// 天体 1 体の見た目を、基準点から見た方向の円板へ 1 枚に焼き、方向で読み直す写し。距離を持たない
// 「方向の球面」の、天体が張る円錐ぶんの図法なので、天体の模様はその天体が空を占める広さのまま残る。
// 焼く値は、基準点からの視線ごとに写す天体(PlanetLightSubject)が返す放射輝度で、円板の被覆率を
// α に持つ。
import * as THREE from 'three/webgpu';
import { Fn, clamp, log2, max, normalize, screenUV, texture, uniform, vec4 } from 'three/tsl';
import { BakedField } from '../../baked-field';
import { EquidistantCap } from '../../field-projection';
import { GPU_PASS } from '../../gpu-timings';
import { PlanetLightSubject, type PlanetLightAppearance } from './planet-light-subject';
import type { WebGPURenderer } from 'three/webgpu';
import type { GpuTimingSink } from '../../gpu-timings';
import type { FloatNode, Vec2Node, Vec3Node, Vec3Uniform, Vec4Node } from '../../tsl-types';
import type { BodyShadow } from '../shadow/body-shadow';
import type { SunLight } from '../sun-light';

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

export class PlanetLightImage {
  // 写しの基準点(描画座標)。
  private readonly reference: Vec3Uniform = uniform(new THREE.Vector3());
  // 写す天体。地表の球との交点も、焼く値と同じくここから引く。
  private readonly _subject: PlanetLightSubject;
  private readonly projection = new EquidistantCap(PLANET_LIGHT_IMAGE_SIZE, MIN_CONE_ANGLE);
  private readonly field: BakedField;
  // 円錐の軸を置けた置き方か。置けないフレームは焼かない。
  private aimed = false;
  // 中心方向の書き込み先。フレームごとに確保しない使い回し領域。
  private readonly axis = new THREE.Vector3();

  // 写しの資源を確保する。焼く中身は毎フレーム set() で置く。sunLight と bodyShadow は写す天体の
  // 大気の中の点へ届く太陽光を引くのに使う。
  public constructor(sunLight: SunLight, bodyShadow: BodyShadow) {
    this._subject = new PlanetLightSubject(sunLight, bodyShadow);
    this.field = new BakedField(
      'planetLight', THREE.RGBAFormat, this.projection,
      (direction) => this.bakedRadiance(direction),
      GPU_PASS.lighting, true,
    );
  }

  // 写す天体。何を写すかの描画設定はここへ置く。
  public get subject(): PlanetLightSubject { return this._subject; }

  // このフレームに焼く内容を置く。reference / center は描画座標、radius は [m]。
  public set(
    reference: THREE.Vector3, center: THREE.Vector3, radius: number, appearance: PlanetLightAppearance,
  ): void {
    this.reference.value.copy(reference);
    this._subject.set(center, radius, appearance);
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
    const omega = normalize(this._subject.surfaceHit(position, direction).sub(this.reference));
    const level = clamp(log2(filterAngle.div(this.projection.texelAngle)), 0, MAX_IMAGE_LEVEL);
    const sampled = this.field.atLevel(omega, level);
    return sampled.rgb.div(max(sampled.a, MIN_COVERAGE));
  }

  // uv の指す方向(基準点から)の視線が受け取る放射輝度と、円板の被覆率。写す天体は分岐を持つので
  // Fn の中で組む。
  private bakedRadiance(direction: Vec3Node): Vec4Node {
    return Fn(() => {
      const radiance = this._subject.radianceAlong(this.reference, direction, this.projection.texelAngle);
      // 被覆率を持たせておき、読む側が割り戻す。**省くと、段が上がるほど写しが暗くなる** —
      // 円板の外(正方形の四隅、面積の 21.5%)が 0 のまま平均へ混ざる。
      const inside = this.projection.insideAt(screenUV);
      return vec4(radiance.mul(inside), inside);
    })() as Vec4Node;
  }

  // 保持している GPU 資源を解放する。
  public dispose(): void {
    this.field.dispose();
    this._subject.dispose();
  }
}
