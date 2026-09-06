// 巻雲を、大気の視線積分へ挟む厚み 0 の球殻として解く。殻がどの高さに立つか、場のどの成分から
// 鉛直の光学的厚みを引くか、掠める視線の光路をどこで頭打ちにするかを持ち、殻と交わる 1 点が
// 視線へ与える透過率と放射輝度を返す。
//
// **輝度は多重散乱の極限で解く。** 場の階調は覆われている割合なので、殻は「その割合ぶんが
// 拡散反射する層」として振舞う。届く光は呼び出し側が渡すので、入射の減衰・影・地平線は
// 大気と同じ 1 本の式が解く。
import * as THREE from 'three/webgpu';
import { abs, dot, exp, float, fract, greaterThan, int, max, sqrt, texture, uniform, vec2, vec4 } from 'three/tsl';
import { sphereMeshUv } from '../celestial-surface';
import { CLOUD_ALBEDO, EMPTY_CLOUD_FIELD, fieldLodForWidth } from '../cloud/cumulus-shape';
import type { AtmosphereClouds } from '../atmosphere';
import type { BoolNode, FloatNode, FloatUniform, Mat4Uniform, Vec3Node, Vec4Node } from '../tsl-types';

// 巻雲の殻の高度 [m]。圏界面付近(≈200 hPa)の 1 枚で近似する — 実際の巻雲は極域 3〜8 km、
// 温帯 5〜13 km、熱帯 6〜18 km に張る。
const CIRRUS_ALTITUDE = 10e3;

// 殻が代表する層の厚み [m]。掠める視線の光路をこの厚みぶんの弦で頭打ちにする。
const SHELL_THICKNESS = 1e3;

// 殻と交わる 1 点ぶんの、視線が受ける減衰と、その点が視線へ足す放射輝度。
export interface CloudShellSample {
  readonly transmittance: FloatNode;
  readonly radiance: Vec3Node;
}

export class CloudScattering {
  // 雲の場。set が value を差し替えると、枝分かれした先へも同じ写しが届く。
  private readonly field = texture(EMPTY_CLOUD_FIELD);
  private readonly bodyFromWorld: Mat4Uniform;
  private readonly active: FloatUniform;

  // 殻 1 枚ぶんの uniform を確保する。雲の有無は active で切るので、グラフの形は変わらない。
  public constructor() {
    this.bodyFromWorld = uniform(new THREE.Matrix4());
    this.active = uniform(0);
  }

  // 殻の高度 [m]。
  public get altitude(): number { return CIRRUS_ALTITUDE; }

  // いま解く雲。null なら殻は立たない。
  public set(clouds: AtmosphereClouds | null): void {
    this.active.value = clouds === null ? 0 : 1;
    if (clouds === null) return;
    this.bodyFromWorld.value.copy(clouds.bodyFromWorld);
    this.field.value = clouds.field;
  }

  // 殻が立っているか。
  public present(): BoolNode { return greaterThan(this.active, 0); }

  // 殻と交わる 1 点が視線へ与える減衰と放射輝度。offset は天体中心から交点へのベクトル、
  // rayDir は視線の向き、sunDir は交点から恒星への向き(いずれも天体を真球にした空間で、
  // 向きは単位長)。sunRadiance はその交点へ届く恒星の輝度、footprint はその交点で画面 1 px
  // が張る実寸 [m]。
  public scatteredAt(
    shellRadius: FloatNode, offset: Vec3Node, rayDir: Vec3Node, sunDir: Vec3Node,
    sunRadiance: Vec3Node, footprint: FloatNode,
  ): CloudShellSample {
    const up = offset.div(shellRadius);
    const opticalDepth = this.fieldAt(up, footprint, shellRadius).b.mul(this.active);
    // 視線が層を斜めに抜けるぶんの倍率。**水平では発散する**ので、層の厚みぶんの弦 √(2RΔh) を
    // 通る視線を上限に取る(地球の 1 km 厚なら光路 226 km、天頂の 113 倍)。
    const grazingCosine = sqrt(float(SHELL_THICKNESS / 2).div(shellRadius));
    const airmass = max(abs(dot(up, rayDir)), grazingCosine).reciprocal();
    const covered = exp(opticalDepth.mul(airmass).negate()).oneMinus();
    return {
      transmittance: covered.oneMinus(),
      radiance: sunRadiance.mul(covered.mul(max(dot(up, sunDir), 0)).mul(CLOUD_ALBEDO)),
    };
  }

  // 天体を真球にした空間の単位方向 up における場。uv は積雲の殻が読むのと同じ球メッシュの uv
  // (sphereMeshUv)で引く。**mip 段は明示で渡す** — 交点の uv は天体の縁と不透明面の際で
  // 画面の隣の画素と続かず、画面微分から選ばれる段が当てにならない。
  private fieldAt(up: Vec3Node, footprint: FloatNode, shellRadius: FloatNode): Vec4Node {
    // 寸法を返すノードは型引数を持たないので、成分を取れる形へ直してから読む。
    const fieldWidth = (this.field.size(int(0)) as THREE.Node<'uvec2'>).x;
    const uv = sphereMeshUv(this.bodyFromWorld.mul(vec4(up, 0)).xyz);
    return this.field.sample(vec2(fract(uv.x), uv.y))
      .level(fieldLodForWidth(footprint, shellRadius, float(fieldWidth)));
  }
}
