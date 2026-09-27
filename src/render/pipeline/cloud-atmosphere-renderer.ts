// 雲を、大気の視線積分へ挟み込む厚み 0 の球殻としてモデル化する。どの種類の雲がどの高さに立つか、場のどの
// 成分から鉛直柱光学深さを引くか、掠める視線の光路をどこで頭打ちにするかを持ち、殻と交わる
// 1つの入口/出口イベントが、雲自身の透過率と局所放射輝度を返す。
//
// **輝度は多重散乱の極限近似で算出する。** 場の階調は被覆率を表すため、殻は「その被覆割合分が
// 拡散反射する層」として振る舞う。到達光は引数で渡されるため、入射光の減衰・影・地平線は
// 大気と同一の共通関数で評価される。イベント位置までの背景大気透過と、イベント間の雲透過の合成は
// AtmosphereCloudLayersが所有し、ここでは二重に適用しない。
import * as THREE from 'three/webgpu';
import {
  If, clamp, dot, float, greaterThan, max, min, normalize, smoothstep, sqrt, uniform, vec4,
} from 'three/tsl';
import { CloudFieldSampler } from '../cloud/cloud-field-sampler';
import { shellAirmassNode, transmittanceFromColumnOpticalDepthNode } from '../cloud/cloud-optics-node';
import { CloudShapeEvaluator } from '../cloud/cloud-shape-evaluator';
import { CUMULUS_GRAIN_SIZE } from '../cloud/cumulus-shape';
import { gradientNoise } from '../cloud/gradient-noise';
import { eastAt, northAt } from '../cloud/sphere-frame';
import type { AtmosphereClouds } from '../atmosphere';
import type { CloudSample } from '../cloud/cloud-field-sample';
import type { BoolNode, FloatNode, FloatUniform, Mat4Uniform, Vec3Node } from '../tsl-types';

// 鉛直の光学的厚みへ張る上限。ゲインを上げた柱はここで飽和する。積雲の柱が取りうる厚みの上限
// (被覆率 0.99 で ≈4.6)と、かなとこの芯の厚み(≈30)がどちらも透過率ほぼ 0 になる上に置き、
// ゲイン 1 では効かない。
const MAX_SHELL_OPTICAL_DEPTH = 5;

// 層の厚みへ張る下限 [m]。掠める視線の光路は厚みぶんの弦で頭打ちにするので、厚み 0 では
// 地平線ぎわの視線が飽和する。
const MIN_SHELL_THICKNESS = 1;
const CLOUD_SHAPE_EVALUATOR = new CloudShapeEvaluator(0);

// 画面 1 画素が張る角の代表値 [rad](60° 画角・1080 px 相当)。殻の経路では評価点が G バッファの
// 位置と一致しないので画面微分が取れず、交差点までの距離とこの代表値から画素の footprint を
// 見積もる。実際の解像度とずれても、動くのは細部が現れ始める距離の前後だけ。
const SHELL_PIXEL_ANGLE = 1e-3;

// 巻雲の繊維の形。筋に直交する向きの波長 [m]、繊維の向きへ座標を圧縮する比(0.9 は長手へ
// 約 10 倍の引き伸ばし)、光学深さへ掛ける変調の深さ(0..1)。筋の間隔・向きは調整値。
const FIBER_WAVELENGTH = 25e3;
const FIBER_STRETCH = 0.9;
const FIBER_AMPLITUDE = 0.5;
// 繊維の細部を載せる繊維性の下限と、筋の向き(upperOpticalDepth の等厚線)が立つ勾配の下限。
// 勾配は繊維幅ぶん離したタップとの差分で取る。
const FIBER_EPSILON = 0.02;
const FIBER_GRADIENT_EPSILON = 0.03;

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

// 表示のオン/オフを切り替える雲の種類。複数の殻が同じ種類へ属することがある(上層の雲は
// 高い・低い 2 枚の殻を持つ)。
export type CloudSpecies = 'cirrus' | 'cumulus';
// 殻 1 枚の識別子。高度とつまみの鍵。
export type CloudShellId = 'cirrus' | 'cirrusLow' | 'cumulus';

interface CloudShellDefinition {
  readonly id: CloudShellId;
  readonly species: CloudSpecies;
  readonly knob: CloudShellKnob;
  // 上層の雲(巻雲・かなとこ)の殻か。上層の殻は場の高さへ按分した柱光学深さと、場から推した
  // 向きの繊維の細部を持つ。
  readonly upper: boolean;
  // 場の標本から、その殻が受け持つ鉛直柱光学深さを引く。footprint は交差点で画素が張る実寸 [m]。
  readonly columnOpticalDepth: (field: CloudSample, footprint: FloatNode) => FloatNode;
}

