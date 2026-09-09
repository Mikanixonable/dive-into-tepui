// 雲場の読み値を各表現の形状・光学量へ変換する共有評価器。coverageと光学的厚みの式を
// ここへ集約し、不透明表面・大気・雲影が別々の閾値や補間を持たないようにする。GPU ノードを
// 受け取り、各 renderer のシェーダグラフへ展開するが、GPU 資源の所有は行わない。
import { clamp, log, min } from 'three/tsl';
import { CUMULUS_COVERAGE_KNOB } from './cumulus-shape';
import type { FloatNode } from '../tsl-types';

const MAX_COLUMN_COVERAGE = 0.99;
export class CloudShapeEvaluator {
  // coverageを連続的な柱の被覆率へ通す。空の柱に体積を生やさない共有規則である。
  public continuousCoverage(coverage: FloatNode): FloatNode {
    const band = CUMULUS_COVERAGE_KNOB.halfWidth.mul(2);
    const center = CUMULUS_COVERAGE_KNOB.center;
    const clampedBand = min(band, center.mul(2));
    return clamp(coverage.sub(center.sub(clampedBand.mul(0.5))).div(clampedBand), 0, 1);
  }

  public columnOpticalDepth(coverage: FloatNode): FloatNode {
    return log(min(coverage, MAX_COLUMN_COVERAGE).oneMinus()).negate();
  }

}
