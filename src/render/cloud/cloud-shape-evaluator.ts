// 雲テクスチャ値を各表現の形状・光学量へ変換する共有評価器。被覆率の不透明/半透明への分け方・
// 雲頂高度・細部・光学的厚みの計算式を集約し、各レンダラーのシェーダーグラフへ展開する。
import { clamp, exp, float, max, mix, smoothstep } from 'three/tsl';
import { gradientNoise } from './gradient-noise';
import {
  columnOpticalDepthFromCoverageNode, lowCloudOpticalDepthNode,
} from './cloud-optics-node';
import {
  CLOSED_THRESHOLD, DETAIL_SIGMA, NORMAL_CDF_LOGISTIC_SLOPE, OPAQUE_COVERAGE_CENTER,
  OPAQUE_OPTICAL_DEPTH_FULL, OPAQUE_OPTICAL_DEPTH_ONSET,
} from './coverage-split';
import { CLOUD_BASE_HEIGHT, CUMULUS_GRAIN_SIZE, CLOUD_TOP_SPAN } from './cumulus-shape';
import type { FloatNode, Vec3Node } from '../tsl-types';

const GRAIN_TOP_RELIEF = 0.15;
const FIELD_TOP_STEP = 1 / 256;
// gradientNoise の標準偏差(一様な位置で 60 万点標本化した実測)。細部を DETAIL_SIGMA へ揃える目盛り。
const GRADIENT_NOISE_SIGMA = 0.271;
// 細部の 1 波長が何画素を切ったら解像できないとみなし始め、何画素で解像しきるか。標本化できない
// 細部はモアレにしかならないので、Nyquist の 2 画素へ落ちるまでに 0 へ渡す。
const RESOLVE_MIN_PIXELS = 2;
const RESOLVE_FULL_PIXELS = 4;
// 細部の標準偏差の下限。解像度 0 で 0 除算に落ちないための値。
const MIN_DETAIL_SPREAD = 1e-3;

// 細部の波長と雲頂の起伏を雲の形態(cellularity・vigor)で変える倍率。**侵食の細部の標準偏差は
// 形態で変えない** — 被覆率を不透明と半透明へ分ける期待値の式は細部の標準偏差を
// DETAIL_SIGMA × resolvability と仮定しているので、形態で変えられるのは波長と起伏だけ。
// 板状の雲(cellularity 0)は層積雲の数十 km のセルや乱層雲の板の当たりとして、粒より長い波長で
// 浅い起伏へ寄せる。
const SHEET_FREQUENCY_SCALE = 0.25;
const SHEET_RELIEF_GAIN = 0.3;
// 勢いのある柱(vigor 1)は積雲の粒 1–5 km の当たりとして、粒より細かく深い起伏へ寄せる。
const TOWER_FREQUENCY_SCALE = 1.75;
const TOWER_RELIEF_GAIN = 1.75;

export class CloudShapeEvaluator {
  // 雲頂の高さの不確かさ(粒の起伏と場の texel 段差の和、場の 0..1 の目盛り)。
  public static readonly cloudTopUncertainty = GRAIN_TOP_RELIEF * TOWER_RELIEF_GAIN + FIELD_TOP_STEP;
  // grainAt が返す粒から detailAt が返す細部への換算比(標準偏差の比)。同じノイズを両方へ使う
  // 呼び出し側が引き直さずに済むようにここで対にする。
  public static readonly detailScale = DETAIL_SIGMA / GRADIENT_NOISE_SIGMA;

  public constructor(private readonly grainFrequency: FloatNode | number) {}

  // 細部の波長を形態で変える倍率。被覆率の侵食にも雲頂の起伏にも同じものを使う。
  public detailFrequencyScale(cellularity: FloatNode, vigor: FloatNode): FloatNode {
    return mix(SHEET_FREQUENCY_SCALE, 1, cellularity)
      .mul(mix(float(1), TOWER_FREQUENCY_SCALE, vigor));
  }

  // 雲頂の起伏の振幅を形態で変える倍率。被覆率の侵食へは掛けない(上の定数コメント参照)。
  public reliefGain(cellularity: FloatNode, vigor: FloatNode): FloatNode {
    return mix(SHEET_RELIEF_GAIN, 1, cellularity)
      .mul(mix(float(1), TOWER_RELIEF_GAIN, vigor));
  }

