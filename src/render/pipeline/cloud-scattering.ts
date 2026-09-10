// 雲を、大気の視線積分へ挟む厚み 0 の球殻として解く。どの種類の雲がどの高さに立つか、場のどの
// 成分から鉛直の光学的厚みを引くか、掠める視線の光路をどこで頭打ちにするかを持ち、殻と交わる
// 1 点が視線へ与える透過率と放射輝度を返す。
//
// **輝度は多重散乱の極限で解く。** 場の階調は覆われている割合なので、殻は「その割合ぶんが
// 拡散反射する層」として振舞う。届く光は呼び出し側が渡すので、入射の減衰・影・地平線は
// 大気と同じ 1 本の式が解く。
import * as THREE from 'three/webgpu';
import {
  abs, dot, exp, float, fract, greaterThan, int, max, min, sqrt, texture, uniform, vec2, vec4,
} from 'three/tsl';
import { sphereMeshUv } from '../celestial/celestial-surface';
import { EMPTY_CLOUD_FIELD, columnOpticalDepth, fieldLodForWidth } from '../cloud/cumulus-shape';
import type { AtmosphereClouds } from '../atmosphere';
import type { BoolNode, FloatNode, FloatUniform, Mat4Uniform, Vec3Node, Vec4Node } from '../tsl-types';

// 大気の中へ殻として立てる雲の種類。**外側の殻から順に並べる** — 同心なので、視線が交わる
// 順序は外へ入り、内へ入り、内から出て、外から出る、に決まる。
export const CLOUD_SHELL_SPECIES = ['cirrus', 'cumulus'] as const;
export type CloudSpecies = (typeof CLOUD_SHELL_SPECIES)[number];

// 鉛直の光学的厚みへ張る上限。ゲインを上げた柱はここで飽和する。積雲の柱が取りうる厚みの上限
// (被覆率 0.99 で ≈4.6)の上に置き、ゲイン 1 では効かない。
const MAX_SHELL_OPTICAL_DEPTH = 5;

// 層の厚みへ張る下限 [m]。掠める視線の光路は厚みぶんの弦で頭打ちにするので、厚み 0 では
// 地平線ぎわの視線が飽和する。
const MIN_SHELL_THICKNESS = 1;

// 殻 1 枚の見え方。鉛直の光学的厚みは、場から引いた厚みを cutoff で足切りし、gain を掛けたもの。
// albedo は殻の拡散反射率、bottomAltitude と topAltitude はその殻が代表する層の高度 [m] で、
// 殻は層の中央に立ち、層の厚みが掠める視線の光路を決める。
export interface CloudShellKnob {
  readonly cutoff: FloatUniform;
  readonly gain: FloatUniform;
  readonly albedo: FloatUniform;
  readonly bottomAltitude: FloatUniform;
  readonly topAltitude: FloatUniform;
}

// 種類ごとの殻。**どれも不透明な積雲との馴染みを目で追い込んだ値で、場を差し替えたら追い込み
// 直す。** 巻雲は熱帯の圏界面付近(実際の巻雲は極域 3〜8 km、温帯 5〜13 km、熱帯 6〜18 km に
// 張る)の 1 枚、積雲は雲底から中間調が多い覆いの縁までを 1 枚で代表する。
//
// **仮設**: render-lab のつまみ(tools/render-lab/main.ts)から動かせるよう uniform にしてある。
// 生成側の場へ差し替えたあとにもう一段の追い込みが要るので、それまでは畳まない。
export const CLOUD_SHELL_KNOB: Readonly<Record<CloudSpecies, CloudShellKnob>> = {
  cirrus: {
    cutoff: uniform(0), gain: uniform(1), albedo: uniform(1),
    bottomAltitude: uniform(15e3), topAltitude: uniform(16e3),
  },
  cumulus: {
    cutoff: uniform(0.05), gain: uniform(1), albedo: uniform(1),
    bottomAltitude: uniform(0), topAltitude: uniform(2e3),
  },
};

// 殻を立てる高度 [m]。
export function shellAltitudeOf(species: CloudSpecies): FloatNode {
  const knob = CLOUD_SHELL_KNOB[species];
  return knob.bottomAltitude.add(knob.topAltitude).mul(0.5);
}

// 殻と交わる 1 点ぶんの、視線が受ける減衰と、その点が視線へ足す放射輝度。
export interface CloudShellSample {
  readonly transmittance: FloatNode;
  readonly radiance: Vec3Node;
}

