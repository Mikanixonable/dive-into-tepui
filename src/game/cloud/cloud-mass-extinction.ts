// 高度層別の質量列を、外から指定された粒径・氷粒子の消散効率で可視光の消散へ変換する。
// 層内は鉛直方向に一様な近似。水平構造、未解像被覆、斜め光路はここで仮定しない。

import { iceOpticalDepth, liquidOpticalDepth } from '../../physics/cloud-optical-closures';
import type { CloudMassDeposition } from './cloud-mass-deposition';

export interface CloudLayerMicrophysics {
  readonly liquidEffectiveRadiusM: number;
  readonly iceEffectiveRadiusM: number;
  readonly iceExtinctionEfficiency: number;
}

export interface CloudExtinctionLayer {
  readonly lowerAltitudeM: number;
  readonly upperAltitudeM: number;
  readonly liquidPerMByCell: readonly number[];
  readonly icePerMByCell: readonly number[];
}

function requirePositiveFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be finite and positive`);
}

function extinctionByCell(
  columnsKgM2: readonly number[],
  layerDepthM: number,
  opticalDepth: (columnKgM2: number) => number,
): number[] {
  return columnsKgM2.map((columnKgM2) => {
    if (!Number.isFinite(columnKgM2) || columnKgM2 < 0) {
      throw new RangeError('cloud mass column must be finite and non-negative');
    }
    const extinctionPerM = opticalDepth(columnKgM2) / layerDepthM;
    if (!Number.isFinite(extinctionPerM)) throw new RangeError('cloud extinction must be finite');
    return extinctionPerM;
  });
}

// 入力粒径は相・高度層ごとに明示する。零質量でも既定粒径を暗黙に選ばない。
export function extinctionFromCloudMass(
  deposition: CloudMassDeposition,
  microphysicsByLayer: readonly CloudLayerMicrophysics[],
): readonly CloudExtinctionLayer[] {
  if (microphysicsByLayer.length !== deposition.columnsByLayer.length) {
    throw new RangeError('one microphysics record is required for each cloud layer');
  }
  return deposition.columnsByLayer.map((layer, index) => {
    const microphysics = microphysicsByLayer[index]!;
    requirePositiveFinite(microphysics.liquidEffectiveRadiusM, 'liquidEffectiveRadiusM');
    requirePositiveFinite(microphysics.iceEffectiveRadiusM, 'iceEffectiveRadiusM');
    requirePositiveFinite(microphysics.iceExtinctionEfficiency, 'iceExtinctionEfficiency');
    if (layer.liquidKgM2ByCell.length !== layer.iceKgM2ByCell.length) {
      throw new RangeError('liquid and ice columns must have the same cell count');
    }
    const layerDepthM = layer.upperAltitudeM - layer.lowerAltitudeM;
    requirePositiveFinite(layerDepthM, 'layerDepthM');
    return {
      lowerAltitudeM: layer.lowerAltitudeM,
      upperAltitudeM: layer.upperAltitudeM,
      liquidPerMByCell: extinctionByCell(
        layer.liquidKgM2ByCell, layerDepthM,
        (columnKgM2) => liquidOpticalDepth(columnKgM2, microphysics.liquidEffectiveRadiusM),
      ),
      icePerMByCell: extinctionByCell(
        layer.iceKgM2ByCell, layerDepthM,
        (columnKgM2) => iceOpticalDepth(
          columnKgM2, microphysics.iceEffectiveRadiusM, microphysics.iceExtinctionEfficiency,
        ),
      ),
    };
  });
}
