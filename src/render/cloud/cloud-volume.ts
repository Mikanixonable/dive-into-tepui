// 2Dの方向fieldと高度方向の連続profileから、球空間の任意点における雲密度を返す共有評価器。
// fieldは方向ごとの鉛直柱光学深度だけを供給し、雲の主形状はこのvolumeのprofileが決める。
// Three/TSLへ依存するが、fieldの所有権・メッシュ・光学積分は持たない。
import { clamp, float, length, max, normalize } from 'three/tsl';
import { CloudFieldSampler } from './cloud-field-sampler';
import { CloudShapeEvaluator } from './cloud-shape-evaluator';
import { CLOUD_TOP_SPAN } from './cumulus-shape';
import type { FloatNode, Vec3Node, Vec4Node } from '../tsl-types';

// 連続coverageを有限段の体積へ配るための校正。表面・大気・影で共有する
// CloudShapeEvaluatorの柱光学深度そのものは変更せず、体積経路だけが参照する。
const CUMULUS_VOLUME_OPTICAL_DEPTH_SCALE = 10;

export type CloudVolumeSpecies = 'cumulus' | 'cirrus';

export interface CloudDensitySample {
  readonly cumulus: FloatNode;
  readonly cirrus: FloatNode;
}

// 生成fieldのGが持つ積雲の上端より下の固定底 [m]。これは高度profileの境界であり、
// 視線上の交点やinside判定には使わない。
export const CUMULUS_BASE_ALTITUDE = 1000;
// 巻雲はfieldのBを柱tauとして固定高度帯へ連続に配る。
export const CIRRUS_BASE_ALTITUDE = 15e3;
export const CIRRUS_TOP_ALTITUDE = 16e3;

// 6h(1-h)は0..1の積分が1になる連続profile。密度へ掛けると、profileを高度方向に積分した
// 値がそのままfieldの柱光学深度になる。
export function verticalCloudProfile(heightFraction: number): number {
  const h = Math.min(Math.max(heightFraction, 0), 1);
  return 6 * h * (1 - h);
}

export function integrateVerticalCloudProfile(sampleCount: number): number {
  if (!Number.isFinite(sampleCount) || sampleCount <= 0) return 0;
  const count = Math.max(1, Math.floor(sampleCount));
  let integral = 0;
  for (let index = 0; index < count; index++) {
    integral += verticalCloudProfile((index + 0.5) / count) / count;
  }
  return integral;
}

export class CloudVolume {
  private readonly shape = new CloudShapeEvaluator(0);

  public constructor(private readonly fieldSampler: CloudFieldSampler) {}

  // bodyOffsetは天体固定の球空間での中心からの位置 [m]。groundRadiusも同じ単位で渡す。
  // footprintはその点でfieldが覆う実寸 [m]で、明示LODの唯一の入力になる。
  public densityAt(
    bodyOffset: Vec3Node, groundRadius: FloatNode, footprint: FloatNode,
  ): CloudDensitySample {
    const radius = max(length(bodyOffset), 1e-6);
    const direction = normalize(bodyOffset);
    const field = this.fieldSampler.sample(
      direction, this.fieldSampler.lodForWidth(footprint, groundRadius),
    );
    return {
      cumulus: this.cumulusDensity(field, radius.sub(groundRadius)),
      cirrus: this.cirrusDensity(field, radius.sub(groundRadius)),
    };
  }

  public densityFor(
    species: CloudVolumeSpecies, bodyOffset: Vec3Node, groundRadius: FloatNode,
    footprint: FloatNode,
  ): FloatNode {
    const density = this.densityAt(bodyOffset, groundRadius, footprint);
    return species === 'cumulus' ? density.cumulus : density.cirrus;
  }

  private cumulusDensity(field: Vec4Node, altitude: FloatNode): FloatNode {
    const top = max(field.g.mul(CLOUD_TOP_SPAN), CUMULUS_BASE_ALTITUDE);
    // field.rは生の気象被覆率であり、柱を不透明にするcoverageではない。既存の連続rampを
    // 通してから柱tauへ変換することで、低い被覆率を二値化せず、通常値でも体積が積分可能になる。
    const continuousCoverage = this.shape.continuousCoverage(field.r, float(0));
    return this.profiledColumnDensity(
      this.volumeColumnOpticalDepth(continuousCoverage), altitude,
      float(CUMULUS_BASE_ALTITUDE), top,
    );
  }

  private volumeColumnOpticalDepth(coverage: FloatNode): FloatNode {
    return this.shape.columnOpticalDepth(coverage).mul(CUMULUS_VOLUME_OPTICAL_DEPTH_SCALE);
  }

  private cirrusDensity(field: Vec4Node, radius: FloatNode): FloatNode {
    return this.profiledColumnDensity(
      max(field.b, 0), radius, float(CIRRUS_BASE_ALTITUDE), float(CIRRUS_TOP_ALTITUDE),
    );
  }

  private profiledColumnDensity(
    columnOpticalDepth: FloatNode, coordinate: FloatNode,
    bottom: FloatNode, top: FloatNode,
  ): FloatNode {
    const thickness = max(top.sub(bottom), 1);
    const heightFraction = clamp(coordinate.sub(bottom).div(thickness), 0, 1);
    const profile = heightFraction.mul(heightFraction.oneMinus()).mul(6);
    return columnOpticalDepth.mul(profile).div(thickness);
  }
}