// 場が持つ殻の鉛直の光学的厚み。巻雲は場の B が厚みそのもので、積雲は R(被覆率)を柱の厚みへ直す。
//
// **不透明な積雲として立てたぶんを引かない。** 不透明な殻は G バッファへ深度を書くので、その
// 手前で終わる視線では殻の交点が区間の外へ落ちて寄与が消える — 引き算は同じ遮蔽を二重に効かせ、
// 塔の周りに殻の抜けを作る。むしろ塔の側に残るディザの濃淡差を、この殻が跨いで埋める。
function fieldOpticalDepthOf(species: CloudSpecies, field: Vec4Node): FloatNode {
  switch (species) {
    case 'cirrus':
      return field.b;
    case 'cumulus':
      return columnOpticalDepth(field.r);
  }
}

// つまみを通した殻の鉛直の光学的厚み。足切りを引いた残りへゲインを掛け、上限で頭打ちにする。
function opticalDepthOf(species: CloudSpecies, field: Vec4Node): FloatNode {
  const knob = CLOUD_SHELL_KNOB[species];
  const raised = max(fieldOpticalDepthOf(species, field).sub(knob.cutoff), 0).mul(knob.gain);
  return min(raised, MAX_SHELL_OPTICAL_DEPTH);
}

export class CloudScattering {
  // 雲の場。set が value を差し替えると、枝分かれした先へも同じ写しが届く。
  private readonly field = texture(EMPTY_CLOUD_FIELD);
  private readonly bodyFromWorld: Mat4Uniform;
  private readonly active: FloatUniform;
  // 種類ごとに、その殻を描くか。
  private readonly enabled: Readonly<Record<CloudSpecies, FloatUniform>> = {
    cirrus: uniform(1), cumulus: uniform(1),
  };

  // 天体 1 体ぶんの雲の uniform を確保する。雲の有無も殻の取捨も uniform で切るので、グラフの
  // 形は変わらない。
  public constructor() {
    this.bodyFromWorld = uniform(new THREE.Matrix4());
    this.active = uniform(0);
  }

  // いま解く雲。null なら殻は立たない。
  public set(clouds: AtmosphereClouds | null): void {
    this.active.value = clouds === null ? 0 : 1;
    if (clouds === null) return;
    this.bodyFromWorld.value.copy(clouds.bodyFromWorld);
    this.field.value = clouds.field;
  }

  // 種類ごとに、その殻を描くかを置き直す。
  public setShellEnabled(species: CloudSpecies, enabled: boolean): void {
    this.enabled[species].value = enabled ? 1 : 0;
  }

  // その種類の殻が立っているか。
  public present(species: CloudSpecies): BoolNode {
    return greaterThan(this.shellPresence(species), 0);
  }

  // 殻と交わる 1 点が視線へ与える減衰と放射輝度。offset は天体中心から交点へのベクトル、
  // rayDir は視線の向き、sunDir は交点から恒星への向き(いずれも天体を真球にした空間で、
  // 向きは単位長)。sunRadiance はその交点へ届く恒星の輝度、footprint はその交点で画面 1 px
  // が張る実寸 [m]。
  public scatteredAt(
    species: CloudSpecies, shellRadius: FloatNode, offset: Vec3Node, rayDir: Vec3Node,
    sunDir: Vec3Node, sunRadiance: Vec3Node, footprint: FloatNode,
  ): CloudShellSample {
    const knob = CLOUD_SHELL_KNOB[species];
    const up = offset.div(shellRadius);
    const field = this.fieldAt(up, footprint, shellRadius);
    const opticalDepth = opticalDepthOf(species, field).mul(this.shellPresence(species));
    // 視線が層を斜めに抜けるぶんの倍率。**水平では発散する**ので、層の厚みぶんの弦 √(2RΔh) を
    // 通る視線を上限に取る(地球の 1 km 厚なら光路 226 km、天頂の 113 倍)。
    const thickness = max(knob.topAltitude.sub(knob.bottomAltitude), MIN_SHELL_THICKNESS);
    const grazingCosine = sqrt(thickness.mul(0.5).div(shellRadius));
    const airmass = max(abs(dot(up, rayDir)), grazingCosine).reciprocal();
    const covered = exp(opticalDepth.mul(airmass).negate()).oneMinus();
    return {
      transmittance: covered.oneMinus(),
      radiance: sunRadiance.mul(covered.mul(max(dot(up, sunDir), 0)).mul(knob.albedo)),
    };
  }

  // その種類の殻が立っているなら 1、立っていないなら 0。
  private shellPresence(species: CloudSpecies): FloatNode {
    return this.active.mul(this.enabled[species]);
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
