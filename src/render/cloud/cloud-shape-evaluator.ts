// 雲場の読み値を各表現の形状・光学量へ変換する共有評価器。coverage、雲頂、粒、光学的厚みの式を
// ここへ集約し、不透明表面・大気・雲影が別々の閾値や補間を持たないようにする。GPU ノードを
// 受け取り、各 renderer のシェーダグラフへ展開するが、GPU 資源の所有は行わない。
import { clamp, exp, float, max, min, mix, select, smoothstep } from 'three/tsl';
import { gradientNoise } from './gradient-noise';
import { columnOpticalDepthFromCoverageNode } from './cloud-optics-node';
import {
  CLOUD_CELL_MEAN_SCALE_MAX,
  CLOUD_CELL_MEAN_SCALE_MIN,
  CLOUD_CELL_PROFILE_INDEX_HIGH_LATITUDE_LAND,
  CLOUD_CELL_PROFILE_INDEX_HIGH_LATITUDE_OCEAN,
  CLOUD_CELL_PROFILE_INDEX_LOW_LATITUDE_LAND,
  CLOUD_CELL_PROFILE_INDEX_LOW_LATITUDE_OCEAN,
  CLOUD_CELL_VARIANCE_PROFILES,
} from './cloud-cell-variance';
import {
  CUMULUS_COVERAGE_KNOB, CUMULUS_GRAIN_SIZE, CLOUD_TOP_SPAN,
} from './cumulus-shape';
import type { FloatNode, Vec3Node } from '../tsl-types';

const GRAIN_COVERAGE_DEPTH = 0.25;
const GRAIN_TOP_RELIEF = 0.15;
const FIELD_TOP_STEP = 1 / 256;
// 雲セルの代表スケール倍率。低緯度海洋の約4 kmから、陸域・高緯度の8 km以上までを
// CloudSample.cellSizeVariation へ連続に写す。地域別の分散は cloud-cell-variance.ts が持つ。
const DEFAULT_CELL_SIZE_VARIATION = 0;
// セルサイズの分散は、隣接する複数セルが似た大きさを持つよう、基準セルより8倍粗い場で変える。
// この8倍はサイズパッチの視認性を保つための実装推定値で、雲径の観測標準偏差そのものではない。
const CELL_SIZE_VARIATION_PATCH_SCALE = 8;

export class CloudShapeEvaluator {
  public static readonly cloudTopUncertainty = GRAIN_TOP_RELIEF + FIELD_TOP_STEP;

  public constructor(private readonly grainFrequency: FloatNode | number) {}

  public grainAt(
    direction: Vec3Node, amplitude: FloatNode,
    cellSizeVariation: FloatNode = float(DEFAULT_CELL_SIZE_VARIATION),
  ): FloatNode {
    return gradientNoise(
      direction.mul(this.grainFrequency).div(this.cellSizeScaleAt(direction, cellSizeVariation)),
    )
      .mul(amplitude);
  }

