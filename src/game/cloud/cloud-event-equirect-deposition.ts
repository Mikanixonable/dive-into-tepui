// 球面上で輸送したイベント材料を、明示した source 面積と footprint 形状で全球
// 正距円筒格子へ分配する堆積 adapter。
// 実際のセル面積は格子が行の緯度帯で積分した値 — footprint の面積から比率で材料質量を
// 触れたセルへ分け、載らなかった分(格子外・被覆不足)は unassignedMassKgByPhase へ返す。
// 分配はすでに届いた確定積算へ加える — セル累積は caller(全球場供給)が持つ。

import { len } from '../../math/vec3';
import type { Vec3 } from '../../math/vec3';
import type { CloudEventMaterialCohorts } from './cloud-event-transport';
import {
  cloudEventMaterialParcels,
  depositedMassKgByPhase,
  expectedMaterialMassByPhaseKg,
  footprintEllipseAtBasis,
  validateDepositedMassBalance,
  type CloudEventFootprintShape,
  type CloudEventFootprintShapes,
} from './cloud-event-deposition';
import {
  cloudEquirectCellAreaM2,
  cloudEquirectFootprintOverlap,
  cloudEquirectTangentBasisAt,
  validateCloudEquirectGrid,
  type CloudEquirectGrid,
} from './cloud-equirect-grid';
import {
  depositCloudParcelMass,
  type CloudMassDeposition,
  type CloudMassGrid,
  type CloudMassParcel,
  type CloudMassPhase,
} from './cloud-mass-deposition';
import type { CloudFootprintEllipse } from './cloud-footprint-overlap';

function requireFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
}

function requirePositive(value: number, name: string): void {
  requireFinite(value, name);
  if (value <= 0) throw new RangeError(`${name} must be positive`);
}

const VECTOR_TOLERANCE = 1e-10;

function validateUnitVector(vector: Vec3, name: string): void {
  requireFinite(vector.x, `${name}.x`);
  requireFinite(vector.y, `${name}.y`);
  requireFinite(vector.z, `${name}.z`);
  if (Math.abs(len(vector) - 1) > VECTOR_TOLERANCE) {
    throw new RangeError(`${name} must be a unit vector`);
  }
}

function validateMassGrid(grid: CloudMassGrid, equirectGrid: CloudEquirectGrid): void {
  if (grid.cells.length !== equirectGrid.width * equirectGrid.height) {
    throw new RangeError('mass grid cells must match the equirect grid dimensions');
  }
  for (const [index, cell] of grid.cells.entries()) {
    requirePositive(cell.areaM2, `grid.cells[${index}].areaM2`);
    const expectedAreaM2 = cloudEquirectCellAreaM2(
      equirectGrid, Math.floor(index / equirectGrid.width));
    // 正距円筒のセル面積は緯度帯の積分で定まるので、質量格子の記録と同じ値を要する。
    const toleranceM2 = 32 * Number.EPSILON * Math.max(cell.areaM2, expectedAreaM2);
    if (Math.abs(cell.areaM2 - expectedAreaM2) > toleranceM2) {
      throw new RangeError('mass grid cell area must match the equirect cell area');
    }
  }
}

// 全球格子の永続な堆積宛先。イベント間で継ぎ越す累積場は caller が組み立てて一度だけ検算する。
export interface CloudEquirectDepositionTarget {
  readonly equirectGrid: CloudEquirectGrid;
  readonly massGrid: CloudMassGrid;
}

// 宛先の格子どうしが一致しているかを1度だけ検算する。イベントごとの再検算は行わない。
export function prepareCloudEquirectDepositionTarget(
  equirectGrid: CloudEquirectGrid,
  massGrid: CloudMassGrid,
): CloudEquirectDepositionTarget {
  validateCloudEquirectGrid(equirectGrid);
  validateMassGrid(massGrid, equirectGrid);
  return { equirectGrid, massGrid };
}

// adapter が前へ返す堆積。層別質量の堆積に、footprint が触れたセル index の集合を併せたもの。
export interface CloudEventEquirectDeposition extends CloudMassDeposition {
  readonly touchedCellIndices: readonly number[];
}

// 材料1単位の parcel を組み立てる。footprint は材料の方向を中心に接平面へ置き、
// 覆うセルは全球格子の副セル被覆で求める。
function makeParcel(
  phase: CloudMassPhase,
  massKgM2: number,
  directionUnitVector: Vec3,
  geometricHeightM: number,
  footprintShape: CloudEventFootprintShape,
  sourceAreaM2: number,
  equirectGrid: CloudEquirectGrid,
): CloudMassParcel {
  requireFinite(massKgM2, 'massKgM2');
  if (massKgM2 < 0) throw new RangeError('massKgM2 must be non-negative');
  const massKg = massKgM2 * sourceAreaM2;
  requireFinite(massKg, 'massKg');
  validateUnitVector(directionUnitVector, 'directionUnitVector');
  requireFinite(geometricHeightM, 'geometricHeightM');
  if (geometricHeightM < 0) throw new RangeError('geometricHeightM must be non-negative');
  const { eastUnitVector, northUnitVector } = cloudEquirectTangentBasisAt(directionUnitVector);
  const ellipse = footprintEllipseAtBasis(footprintShape, eastUnitVector, northUnitVector);
  const footprint: CloudFootprintEllipse = {
    eastM: 0,
    northM: 0,
    majorRadiusM: ellipse.majorRadiusM,
    minorRadiusM: ellipse.minorRadiusM,
    majorAxisAzimuthRad: ellipse.majorAxisAzimuthRad,
  };
  const coverage = cloudEquirectFootprintOverlap(directionUnitVector, footprint, equirectGrid);
  return {
    phase,
    massKg,
    altitudeM: geometricHeightM,
    footprintAreaM2: coverage.footprintAreaM2,
    overlaps: coverage.overlaps,
  };
}

// イベント材料を全球格子へ分配し、層別列質量と触れたセルを返す。target を渡すと
// 格子検算を省く(供給経路)。診断経路は target を渡さず、呼び出しのたびに格子を検算する。
export function depositCloudEventMaterialCohortsEquirect(
  material: CloudEventMaterialCohorts,
  sourceAreaM2: number,
  footprintShapes: CloudEventFootprintShapes,
  equirectGrid: CloudEquirectGrid,
  massGrid: CloudMassGrid,
  target?: CloudEquirectDepositionTarget,
): CloudEventEquirectDeposition {
  if (target !== undefined
    && (target.equirectGrid !== equirectGrid || target.massGrid !== massGrid)) {
    throw new RangeError('target must describe the same equirect and mass grids');
  }
  if (target === undefined) {
    validateCloudEquirectGrid(equirectGrid);
    validateMassGrid(massGrid, equirectGrid);
  }
  const { parcels, touchedCellIndices } = cloudEventMaterialParcels(
    material, sourceAreaM2, footprintShapes,
    (phase, massKgM2, directionUnitVector, geometricHeightM, footprintShape) =>
      makeParcel(
        phase, massKgM2, directionUnitVector, geometricHeightM, footprintShape,
        sourceAreaM2, equirectGrid));

  const deposition = depositCloudParcelMass(parcels, massGrid);
  validateDepositedMassBalance(
    expectedMaterialMassByPhaseKg(material, sourceAreaM2),
    depositedMassKgByPhase(deposition, massGrid, touchedCellIndices),
  );
  return {
    columnsByLayer: deposition.columnsByLayer,
    unassignedMassKgByPhase: deposition.unassignedMassKgByPhase,
    touchedCellIndices,
  };
}
