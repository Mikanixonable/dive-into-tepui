// CloudSampleの鉛直柱量から、表面・大気・影が共有する3D密度/消散場を導く。
// detailは雲頂高度を上下へ再配分するだけで、各柱の鉛直光学深さは変えない。
import { clamp, float, max, smoothstep } from 'three/tsl';
import { CloudDetailField, CLOUD_DETAIL_TOP_RELIEF_M } from './cloud-detail-field';
import { columnOpticalDepthFromCoverageNode } from './cloud-optics-node';
import { CLOUD_TOP_SPAN } from './cumulus-shape';
import type { CloudSample } from './cloud-field-sample';
import type { FloatNode, Vec3Node } from '../tsl-types';

export const CLOUD_LIQUID_BASE_M = 700;
export const CLOUD_LIQUID_EDGE_M = 300;
export const CLOUD_ICE_HALF_THICKNESS_M = 1_000;
export const CLOUD_ICE_EDGE_M = 400;
// 全描画経路が積分・殻の外縁に使う上限。液相detailと上層氷雲のどちらも収める。
export const CLOUD_DENSITY_TOP_M = CLOUD_TOP_SPAN + Math.max(
  CLOUD_DETAIL_TOP_RELIEF_M,
  CLOUD_ICE_HALF_THICKNESS_M,
);

export interface CloudDensitySample {
  readonly liquidFraction: FloatNode;
  readonly iceFraction: FloatNode;
  readonly liquidExtinctionPerM: FloatNode;
  readonly iceExtinctionPerM: FloatNode;
  readonly extinctionPerM: FloatNode;
  readonly liquidTopM: FloatNode;
}

function smoothstepScalar(edge0: number, edge1: number, value: number): number {
  if (value <= edge0) return 0;
  if (value >= edge1) return 1;
  const t = (value - edge0) / (edge1 - edge0);
  return t * t * (3 - 2 * t);
}

// CPU基準。edgeは上下それぞれの滑らかな遷移幅。top-bottom >= 2*edge を前提とする。
export function cloudLayerFractionAtAltitude(
  altitudeM: number, bottomM: number, topM: number, edgeM: number,
): number {
  if (![altitudeM, bottomM, topM, edgeM].every(Number.isFinite)
    || edgeM < 0 || topM <= bottomM || topM - bottomM < 2 * edgeM) {
    throw new RangeError('invalid cloud layer interval');
  }
  const lower = smoothstepScalar(bottomM, bottomM + edgeM, altitudeM);
  const upper = 1 - smoothstepScalar(topM - edgeM, topM, altitudeM);
  return lower * upper;
}

// smoothstepの積分値は各edgeでedge/2なので、非重複の上下edgeを含む層の積分厚は depth-edge。
export function cloudLayerNormalizationM(bottomM: number, topM: number, edgeM: number): number {
  if (![bottomM, topM, edgeM].every(Number.isFinite)
    || edgeM < 0 || topM <= bottomM || topM - bottomM < 2 * edgeM) {
    throw new RangeError('invalid cloud layer interval');
  }
  return topM - bottomM - edgeM;
}

export function cloudColumnExtinctionAtAltitude(
  columnOpticalDepth: number, altitudeM: number, bottomM: number, topM: number, edgeM: number,
): number {
  if (!Number.isFinite(columnOpticalDepth) || columnOpticalDepth < 0) {
    throw new RangeError('columnOpticalDepth must be finite and non-negative');
  }
  return columnOpticalDepth
    * cloudLayerFractionAtAltitude(altitudeM, bottomM, topM, edgeM)
    / cloudLayerNormalizationM(bottomM, topM, edgeM);
}

export class CloudDensityEvaluator {
  private readonly detail: CloudDetailField;

  public constructor(surfaceRadiusM: FloatNode) {
    this.detail = new CloudDetailField(surfaceRadiusM);
  }

  // 液相の局所雲頂。2 km detailは高度を再配分するだけで、柱のtauはこの関数では変えない。
  public liquidTopM(
    field: CloudSample, direction: Vec3Node, footprintM: FloatNode,
  ): FloatNode {
    const detail = this.detail.sample(direction, field.cloudTop, footprintM);
    return clamp(
      field.cloudTop.add(detail.topReliefM),
      CLOUD_LIQUID_BASE_M + 2 * CLOUD_LIQUID_EDGE_M,
      CLOUD_TOP_SPAN + CLOUD_DETAIL_TOP_RELIEF_M,
    );
  }

  public sample(
    field: CloudSample, direction: Vec3Node, altitudeM: FloatNode, footprintM: FloatNode,
  ): CloudDensitySample {
    const liquidTopM = this.liquidTopM(field, direction, footprintM).toVar();
    const liquidVertical = smoothstep(
      CLOUD_LIQUID_BASE_M,
      CLOUD_LIQUID_BASE_M + CLOUD_LIQUID_EDGE_M,
      altitudeM,
    ).mul(
      smoothstep(
        liquidTopM.sub(CLOUD_LIQUID_EDGE_M),
        liquidTopM,
        altitudeM,
      ).oneMinus(),
    ).toVar();
    const liquidFraction = liquidVertical.mul(clamp(field.coverage, 0, 1));

    const iceBottomM = field.iceCenter.sub(CLOUD_ICE_HALF_THICKNESS_M).toVar();
    const iceTopM = field.iceCenter.add(CLOUD_ICE_HALF_THICKNESS_M).toVar();
    const iceVertical = smoothstep(
      iceBottomM,
      iceBottomM.add(CLOUD_ICE_EDGE_M),
      altitudeM,
    ).mul(
      smoothstep(
        iceTopM.sub(CLOUD_ICE_EDGE_M),
        iceTopM,
        altitudeM,
      ).oneMinus(),
    ).toVar();
    const iceFraction = iceVertical.mul(clamp(field.iceOpticalDepth, 0, 1));

    // detailでtopが動いても、正規化厚を同時に変えるため鉛直積分したtauは保存される。
    const liquidNormalizationM = max(
      liquidTopM.sub(CLOUD_LIQUID_BASE_M + CLOUD_LIQUID_EDGE_M),
      1,
    );
    const iceNormalizationM = float(
      2 * CLOUD_ICE_HALF_THICKNESS_M - CLOUD_ICE_EDGE_M,
    );
    const liquidExtinctionPerM = columnOpticalDepthFromCoverageNode(field.coverage)
      .mul(liquidVertical).div(liquidNormalizationM);
    const iceExtinctionPerM = max(field.iceOpticalDepth, 0)
      .mul(iceVertical).div(iceNormalizationM);
    return {
      liquidFraction,
      iceFraction,
      liquidExtinctionPerM,
      iceExtinctionPerM,
      extinctionPerM: liquidExtinctionPerM.add(iceExtinctionPerM),
      liquidTopM,
    };
  }
}
