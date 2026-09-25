// 球面イベント材料を明示面積で局所格子へ写すadapterの収支と適用域を検査する。
import * as assert from 'node:assert/strict';
import { v3 } from '../../src/math/vec3';
import type { CloudEventMaterialCohorts, CloudIceMaterialCohort, CloudMaterialTrack } from '../../src/game/cloud/cloud-event-transport';
import {
  depositCloudEventMaterialCohorts,
  type CloudEventFootprintAreas,
  type CloudEventTangentChart,
} from '../../src/game/cloud/cloud-event-local-deposition';
import type { CloudFootprintGrid } from '../../src/game/cloud/cloud-footprint-overlap';
import type { CloudMassGrid } from '../../src/game/cloud/cloud-mass-deposition';
import { test } from '../harness';

const CENTER = v3(0, 0, 1);
const CHART: CloudEventTangentChart = {
  centerDirectionUnitVector: CENTER,
  eastUnitVector: v3(1, 0, 0),
  northUnitVector: v3(0, 1, 0),
  sphereRadiusM: 1_000,
  maxAngularDistanceRad: 0.25,
};
const FOOTPRINT_GRID: CloudFootprintGrid = {
  originEastM: -1, originNorthM: -1, cellWidthM: 1, cellHeightM: 1, width: 2, height: 2,
};
const MASS_GRID: CloudMassGrid = {
  cells: Array.from({ length: 4 }, () => ({ areaM2: 1 })),
  layerEdgesM: [0, 100, 500],
};

function track(massKgM2: number, directionUnitVector = CENTER, geometricHeightM = 50): CloudMaterialTrack {
  return { directionUnitVector, geometricHeightM, massKgM2, steps: 0 };
}

function iceCohort(
  massKgM2: number,
  cohortIndex = 0,
  directionUnitVector = CENTER,
  geometricHeightM = 150,
): CloudIceMaterialCohort {
  return {
    ...track(massKgM2, directionUnitVector, geometricHeightM),
    cohortIndex,
    releaseStartTimeSeconds: 0,
    releaseEndTimeSeconds: 1,
    meanReleaseTimeSeconds: 0.5,
  };
}

function material(
  parent: CloudMaterialTrack | null = track(2),
  releasedIceCohorts: readonly CloudIceMaterialCohort[] = [iceCohort(3)],
): CloudEventMaterialCohorts {
  return {
    parent,
    releasedIceCohorts,
    totalMassKgM2: (parent?.massKgM2 ?? 0)
      + releasedIceCohorts.reduce((total, cohort) => total + cohort.massKgM2, 0),
  };
}

function integratedMassKg(columnsKgM2: readonly number[], grid: CloudMassGrid): number {
  return columnsKgM2.reduce((total, columnKgM2, index) => total + columnKgM2 * grid.cells[index]!.areaM2, 0);
}

function footprintAreas(
  parentLiquidM2: number | null = Math.PI,
  releasedIceCohortAreasM2: readonly number[] = [Math.PI],
): CloudEventFootprintAreas {
  return {
    parentLiquidM2,
    releasedIceCohorts: releasedIceCohortAreasM2.map((areaM2, cohortIndex) => ({ cohortIndex, areaM2 })),
  };
}

