// 雲テクスチャ値を各表現の形状・光学量へ変換する共有評価器。被覆率の不透明/半透明への分け方・
// 雲頂高度・細部・光学的厚みの計算式を集約し、各レンダラーのシェーダーグラフへ展開する。
import { clamp, exp, max, smoothstep } from 'three/tsl';
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

export class CloudShapeEvaluator {
  public static readonly cloudTopUncertainty = GRAIN_TOP_RELIEF + FIELD_TOP_STEP;
  // grainAt が返す粒から detailAt が返す細部への換算比(標準偏差の比)。同じノイズを両方へ使う
  // 呼び出し側が引き直さずに済むようにここで対にする。
  public static readonly detailScale = DETAIL_SIGMA / GRADIENT_NOISE_SIGMA;

  public constructor(private readonly grainFrequency: FloatNode | number) {}

  // 雲頂の起伏へ足す粒。amplitude は解像できる割合 0..1。
  public grainAt(direction: Vec3Node, amplitude: FloatNode): FloatNode {
    return gradientNoise(direction.mul(this.grainFrequency)).mul(amplitude);
  }

  // 被覆率へ足す細部。平均 0、標準偏差 DETAIL_SIGMA × resolvability。
  public detailAt(direction: Vec3Node, resolvability: FloatNode): FloatNode {
    return this.grainAt(direction, resolvability).mul(DETAIL_SIGMA / GRADIENT_NOISE_SIGMA);
  }

  // 1 画素が張る実寸 footprint [m] で、細部を解像できる割合 0..1。
  public static resolvability(footprint: FloatNode): FloatNode {
    return smoothstep(RESOLVE_MIN_PIXELS, RESOLVE_FULL_PIXELS, max(footprint, 1e-3).reciprocal().mul(CUMULUS_GRAIN_SIZE));
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

  public cloudTop(fieldTop: FloatNode, grain: FloatNode): FloatNode {
    return clamp(fieldTop.add(grain.mul(GRAIN_TOP_RELIEF)), 0, 1);
  }

  public cloudTopRadius(cloudTop: FloatNode, groundRadius: FloatNode): FloatNode {
    return cloudTop.mul(groundRadius.oneMinus()).add(groundRadius);
  }

  public columnOpticalDepth(coverage: FloatNode): FloatNode {
    return columnOpticalDepthFromCoverageNode(coverage);
  }

  public get cloudTopSpan(): number { return CLOUD_TOP_SPAN; }
}