// 種類ごとの殻。順序・調整値・場のどの意味を光学深さへ使うかをここへ集約し、入口を増やしたときに
// 大気とrender-labの片方だけへ種類が増える状態を防ぐ。**仮設**: uniformはrender-labから動かせる。
//
// 上層の雲は高い・低い 2 枚の殻へ分ける。殻の半径は画素ごとに変えられない(視線との交差を
// 解析的に解くため)ので、場の upperAltitude を「2 枚の殻の代表高度への近さ」で按分し、
// 2 枚の重心が場の高さに一致するようにする — かなとこ(高い)と古い巻雲(低い)が層の高さで
// 分かれて見える。
const CLOUD_SHELL_DEFINITIONS: readonly CloudShellDefinition[] = [
  {
    id: 'cirrus',
    species: 'cirrus',
    upper: true,
    knob: {
      cutoff: uniform(0), gain: uniform(1), albedo: uniform(1),
      bottomAltitude: uniform(15e3), topAltitude: uniform(16e3),
    },
    columnOpticalDepth: (field) => field.upperOpticalDepth.mul(upperHighWeight(field)),
  },
  {
    id: 'cirrusLow',
    species: 'cirrus',
    upper: true,
    knob: {
      cutoff: uniform(0), gain: uniform(1), albedo: uniform(1),
      bottomAltitude: uniform(6e3), topAltitude: uniform(10.5e3),
    },
    columnOpticalDepth: (field) => field.upperOpticalDepth.mul(upperHighWeight(field).oneMinus()),
  },
  {
    id: 'cumulus',
    species: 'cumulus',
    upper: false,
    knob: {
      cutoff: uniform(0.05), gain: uniform(1), albedo: uniform(1),
      bottomAltitude: uniform(0), topAltitude: uniform(2e3),
    },
    // 被覆率のうち不透明な形が受け持つ分を差し引いた残量を、半透明な雲が受け持つ — 不透明な
    // 表面と大気の薄い雲が同じ被覆を二重に数えないようにする。**細部の解像度は不透明な表面と
    // 同じ見積もり(形態ごとの波長で引く)でなければならない** — ずれると、面が受け持つはずの
    // 被覆を殻が余分に数える、あるいは数え損ねる。
    columnOpticalDepth: (field, footprint) => {
      const frequencyScale = CLOUD_SHAPE_EVALUATOR.detailFrequencyScale(
        field.cellularity, field.vigor);
      const resolvability = CloudShapeEvaluator.resolvability(
        footprint, float(CUMULUS_GRAIN_SIZE).div(frequencyScale));
      const opticalDepth = CloudShapeEvaluator.lowOpticalDepth(field.cloudTop);
      const opaque = CloudShapeEvaluator.expectedOpaqueFraction(
        field.coverage, resolvability, opticalDepth);
      return CLOUD_SHAPE_EVALUATOR.columnOpticalDepth(
        CloudShapeEvaluator.translucentResidual(field.coverage, opaque));
    },
  },
];

export const CLOUD_SHELL_SPECIES: readonly CloudSpecies[] = ['cirrus', 'cumulus'];

// 大気内に多層球殻として配置する雲殻。外側の層から順に並べる。同心球構造のため、
// 視線との交差順序は「外殻進入 → 内殻進入 → 内殻退出 → 外殻退出」となる。
export const CLOUD_SHELL_IDS: readonly CloudShellId[] = CLOUD_SHELL_DEFINITIONS.map(
  ({ id }) => id,
);

function shellDefinitionOf(id: CloudShellId): CloudShellDefinition {
  const definition = CLOUD_SHELL_DEFINITIONS.find((candidate) => candidate.id === id);
  if (definition === undefined) throw new Error(`Unknown cloud shell: ${id}`);
  return definition;
}

// 調整値を共有定義から取得する。render-labも同じuniformを操作するので、値の複製を作らない。
export function cloudShellKnobOf(id: CloudShellId): CloudShellKnob {
  return shellDefinitionOf(id).knob;
}