export function register(): void {
  test('cloud event local deposition: source-area-scaled liquid and ice conserve mass in altitude layers', () => {
    const result = depositCloudEventMaterialCohorts(
      material(), 2, footprintAreas(), CHART, FOOTPRINT_GRID, MASS_GRID,
    );
    const lower = result.columnsByLayer[0]!;
    const upper = result.columnsByLayer[1]!;
    assert.deepEqual(lower.liquidKgM2ByCell, [1, 1, 1, 1]);
    assert.deepEqual(lower.iceKgM2ByCell, [0, 0, 0, 0]);
    assert.deepEqual(upper.liquidKgM2ByCell, [0, 0, 0, 0]);
    assert.deepEqual(upper.iceKgM2ByCell, [1.5, 1.5, 1.5, 1.5]);
    assert.ok(result.unassignedMassKgByPhase.liquid < 1e-13);
    assert.ok(result.unassignedMassKgByPhase.ice < 1e-13);
    assert.equal(integratedMassKg(lower.liquidKgM2ByCell, MASS_GRID), 4);
    assert.ok(Math.abs(integratedMassKg(upper.iceKgM2ByCell, MASS_GRID) - 6) < 1e-14);
  });

  test('cloud event local deposition: source area and footprint area remain independent', () => {
    const result = depositCloudEventMaterialCohorts(
      material(track(2), []), 2, footprintAreas(Math.PI, []), CHART, FOOTPRINT_GRID, MASS_GRID,
    );
    const assigned = integratedMassKg(result.columnsByLayer[0]!.liquidKgM2ByCell, MASS_GRID);
    assert.ok(Math.abs(assigned - 4) < 1e-13);
    assert.notEqual(assigned, 2 * Math.PI, '1 m² surrogate is scaled by source area, not footprint area');
  });

  test('cloud event local deposition: footprint areas follow cohort identity after area-input reordering', () => {
    const eastern = v3(Math.sin(0.01), 0, Math.cos(0.01));
    const western = v3(-Math.sin(0.01), 0, Math.cos(0.01));
    const ice = [iceCohort(1, 7, eastern), iceCohort(2, 9, western)];
    const cohortMaterial = material(null, ice);
    const areas: CloudEventFootprintAreas = {
      parentLiquidM2: null,
      releasedIceCohorts: [
        { cohortIndex: 9, areaM2: 4 * Math.PI },
        { cohortIndex: 7, areaM2: Math.PI },
      ],
    };
    const localGrid: CloudFootprintGrid = {
      ...FOOTPRINT_GRID, originEastM: -15, originNorthM: -15, width: 30, height: 30,
    };
    const largeGrid: CloudMassGrid = {
      cells: Array.from({ length: 900 }, () => ({ areaM2: 1 })), layerEdgesM: [0, 500],
    };
    const result = depositCloudEventMaterialCohorts(
      cohortMaterial, 1, areas, CHART,
      localGrid, largeGrid,
    );
    const iceColumns = result.columnsByLayer[0]!.iceKgM2ByCell;
    const rightHemisphereMassKg = iceColumns.reduce((total, columnKgM2, index) => {
      const column = index % localGrid.width;
      const cellCenterEastM = localGrid.originEastM + (column + 0.5) * localGrid.cellWidthM;
      return cellCenterEastM > 0 ? total + columnKgM2 : total;
    }, 0);
    const leftHemisphereMassKg = integratedMassKg(iceColumns, largeGrid) - rightHemisphereMassKg;
    assert.ok(Math.abs(rightHemisphereMassKg - 1) < 1e-12, 'cohort 7 remains in the eastern hemisphere');
    assert.ok(Math.abs(leftHemisphereMassKg - 2) < 1e-12, 'cohort 9 remains in the western hemisphere');
    const eastQuarterCellIndex = 15 * localGrid.width + 25;
    const westInteriorCellIndex = 15 * localGrid.width + 5;
    assert.ok(Math.abs(iceColumns[eastQuarterCellIndex]! - 0.25) < 1e-12,
      'cohort 7 uses its π m² footprint');
    assert.ok(Math.abs(iceColumns[westInteriorCellIndex]! - 1 / (2 * Math.PI)) < 1e-12,
      'cohort 9 uses its 4π m² footprint');
  });

  test('cloud event local deposition: a clipped local grid returns the remaining event mass', () => {
    const footprintGrid: CloudFootprintGrid = {
      originEastM: 0, originNorthM: -0.5, cellWidthM: 1, cellHeightM: 1, width: 1, height: 1,
    };
    const massGrid: CloudMassGrid = { cells: [{ areaM2: 1 }], layerEdgesM: [0, 100] };
    const result = depositCloudEventMaterialCohorts(
      material(track(2), []), 2, footprintAreas(Math.PI, []), CHART, footprintGrid, massGrid,
    );
    const assigned = integratedMassKg(result.columnsByLayer[0]!.liquidKgM2ByCell, massGrid);
    assert.ok(assigned > 0);
    assert.ok(result.unassignedMassKgByPhase.liquid > 0);
    assert.ok(Math.abs(assigned + result.unassignedMassKgByPhase.liquid - 4) < 1e-13);
  });

  test('cloud event local deposition: spherical centers project by fixed surface radius independent of altitude', () => {
    const angleRad = 0.01;
    const eastward = v3(Math.sin(angleRad), 0, Math.cos(angleRad));
    const footprintGrid: CloudFootprintGrid = {
      originEastM: 8, originNorthM: -1, cellWidthM: 1, cellHeightM: 1, width: 4, height: 2,
    };
    const massGrid: CloudMassGrid = {
      cells: Array.from({ length: 8 }, () => ({ areaM2: 1 })), layerEdgesM: [0, 100, 500],
    };
    const lower = depositCloudEventMaterialCohorts(
      material(track(1, eastward, 1), []), 1, footprintAreas(Math.PI, []), CHART,
      footprintGrid, massGrid,
    );
    const upper = depositCloudEventMaterialCohorts(
      material(track(1, eastward, 400), []), 1, footprintAreas(Math.PI, []), CHART,
      footprintGrid, massGrid,
    );
    assert.deepEqual(lower.columnsByLayer[0]!.liquidKgM2ByCell,
      upper.columnsByLayer[1]!.liquidKgM2ByCell);
  });

  test('cloud event local deposition: antipodal and beyond-domain footprints are rejected', () => {
    assert.throws(() => depositCloudEventMaterialCohorts(
      material(track(1, v3(0, 0, -1)), []), 1, footprintAreas(Math.PI, []), CHART,
      FOOTPRINT_GRID, MASS_GRID,
    ), RangeError);
    const nearLimit = v3(Math.sin(0.24), 0, Math.cos(0.24));
    assert.throws(() => depositCloudEventMaterialCohorts(
      material(track(1, nearLimit), []), 1, footprintAreas(400 * Math.PI, []), CHART,
      FOOTPRINT_GRID, MASS_GRID,
    ), RangeError);
  });

  test('cloud event local deposition: invalid patch basis and missing explicit areas are rejected', () => {
    assert.throws(() => depositCloudEventMaterialCohorts(
      material(), 2, footprintAreas(), { ...CHART, northUnitVector: v3(1, 0, 0) },
      FOOTPRINT_GRID, MASS_GRID,
    ), RangeError);
    assert.throws(() => depositCloudEventMaterialCohorts(
      material(), 2, footprintAreas(), { ...CHART, eastUnitVector: v3(1.001, 0, 0) },
      FOOTPRINT_GRID, MASS_GRID,
    ), RangeError);
    assert.throws(() => depositCloudEventMaterialCohorts(
      material(), 2, footprintAreas(), { ...CHART, maxAngularDistanceRad: Math.PI / 2 },
      FOOTPRINT_GRID, MASS_GRID,
    ), RangeError);
    assert.throws(() => depositCloudEventMaterialCohorts(
      material(), 2, footprintAreas(null), CHART, FOOTPRINT_GRID, MASS_GRID,
    ), RangeError);
    assert.throws(() => depositCloudEventMaterialCohorts(
      material(null, [iceCohort(3)]), 2, footprintAreas(Math.PI), CHART,
      FOOTPRINT_GRID, MASS_GRID,
    ), RangeError);
    assert.throws(() => depositCloudEventMaterialCohorts(
      material(), 2, footprintAreas(Math.PI, []), CHART, FOOTPRINT_GRID, MASS_GRID,
    ), RangeError);
    assert.throws(() => depositCloudEventMaterialCohorts(
      material(), 0, footprintAreas(), CHART, FOOTPRINT_GRID, MASS_GRID,
    ), RangeError);
    assert.throws(() => depositCloudEventMaterialCohorts(
      { ...material(), totalMassKgM2: 99 }, 2, footprintAreas(), CHART,
      FOOTPRINT_GRID, MASS_GRID,
    ), RangeError);
    assert.throws(() => depositCloudEventMaterialCohorts(
      material(), 2, footprintAreas(), CHART, FOOTPRINT_GRID,
      { ...MASS_GRID, cells: MASS_GRID.cells.map((cell, index) => ({
        areaM2: index === 0 ? cell.areaM2 + 0.01 : cell.areaM2,
      })) },
    ), RangeError);
    assert.throws(() => depositCloudEventMaterialCohorts(
      material(null, []), 2, footprintAreas(null, []), CHART,
      { ...FOOTPRINT_GRID, width: 0 }, { ...MASS_GRID, cells: [] },
    ), RangeError);
  });
}
