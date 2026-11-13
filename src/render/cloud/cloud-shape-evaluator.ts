// 雲テクスチャ値を各表現の形状・光学量へ変換する共有評価器。被覆率・雲頂高度・粒子感・
// 光学的厚みの計算式を集約し、各レンダラーのシェーダーグラフへ展開する。
import { If, TWO_PI, abs, clamp, cos, float, fract, greaterThan, min, mix } from 'three/tsl';
import { gradientNoise } from './gradient-noise';
import { columnOpticalDepthFromCoverageNode } from './cloud-optics-node';
import {
  CUMULUS_DITHER_KNOB, CUMULUS_GRAIN_OCTAVES, CUMULUS_GRAIN_SIZE, CLOUD_TOP_SPAN,
  GRAIN_LIFECYCLE_CELL_M, GRAIN_LIFECYCLE_HOURS,
} from './cumulus-shape';
import type { FloatNode, Vec3Node } from '../tsl-types';

const GRAIN_COVERAGE_DEPTH = 0.25;
const GRAIN_TOP_RELIEF = 0.15;
const FIELD_TOP_STEP = 1 / 256;

export class CloudShapeEvaluator {
  public static readonly cloudTopUncertainty = GRAIN_TOP_RELIEF + FIELD_TOP_STEP;

  public constructor(private readonly grainFrequency: FloatNode | number) {}

  // 場の値から粒の振幅の天気による掛け率。雲頂が高く、被覆率が半ばの空ほど粒立ち、
  // 低く一面に覆った空ほど板になる — 粒立つ空とべったり覆う空が同時にあって、
  // その境目が数百キロの尺度で滑らかに移る。cloudTop は 0..1 へ正規化した雲頂高度。
  public static grainWeatherFactor(coverage: FloatNode, cloudTop: FloatNode): FloatNode {
    const broken = float(1).sub(abs(coverage.mul(2).sub(1)));
    return float(0.4).add(cloudTop.mul(0.3)).add(broken.mul(0.3));
  }

  // 単位方向における粒。amplitudes は CUMULUS_GRAIN_OCTAVES と同じ並びの
  // 段ごとの振幅で、呼び出し側が標本化できる細かさごとに段を落とす。振幅 0 の段は
  // 計算ごと飛ばす — タップの数だけノイズを引く影では、遠さで費用が戻る。
  //
  // 風が結ばれているとき、粒は場所ごとの位相で成長→成熟→崩壊を繰り返す。
  // windEnabled は風の結び目の 0/1 で、0 なら包絡は 1 になる。
  public grainAt(
    direction: Vec3Node, amplitudes: readonly FloatNode[],
    timeSeconds: FloatNode, windEnabled: FloatNode,
  ): FloatNode {
    // 場所の細胞の位相。ノイズの 1 波長が位相の 1 周ぶんの実寸に当たるよう方向を伸ばし、
    // [0, 1) へ折る。
    const phase = fract(gradientNoise(direction.mul(this.grainFrequency)
      .mul(CUMULUS_GRAIN_SIZE / GRAIN_LIFECYCLE_CELL_M)));
    // 周期に対する位置。生まれで 0、成熟で 0.5、崩壊で 1 へ戻る。
    const cycle = fract(timeSeconds.div(GRAIN_LIFECYCLE_HOURS * 3600).add(phase));
    // 生まれと崩壊で 0、成熟で 2、平均 1 の包絡。
    const envelope = float(1).sub(cos(cycle.mul(TWO_PI)));
    const grain = float(0).toVar();
    for (const [index, octave] of CUMULUS_GRAIN_OCTAVES.entries()) {
      const amplitude = amplitudes[index]!;
      If(greaterThan(amplitude, 0), () => {
        grain.addAssign(gradientNoise(direction.mul(this.grainFrequency)
          .div(octave.sizeM / CUMULUS_GRAIN_SIZE)).mul(octave.weight).mul(amplitude));
      });
    }
    return grain.mul(mix(1, envelope, windEnabled));
  }

  // 粒を足してからディザの帯へ通す。空の柱に粒だけで雲を生やさない共有規則である。
  public opaqueFraction(coverage: FloatNode, grain: FloatNode): FloatNode {
    const band = CUMULUS_DITHER_KNOB.halfWidth.mul(2);
    const center = CUMULUS_DITHER_KNOB.center;
    const clampedBand = min(band, center.mul(2));
    const covered = coverage.add(grain.mul(GRAIN_COVERAGE_DEPTH));
    return clamp(covered.sub(center.sub(clampedBand.mul(0.5))).div(clampedBand), 0, 1);
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