  // 雲頂の起伏へ足す粒。amplitude は解像できる割合 0..1、frequencyScale は detailFrequencyScale。
  public grainAt(
    direction: Vec3Node, amplitude: FloatNode, frequencyScale: FloatNode | number = 1,
  ): FloatNode {
    return gradientNoise(direction.mul(this.grainFrequency).mul(frequencyScale)).mul(amplitude);
  }

  // 被覆率へ足す細部。平均 0、標準偏差 DETAIL_SIGMA × resolvability。
  public detailAt(
    direction: Vec3Node, resolvability: FloatNode, frequencyScale: FloatNode | number = 1,
  ): FloatNode {
    return this.grainAt(direction, resolvability, frequencyScale)
      .mul(DETAIL_SIGMA / GRADIENT_NOISE_SIGMA);
  }

  // 1 画素が張る実寸 footprint [m] で、1 波長 featureSize [m] の細部を解像できる割合 0..1。
  public static resolvability(
    footprint: FloatNode, featureSize: FloatNode | number = CUMULUS_GRAIN_SIZE,
  ): FloatNode {
    return smoothstep(
      RESOLVE_MIN_PIXELS, RESOLVE_FULL_PIXELS,
      max(footprint, 1e-3).reciprocal().mul(featureSize));
  }

  // 被覆率へ細部を足した値と比べる、不透明のしきい値。解像できないか、光学的に薄い柱では形が現れない。
  public static opaqueThreshold(resolvability: FloatNode, opticalDepth: FloatNode): FloatNode {
    const eligible = resolvability.mul(smoothstep(OPAQUE_OPTICAL_DEPTH_ONSET, OPAQUE_OPTICAL_DEPTH_FULL, opticalDepth));
    return eligible.oneMinus().mul(CLOSED_THRESHOLD - OPAQUE_COVERAGE_CENTER).add(OPAQUE_COVERAGE_CENTER);
  }

  // 被覆率 coverage の柱のうち不透明な形として描かれる面積の期待値(coverage-split.ts と同じ式)。
  public static expectedOpaqueFraction(
    coverage: FloatNode, resolvability: FloatNode, opticalDepth: FloatNode,
  ): FloatNode {
    const spread = max(resolvability.mul(DETAIL_SIGMA), MIN_DETAIL_SPREAD);
    const z = coverage.sub(CloudShapeEvaluator.opaqueThreshold(resolvability, opticalDepth)).div(spread);
    return exp(z.mul(-NORMAL_CDF_LOGISTIC_SLOPE)).add(1).reciprocal();
  }

  // 不透明な形の外側を半透明な雲が覆う割合。形の期待値 opaque と合わせた平均が coverage に一致する。
  public static translucentResidual(coverage: FloatNode, opaque: FloatNode): FloatNode {
    return clamp(coverage.sub(opaque).div(max(opaque.oneMinus(), MIN_DETAIL_SPREAD)), 0, 1);
  }

  // 雲頂高度 cloudTop [m] の下層の雲の鉛直柱光学深さ。雲底から雲頂までの厚みから決まる。
  public static lowOpticalDepth(cloudTop: FloatNode): FloatNode {
    return lowCloudOpticalDepthNode(cloudTop.sub(CLOUD_BASE_HEIGHT));
  }

  // 場の雲頂 fieldTop(0..1)へ粒の起伏を足した雲頂。reliefGain は reliefGain(cellularity, vigor)。
  public cloudTop(
    fieldTop: FloatNode, grain: FloatNode, reliefGain: FloatNode | number = 1,
  ): FloatNode {
    return clamp(fieldTop.add(grain.mul(GRAIN_TOP_RELIEF).mul(reliefGain)), 0, 1);
  }

  public cloudTopRadius(cloudTop: FloatNode, groundRadius: FloatNode): FloatNode {
    return cloudTop.mul(groundRadius.oneMinus()).add(groundRadius);
  }

  public columnOpticalDepth(coverage: FloatNode): FloatNode {
    return columnOpticalDepthFromCoverageNode(coverage);
  }

  public get cloudTopSpan(): number { return CLOUD_TOP_SPAN; }
}
