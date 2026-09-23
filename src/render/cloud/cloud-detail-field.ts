// 雲のマクロ場より細かい、物理距離基準の解析的3D detail。テクスチャを追加確保せず、
// 天体固定方向と高度から連続なノイズを評価するため、cap の継ぎ目や固定 shell の縞を作らない。
import { smoothstep } from 'three/tsl';
import { gradientNoise } from './gradient-noise';
import type { FloatNode, Vec3Node } from '../tsl-types';

// 標準品質で残す最小の構造スケール[m]。Step 3 の2 km実証値。
export const CLOUD_DETAIL_SCALE_M = 2_000;
// 2 km 構造は standard 近距離で少なくとも4標本を要求するため、500 m/px 以下で全振幅。
// 1 km/px は2 km波長のNyquist限界なので、そこまでに0へ落として未解像 detail のaliasを防ぐ。
export const CLOUD_DETAIL_FULL_FOOTPRINT_M = CLOUD_DETAIL_SCALE_M / 4;
export const CLOUD_DETAIL_FADE_FOOTPRINT_M = CLOUD_DETAIL_SCALE_M / 2;
// 2 km水平構造が雲頂へ与える最大起伏[m]。柱の光学量は変えず、高度方向へ再配分するだけにする。
export const CLOUD_DETAIL_TOP_RELIEF_M = 900;

export interface CloudDetailSample {
  readonly noise: FloatNode;
  readonly amplitude: FloatNode;
  readonly topReliefM: FloatNode;
}

function smoothstepScalar(edge0: number, edge1: number, value: number): number {
  if (value <= edge0) return 0;
  if (value >= edge1) return 1;
  const t = (value - edge0) / (edge1 - edge0);
  return t * t * (3 - 2 * t);
}

// CPU側のLOD判定・テスト用。GPU版と同じ区間・補間式。
export function cloudDetailAmplitudeForFootprintM(footprintM: number): number {
  if (!Number.isFinite(footprintM) || footprintM < 0) {
    throw new RangeError('footprintM must be finite and non-negative');
  }
  return 1 - smoothstepScalar(
    CLOUD_DETAIL_FULL_FOOTPRINT_M,
    CLOUD_DETAIL_FADE_FOOTPRINT_M,
    footprintM,
  );
}

export class CloudDetailField {
  public constructor(private readonly surfaceRadiusM: FloatNode) {}

  // directionは天体固定の単位方向、altitudeMは地表からの高度、footprintMは標本が代表する実寸。
  // direction*(R+h) を2 kmで割った3D座標を使うので、緯度経度の極・日付変更線に特異点を持たない。
  public sample(direction: Vec3Node, altitudeM: FloatNode, footprintM: FloatNode): CloudDetailSample {
    const position = direction.mul(this.surfaceRadiusM.add(altitudeM).div(CLOUD_DETAIL_SCALE_M));
    const amplitude = smoothstep(
      CLOUD_DETAIL_FULL_FOOTPRINT_M,
      CLOUD_DETAIL_FADE_FOOTPRINT_M,
      footprintM,
    ).oneMinus();
    const noise = gradientNoise(position).mul(amplitude);
    return {
      noise,
      amplitude,
      topReliefM: noise.mul(CLOUD_DETAIL_TOP_RELIEF_M),
    };
  }
}