// 殻を立てる高度 [m]。
export function shellAltitudeOf(id: CloudShellId): FloatNode {
  const knob = cloudShellKnobOf(id);
  return knob.bottomAltitude.add(knob.topAltitude).mul(0.5);
}

// 場の上層の高さが、2 枚の殻のうち高い側へ近い割合 0..1。殻の代表高度のあいだで線形に按分する
// ので、2 枚の光学深さの重心は場の高さに一致する。
function upperHighWeight(field: CloudSample): FloatNode {
  const low = shellAltitudeOf('cirrusLow');
  const high = shellAltitudeOf('cirrus');
  return clamp(field.upperAltitude.sub(low).div(max(high.sub(low), 1)), 0, 1);
}

// 殻と交わる 1 点ぶんの、視線が受ける減衰と、その点が視線へ足す放射輝度。
export interface CloudShellSample {
  // 場から得た鉛直柱光学深さ。上層は upperOpticalDepth を高度で 2 枚へ按分したもの、
  // 積雲は被覆率から不透明な形のぶんを引いた残量を光学深さへ変換したもの。
  readonly columnOpticalDepth: FloatNode;
  // 鉛直柱を視線へ写す倍率。球殻の厚みで接線側の発散を有限化する。
  readonly airmass: FloatNode;
  readonly transmittance: FloatNode;
  // イベント局所の放射輝度。背景大気透過と手前イベント透過はここでは掛けない。
  readonly radiance: Vec3Node;
}

// つまみを通した殻の鉛直の光学的厚み。場から引いた光学深さへ細部の変調を掛け、足切りを
// 引いた残りへゲインを掛け、上限で頭打ちにする。
function opticalDepthOf(
  definition: CloudShellDefinition, field: CloudSample, footprint: FloatNode,
  detail: FloatNode,
): FloatNode {
  const knob = definition.knob;
  const raised = max(
    definition.columnOpticalDepth(field, footprint).mul(detail).sub(knob.cutoff), 0)
    .mul(knob.gain);
  return min(raised, MAX_SHELL_OPTICAL_DEPTH);
}

export class CloudAtmosphereRenderer {
  // 雲場の読み取りと形状の解釈は共有入力層へ置く。ここは殻の散乱だけを所有する。
  private readonly fieldSampler = new CloudFieldSampler();
  private readonly bodyFromWorld: Mat4Uniform;
  private readonly active: FloatUniform;
  // 種類ごとに、その殻を描くか。
  private readonly enabled: Readonly<Record<CloudSpecies, FloatUniform>> = Object.fromEntries(
    CLOUD_SHELL_SPECIES.map((species) => [species, uniform(1)]),
  ) as Record<CloudSpecies, FloatUniform>;

  // 天体 1 体ぶんの雲の uniform を確保する。雲の有無も殻の取捨も uniform で切るので、グラフの
  // 形は変わらない。
  public constructor() {
    this.bodyFromWorld = uniform(new THREE.Matrix4());
    this.active = uniform(0);
  }

  // 評価対象の雲定義。null の場合は雲殻を生成しない。
  public set(clouds: AtmosphereClouds | null): void {
    this.active.value = clouds === null ? 0 : 1;
    if (clouds === null) return;
    this.bodyFromWorld.value.copy(clouds.bodyFromWorld);
    this.fieldSampler.bind(clouds.cloud.field);
  }

  // 種類ごとに、その殻を描くかを置き直す。
  public setShellEnabled(species: CloudSpecies, enabled: boolean): void {
    this.enabled[species].value = enabled ? 1 : 0;
  }

  // その殻が立っているか。
  public present(shell: CloudShellId): BoolNode {
    return greaterThan(this.shellPresence(shell), 0);
  }

