// 雲を、大気の視線積分へ挟み込む厚み 0 の球殻としてモデル化する。どの種類の雲がどの高さに立つか、場のどの
// 成分から鉛直柱光学深さを引くか、掠める視線の光路をどこで頭打ちにするかを持ち、殻と交わる
// 1つの入口/出口イベントが、雲自身の透過率と局所放射輝度を返す。
//
// **輝度は多重散乱の極限近似で算出する。** 場の階調は被覆率を表すため、殻は「その被覆割合分が
// 拡散反射する層」として振る舞う。到達光は引数で渡されるため、入射光の減衰・影・地平線は
// 大気と同一の共通関数で評価される。イベント位置までの背景大気透過と、イベント間の雲透過の合成は
// AtmosphereCloudLayersが所有し、ここでは二重に適用しない。
import * as THREE from 'three/webgpu';
import { dot, greaterThan, max, min, normalize, uniform, vec4 } from 'three/tsl';
import { CloudFieldSampler } from '../cloud/cloud-field-sampler';
import { shellAirmassNode, transmittanceFromColumnOpticalDepthNode } from '../cloud/cloud-optics-node';
import { CloudShapeEvaluator } from '../cloud/cloud-shape-evaluator';
import type { AtmosphereClouds } from '../atmosphere';
import type { CloudSample } from '../cloud/cloud-field-sample';
import type { BoolNode, FloatNode, FloatUniform, Mat4Uniform, Vec3Node } from '../tsl-types';

// 鉛直の光学的厚みへ張る上限。ゲインを上げた柱はここで飽和する。積雲の柱が取りうる厚みの上限
// (被覆率 0.99 で ≈4.6)の上に置き、ゲイン 1 では効かない。
const MAX_SHELL_OPTICAL_DEPTH = 5;

// 層の厚みへ張る下限 [m]。掠める視線の光路は厚みぶんの弦で頭打ちにするので、厚み 0 では
// 地平線ぎわの視線が飽和する。
const MIN_SHELL_THICKNESS = 1;
const CLOUD_SHAPE_EVALUATOR = new CloudShapeEvaluator(0);

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

// 種類ごとの殻。順序・調整値・場のどの意味を光学深さへ使うかをここへ集約し、入口を増やしたときに
// 大気とrender-labの片方だけへ種類が増える状態を防ぐ。**仮設**: uniformはrender-labから動かせる。
const CLOUD_SHELL_DEFINITIONS = [
  {
    species: 'cirrus',
    knob: {
      cutoff: uniform(0), gain: uniform(1), albedo: uniform(1),
      bottomAltitude: uniform(15e3), topAltitude: uniform(16e3),
    },
    columnOpticalDepth: (field: CloudSample): FloatNode => field.translucent,
  },
  {
    species: 'cumulus',
    knob: {
      cutoff: uniform(0.05), gain: uniform(1), albedo: uniform(1),
      bottomAltitude: uniform(0), topAltitude: uniform(2e3),
    },
    columnOpticalDepth: (field: CloudSample): FloatNode =>
      CLOUD_SHAPE_EVALUATOR.columnOpticalDepth(field.coverage),
  },
] as const;

export type CloudSpecies = (typeof CLOUD_SHELL_DEFINITIONS)[number]['species'];

// 大気内に多層球殻として配置する雲の種類。外側の層から順に並べる。同心球構造のため、
// 視線との交差順序は「外殻進入 → 内殻進入 → 内殻退出 → 外殻退出」となる。
export const CLOUD_SHELL_SPECIES: readonly CloudSpecies[] = CLOUD_SHELL_DEFINITIONS.map(
  ({ species }) => species,
);

function shellDefinitionOf(species: CloudSpecies): (typeof CLOUD_SHELL_DEFINITIONS)[number] {
  const definition = CLOUD_SHELL_DEFINITIONS.find((candidate) => candidate.species === species);
  if (definition === undefined) throw new Error(`Unknown cloud shell species: ${species}`);
  return definition;
}

// 調整値を共有定義から取得する。render-labも同じuniformを操作するので、値の複製を作らない。
export function cloudShellKnobOf(species: CloudSpecies): CloudShellKnob {
  return shellDefinitionOf(species).knob;
}

// 殻を立てる高度 [m]。
export function shellAltitudeOf(species: CloudSpecies): FloatNode {
  const knob = cloudShellKnobOf(species);
  return knob.bottomAltitude.add(knob.topAltitude).mul(0.5);
}

