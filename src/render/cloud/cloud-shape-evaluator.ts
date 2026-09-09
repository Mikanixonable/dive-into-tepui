// 雲場の読み値を各表現の形状・光学量へ変換する共有評価器。coverage、雲頂、粒、光学的厚みの式を
// ここへ集約し、不透明表面・大気・雲影が別々の閾値や補間を持たないようにする。GPU ノードを
// 受け取り、各 renderer のシェーダグラフへ展開するが、GPU 資源の所有は行わない。
import { clamp, log, min, smoothstep } from 'three/tsl';
import { gradientNoise } from './gradient-noise';
import {
  CUMULUS_COVERAGE_KNOB, CUMULUS_GRAIN_SIZE, CLOUD_TOP_SPAN,
} from './cumulus-shape';
import type { FloatNode, Vec3Node } from '../tsl-types';

const MAX_COLUMN_COVERAGE = 0.99;
const GRAIN_COVERAGE_DEPTH = 0.25;
const GRAIN_TOP_RELIEF = 0.15;
const FIELD_TOP_STEP = 1 / 256;

export class CloudShapeEvaluator {
  public static readonly cloudTopUncertainty = GRAIN_TOP_RELIEF + FIELD_TOP_STEP;

  public constructor(private readonly grainFrequency: FloatNode | number) {}

  public grainAt(direction: Vec3Node, amplitude: FloatNode): FloatNode {
    return gradientNoise(direction.mul(this.grainFrequency)).mul(amplitude);
  }

  // 粒を足してから coverage の連続帯へ通す。空の柱に粒だけで雲を生やさない共有規則である。
  // これは二値判定ではなく、体積の柱光学深度へ渡す連続的な被覆率である。
  public continuousCoverage(coverage: FloatNode, grain: FloatNode): FloatNode {
    const band = CUMULUS_COVERAGE_KNOB.halfWidth.mul(2);
    const center = CUMULUS_COVERAGE_KNOB.center;
    const clampedBand = min(band, center.mul(2));
    const covered = coverage.add(grain.mul(GRAIN_COVERAGE_DEPTH));
    return clamp(covered.sub(center.sub(clampedBand.mul(0.5))).div(clampedBand), 0, 1);
  }

  // 旧表現との互換名。新しい体積経路ではcontinuousCoverageを使う。
  public opaqueFraction(coverage: FloatNode, grain: FloatNode): FloatNode {
    return this.continuousCoverage(coverage, grain);
  }

  public cloudTop(fieldTop: FloatNode, grain: FloatNode): FloatNode {
    return clamp(fieldTop.add(grain.mul(GRAIN_TOP_RELIEF)), 0, 1);
  }

  public cloudTopRadius(cloudTop: FloatNode, groundRadius: FloatNode): FloatNode {
    return cloudTop.mul(groundRadius.oneMinus()).add(groundRadius);
  }

  public columnOpticalDepth(coverage: FloatNode): FloatNode {
    return log(min(coverage, MAX_COLUMN_COVERAGE).oneMinus()).negate();
  }

  public grainAmplitudeForWidth(width: FloatNode): FloatNode {
    return smoothstep(CUMULUS_GRAIN_SIZE, 2 * CUMULUS_GRAIN_SIZE, width).oneMinus();
  }

  public get cloudTopSpan(): number { return CLOUD_TOP_SPAN; }
}
