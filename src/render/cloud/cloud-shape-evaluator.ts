// 雲テクスチャ値を各表現の形状・光学量へ変換する共有評価器。被覆率・雲頂高度・粒子感・
// 光学的厚みの計算式を集約し、各レンダラーのシェーダーグラフへ展開する。
import { If, abs, clamp, float, greaterThan, min } from 'three/tsl';
import { gradientNoise } from './gradient-noise';
import { columnOpticalDepthFromCoverageNode } from './cloud-optics-node';
import {
  CUMULUS_DITHER_KNOB, CUMULUS_GRAIN_OCTAVES, CUMULUS_GRAIN_SIZE, CLOUD_TOP_SPAN,
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

  // 天体固定の単位方向における粒。amplitudes は CUMULUS_GRAIN_OCTAVES と同じ並びの
  // 段ごとの振幅で、呼び出し側が標本化できる細かさごとに段を落とす。振幅 0 の段は
  // 計算ごと飛ばす — タップの数だけノイズを引く影では、遠さで費用が戻る。
  public grainAt(direction: Vec3Node, amplitudes: readonly FloatNode[]): FloatNode {
    const grain = float(0).toVar();
    for (const [index, octave] of CUMULUS_GRAIN_OCTAVES.entries()) {
      const amplitude = amplitudes[index]!;
      If(greaterThan(amplitude, 0), () => {
        grain.addAssign(gradientNoise(direction.mul(this.grainFrequency)
          .div(octave.sizeM / CUMULUS_GRAIN_SIZE)).mul(octave.weight).mul(amplitude));
      });
    }
    return grain;
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