// 殻と交わる 1 点ぶんの、視線が受ける減衰と、その点が視線へ足す放射輝度。
export interface CloudShellSample {
  // 場から得た鉛直柱光学深さ。巻雲はtranslucentを直接、積雲はcoverageから変換する。
  readonly columnOpticalDepth: FloatNode;
  // 鉛直柱を視線へ写す倍率。球殻の厚みで接線側の発散を有限化する。
  readonly airmass: FloatNode;
  readonly transmittance: FloatNode;
  // その交点から視線の前方へ局所光学場を抜ける消散。未結合では 0。
  readonly localFieldTau: FloatNode;
  // イベント局所の放射輝度。背景大気透過と手前イベント透過はここでは掛けない。
  readonly radiance: Vec3Node;
}

// 雲場データの解釈仕様は CloudSample が定義する。巻雲は translucent を直接適用し、積雲は coverage を鉛直柱光学厚みへ換算する。
//
// 不透明な積雲として描画された成分は減算しない。不透明な雲殻が G バッファに深度を書き込むため、その
// 手前で終端するレイでは交点が積分区間外となり自然に寄与が除外される。減算を行うと同一遮蔽が二重に積算され、
// 雲塔周囲に不自然なアーティファクトを生じる。
function columnOpticalDepthOf(species: CloudSpecies, field: CloudSample): FloatNode {
  return shellDefinitionOf(species).columnOpticalDepth(field);
}

// つまみを通した殻の鉛直の光学的厚み。足切りを引いた残りへゲインを掛け、上限で頭打ちにする。
function opticalDepthOf(species: CloudSpecies, field: CloudSample): FloatNode {
  const knob = cloudShellKnobOf(species);
  const raised = max(columnOpticalDepthOf(species, field).sub(knob.cutoff), 0).mul(knob.gain);
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

  // その種類の殻が立っているか。
  public present(species: CloudSpecies): BoolNode {
    return greaterThan(this.shellPresence(species), 0);
  }

  // 殻と交わる 1 点が視線へ与える減衰と放射輝度。offset は天体中心から交点へのベクトル、
  // rayDir は視線の向き、sunDir は交点から恒星への向き(いずれも天体を真球にした空間で、
  // 向きは単位長)。sunRadiance はその交点へ届く恒星の輝度。
  public scatteredAt(
    species: CloudSpecies, shellRadius: FloatNode, offset: Vec3Node, rayDir: Vec3Node,
    sunDir: Vec3Node, sunRadiance: Vec3Node,
  ): CloudShellSample {
    const knob = cloudShellKnobOf(species);
    const up = offset.div(shellRadius);
    const field = this.fieldAt(up);
    const columnOpticalDepth = opticalDepthOf(species, field).mul(this.shellPresence(species));
    // 視線が層を斜めに抜けるぶんの倍率。**水平では発散する**ので、層の厚みぶんの弦 √(2RΔh) を
    // 通る視線を上限に取る(地球の 1 km 厚なら光路 226 km、天頂の 113 倍)。
    const thickness = max(knob.topAltitude.sub(knob.bottomAltitude), MIN_SHELL_THICKNESS);
    const airmass = shellAirmassNode(dot(up, rayDir), thickness, shellRadius);
    const transmittance = transmittanceFromColumnOpticalDepthNode(columnOpticalDepth, airmass);
    // 局所光学場を抜ける消散は交点から視線の前方へ同じ場の光路で積分する。位置は |p|=1 が
    // frame.sphereRadiusM の正規化空間へ — offset は真球にした空間の実寸なので基準半径(殻の
    // 半径から殻の高度を引いたもの)で割り、天体固定の基底へ回すのは 2D の場と同じ規則。
    const surfaceRadius = shellRadius.sub(shellAltitudeOf(species));
    const positionN = this.bodyFromWorld.mul(vec4(offset, 0)).xyz.div(surfaceRadius);
    const directionN = normalize(this.bodyFromWorld.mul(vec4(rayDir, 0)).xyz);
    const localFieldTau = this.fieldSampler.localOpticalPathAt(positionN, directionN, 32).z;
    const covered = transmittance.oneMinus();
    return {
      columnOpticalDepth,
      airmass,
      transmittance,
      localFieldTau,
      radiance: sunRadiance.mul(covered.mul(max(dot(up, sunDir), 0)).mul(knob.albedo)),
    };
  }

  // その種類の殻が立っているなら 1、立っていないなら 0。
  private shellPresence(species: CloudSpecies): FloatNode {
    return this.active.mul(this.enabled[species]);
  }

  // 天体を真球にした空間の単位方向 up における場。UV は共有 sampler が積雲の殻と同じ規則で読む。
  private fieldAt(up: Vec3Node): CloudSample {
    return this.fieldSampler.sampleCloud(this.bodyFromWorld.mul(vec4(up, 0)).xyz);
  }
}