  // 粒を足してから coverage の連続帯へ通す。空の柱に粒だけで雲を生やさない共有規則である。
  public opaqueFraction(coverage: FloatNode, grain: FloatNode): FloatNode {
    const band = CUMULUS_COVERAGE_KNOB.halfWidth.mul(2);
    const center = CUMULUS_COVERAGE_KNOB.center;
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

  public grainAmplitudeForWidth(
    width: FloatNode, direction: Vec3Node,
    cellSizeVariation: FloatNode = float(DEFAULT_CELL_SIZE_VARIATION),
  ): FloatNode {
    const scale = this.cellSizeScaleAt(direction, cellSizeVariation);
    return smoothstep(
      float(CUMULUS_GRAIN_SIZE).mul(scale),
      float(2 * CUMULUS_GRAIN_SIZE).mul(scale),
      width,
    ).oneMinus();
  }

  public cellSizeScaleAt(direction: Vec3Node, variation: FloatNode): FloatNode {
    const profile = clamp(variation, 0, 1);
    const lowOcean = CLOUD_CELL_VARIANCE_PROFILES.lowLatitudeOcean;
    const highOcean = CLOUD_CELL_VARIANCE_PROFILES.highLatitudeOcean;
    const lowLand = CLOUD_CELL_VARIANCE_PROFILES.lowLatitudeLand;
    const highLand = CLOUD_CELL_VARIANCE_PROFILES.highLatitudeLand;
    const lowToHighOcean = smoothstep(
      CLOUD_CELL_PROFILE_INDEX_LOW_LATITUDE_OCEAN,
      CLOUD_CELL_PROFILE_INDEX_HIGH_LATITUDE_OCEAN,
      profile,
    );
    const highOceanToLowLand = smoothstep(
      CLOUD_CELL_PROFILE_INDEX_HIGH_LATITUDE_OCEAN,
      CLOUD_CELL_PROFILE_INDEX_LOW_LATITUDE_LAND,
      profile,
    );
    const lowLandToHighLand = smoothstep(
      CLOUD_CELL_PROFILE_INDEX_LOW_LATITUDE_LAND,
      CLOUD_CELL_PROFILE_INDEX_HIGH_LATITUDE_LAND,
      profile,
    );
    const logSigmaLowToHighOcean = mix(lowOcean.logSigma, highOcean.logSigma, lowToHighOcean);
    const logSigmaHighOceanToLowLand = mix(highOcean.logSigma, lowLand.logSigma, highOceanToLowLand);
    const logSigmaLowLandToHighLand = mix(lowLand.logSigma, highLand.logSigma, lowLandToHighLand);
    const logSigma = select(
      profile.lessThan(CLOUD_CELL_PROFILE_INDEX_HIGH_LATITUDE_OCEAN),
      logSigmaLowToHighOcean,
      select(
        profile.lessThan(CLOUD_CELL_PROFILE_INDEX_LOW_LATITUDE_LAND),
        logSigmaHighOceanToLowLand,
        logSigmaLowLandToHighLand,
      ),
    );
    const minScaleLowToHighOcean = mix(lowOcean.scaleMin, highOcean.scaleMin, lowToHighOcean);
    const minScaleHighOceanToLowLand = mix(highOcean.scaleMin, lowLand.scaleMin, highOceanToLowLand);
    const minScaleLowLandToHighLand = mix(lowLand.scaleMin, highLand.scaleMin, lowLandToHighLand);
    const minScale = select(
      profile.lessThan(CLOUD_CELL_PROFILE_INDEX_HIGH_LATITUDE_OCEAN),
      minScaleLowToHighOcean,
      select(
        profile.lessThan(CLOUD_CELL_PROFILE_INDEX_LOW_LATITUDE_LAND),
        minScaleHighOceanToLowLand,
        minScaleLowLandToHighLand,
      ),
    );
    const maxScaleLowToHighOcean = mix(lowOcean.scaleMax, highOcean.scaleMax, lowToHighOcean);
    const maxScaleHighOceanToLowLand = mix(highOcean.scaleMax, lowLand.scaleMax, highOceanToLowLand);
    const maxScaleLowLandToHighLand = mix(lowLand.scaleMax, highLand.scaleMax, lowLandToHighLand);
    const maxScale = select(
      profile.lessThan(CLOUD_CELL_PROFILE_INDEX_HIGH_LATITUDE_OCEAN),
      maxScaleLowToHighOcean,
      select(
        profile.lessThan(CLOUD_CELL_PROFILE_INDEX_LOW_LATITUDE_LAND),
        maxScaleHighOceanToLowLand,
        maxScaleLowLandToHighLand,
      ),
    );
    const meanScale = mix(CLOUD_CELL_MEAN_SCALE_MIN, CLOUD_CELL_MEAN_SCALE_MAX, profile);
    const sizeNoise = gradientNoise(
      direction.mul(this.grainFrequency).div(CELL_SIZE_VARIATION_PATCH_SCALE),
    );
    return max(min(meanScale.mul(exp(sizeNoise.mul(logSigma))), maxScale), minScale);
  }

  public get cloudTopSpan(): number { return CLOUD_TOP_SPAN; }
}