  // 殻と交わる 1 点が視線へ与える減衰と放射輝度。offset は天体中心から交点へのベクトル、
  // rayDir は視線の向き、sunDir は交点から恒星への向き(いずれも天体を真球にした空間で、
  // 向きは単位長)。sunRadiance はその交点へ届く恒星の輝度。distance はカメラから交点までの
  // 距離 [m] で、画素が交差点で張る実寸(= 細部を解像できるか)を見積もるのに使う。
  public scatteredAt(
    shell: CloudShellId, shellRadius: FloatNode, offset: Vec3Node, rayDir: Vec3Node,
    sunDir: Vec3Node, sunRadiance: Vec3Node, distance: FloatNode,
  ): CloudShellSample {
    const definition = shellDefinitionOf(shell);
    const knob = definition.knob;
    const up = offset.div(shellRadius);
    const field = this.fieldAt(up);
    // 視線が層を斜めに抜けるぶんの倍率。**水平では発散する**ので、層の厚みぶんの弦 √(2RΔh) を
    // 通る視線を上限に取る(地球の 1 km 厚なら光路 226 km、天頂の 113 倍)。
    const thickness = max(knob.topAltitude.sub(knob.bottomAltitude), MIN_SHELL_THICKNESS);
    const airmass = shellAirmassNode(dot(up, rayDir), thickness, shellRadius);
    // 交差点で 1 画素が張る実寸の見積もり。掠める視線ほど殻の面上へ伸びるので airmass を掛ける。
    const footprint = distance.mul(SHELL_PIXEL_ANGLE).mul(airmass);
    const detail = this.upperDetailAt(definition, field, up, footprint, shellRadius);
    const columnOpticalDepth = opticalDepthOf(definition, field, footprint, detail)
      .mul(this.shellPresence(shell));
    const transmittance = transmittanceFromColumnOpticalDepthNode(columnOpticalDepth, airmass);
    const covered = transmittance.oneMinus();
    return {
      columnOpticalDepth,
      airmass,
      transmittance,
      radiance: sunRadiance.mul(covered.mul(max(dot(up, sunDir), 0)).mul(knob.albedo)),
    };
  }

  // 上層の殻へ載せる繊維の細部。繊維性 φ のある場所で、upperOpticalDepth の勾配に垂直な向き
  // (等厚線に沿う向き — 風の場を持たないので筋の向きは場自身から推す)へ引き伸ばした細部で
  // 柱光学深さを揺らす。滑らかな天蓋(かなとこ、smoothness 1)では細部は 1 のまま均一な幕に
  // なる。解像できない細部は載せない。下層の殻では常に 1 を返す。
  private upperDetailAt(
    definition: CloudShellDefinition, field: CloudSample, up: Vec3Node,
    footprint: FloatNode, shellRadius: FloatNode,
  ): FloatNode {
    if (!definition.upper) return float(1);
    const detail = float(0).toVar();
    const fibrousness = field.fibrousness.mul(field.smoothness.oneMinus());
    // 繊維性の無い場所では勾配のタップごと飛ばす。
    If(fibrousness.greaterThan(FIBER_EPSILON), () => {
      const east = eastAt(up);
      const north = northAt(up);
      const delta = float(FIBER_WAVELENGTH).div(shellRadius);
      const gradEast = this.fieldAt(normalize(up.add(east.mul(delta)))).upperOpticalDepth
        .sub(field.upperOpticalDepth);
      const gradNorth = this.fieldAt(normalize(up.add(north.mul(delta)))).upperOpticalDepth
        .sub(field.upperOpticalDepth);
      const gradientLength = sqrt(gradEast.mul(gradEast).add(gradNorth.mul(gradNorth)));
      // 勾配に垂直な接平面の向き。**勾配が立たない所では正規化も飽和させる** — 細部は勾配の
      // 強さで 0 へ落ちるので、分母を小さくしすぎるとベクトルだけが発散して座標が壊れる。
      const tangent = east.mul(gradNorth).sub(north.mul(gradEast))
        .div(max(gradientLength, float(FIBER_GRADIENT_EPSILON).mul(0.5)));
      const stretched = up.sub(tangent.mul(dot(up, tangent).mul(FIBER_STRETCH)));
      const resolved = CloudShapeEvaluator.resolvability(footprint, FIBER_WAVELENGTH);
      const streak = gradientNoise(stretched.mul(shellRadius.div(FIBER_WAVELENGTH)));
      detail.assign(streak.mul(FIBER_AMPLITUDE).mul(fibrousness).mul(resolved)
        .mul(smoothstep(0, FIBER_GRADIENT_EPSILON, gradientLength)));
    });
    return detail.add(1);
  }

  // その殻が立っているなら 1、立っていないなら 0。オン/オフは殻の属する種類で切る。
  private shellPresence(shell: CloudShellId): FloatNode {
    return this.active.mul(this.enabled[shellDefinitionOf(shell).species]);
  }

  // 天体を真球にした空間の単位方向 up における場。UV は共有 sampler が積雲の殻と同じ規則で読む。
  private fieldAt(up: Vec3Node): CloudSample {
    return this.fieldSampler.sampleCloud(this.bodyFromWorld.mul(vec4(up, 0)).xyz);
  }
}
