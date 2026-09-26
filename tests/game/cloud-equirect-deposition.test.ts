// 全球正距円筒格子への堆積の、面積収支・極/日付変更線の適用域・決定性を検査する。
import * as assert from 'node:assert/strict';
import { v3 } from '../../src/math/vec3';
import type { Vec3 } from '../../src/math/vec3';
import {
  cloudEquirectCellAreaM2,
  cloudEquirectCellCenter,
  cloudEquirectCellIndex,
  cloudEquirectFootprintOverlap,
  type CloudEquirectGrid,
} from '../../src/game/cloud/cloud-equirect-grid';
import {
  depositCloudEventMaterialCohortsEquirect,
  prepareCloudEquirectDepositionTarget,
} from '../../src/game/cloud/cloud-event-equirect-deposition';
import type {
  CloudEventMaterialCohorts,
  CloudIceMaterialCohort,
  CloudMaterialTrack,
} from '../../src/game/cloud/cloud-event-transport';
import type {
  CloudEventFootprintShape,
  CloudEventFootprintShapes,
} from '../../src/game/cloud/cloud-event-local-deposition';
import type { CloudMassGrid } from '../../src/game/cloud/cloud-mass-deposition';
import { test } from '../harness';

const SPHERE_RADIUS_M = 6_371_000;
// 0.5° 格子。赤道のセルは東西・南北とも約 55.6 km。
const GRID: CloudEquirectGrid = { width: 720, height: 360, sphereRadiusM: SPHERE_RADIUS_M };

function makeMassGrid(layerEdgesM: readonly number[] = [0, 3_000, 9_000]): CloudMassGrid {
  return {
    cells: Array.from({ length: GRID.width * GRID.height }, (_, index) => ({
      areaM2: cloudEquirectCellAreaM2(GRID, Math.floor(index / GRID.width)),
    })),
    layerEdgesM,
  };
}

function directionAtDeg(latitudeDeg: number, longitudeDeg: number): Vec3 {
  const latitudeRad = latitudeDeg * Math.PI / 180;
  const longitudeRad = longitudeDeg * Math.PI / 180;
  const flat = Math.cos(latitudeRad);
  return v3(flat * Math.sin(longitudeRad), Math.sin(latitudeRad), flat * Math.cos(longitudeRad));
}

function track(massKgM2: number, directionUnitVector: Vec3, geometricHeightM: number): CloudMaterialTrack {
  return { directionUnitVector, geometricHeightM, massKgM2, steps: 0 };
}

function iceCohort(
  massKgM2: number, cohortIndex: number, directionUnitVector: Vec3, geometricHeightM: number,
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
  parent: CloudMaterialTrack | null,
  releasedIceCohorts: readonly CloudIceMaterialCohort[],
): CloudEventMaterialCohorts {
  return {
    parent,
    releasedIceCohorts,
    totalMassKgM2: (parent?.massKgM2 ?? 0)
      + releasedIceCohorts.reduce((total, cohort) => total + cohort.massKgM2, 0),
  };
}

// 等半径の円として面積だけを指定する形状。
function circleOfRadiusM(radiusM: number): CloudEventFootprintShape {
  return { isotropicRadiusM: radiusM, elongationVectorsM: [] };
}

function integratedMassKg(columnsKgM2: readonly number[], grid: CloudMassGrid): number {
  return columnsKgM2.reduce(
    (total, columnKgM2, index) => total + columnKgM2 * grid.cells[index]!.areaM2, 0);
}

export function register(): void {
  test('equirect grid: band cell areas sum to the full sphere area and shrink toward the pole', () => {
    let totalAreaM2 = 0;
    for (let row = 0; row < GRID.height; row += 1) {
      totalAreaM2 += cloudEquirectCellAreaM2(GRID, row) * GRID.width;
    }
    const sphereAreaM2 = 4 * Math.PI * SPHERE_RADIUS_M * SPHERE_RADIUS_M;
    assert.ok(Math.abs(totalAreaM2 - sphereAreaM2) / sphereAreaM2 < 1e-12);
    const polarAreaM2 = cloudEquirectCellAreaM2(GRID, 0);
    const equatorAreaM2 = cloudEquirectCellAreaM2(GRID, GRID.height / 2);
    assert.ok(polarAreaM2 > 0);
    assert.ok(polarAreaM2 < equatorAreaM2 * 0.01);
  });

  test('equirect grid: a direction maps to its containing cell and back near its center', () => {
    const direction = v3(0, 0, 1);
    const index = cloudEquirectCellIndex(GRID, direction);
    assert.equal(index % GRID.width, 360);
    assert.equal(Math.floor(index / GRID.width), 180);
    const center = cloudEquirectCellCenter(GRID, index);
    const cosine = direction.x * center.x + direction.y * center.y + direction.z * center.z;
    const angleRad = Math.acos(Math.min(1, Math.max(-1, cosine)));
    assert.ok(angleRad < Math.PI / Math.min(GRID.width, GRID.height));
    // 日付変更線の両側は両端の列へ落ちる。
    assert.equal(cloudEquirectCellIndex(GRID, directionAtDeg(0, 179.9)) % GRID.width, GRID.width - 1);
    assert.equal(cloudEquirectCellIndex(GRID, directionAtDeg(0, -179.9)) % GRID.width, 0);
  });

  test('equirect deposition: a circular footprint assigns its area with small-cell accuracy', () => {
    const radiusM = 500_000;
    const coverage = cloudEquirectFootprintOverlap(
      v3(0, 0, 1), { eastM: 0, northM: 0, radiusM }, GRID);
    const footprintAreaM2 = Math.PI * radiusM * radiusM;
    assert.equal(coverage.footprintAreaM2, footprintAreaM2);
    const assignedAreaM2 = coverage.overlaps.reduce((total, overlap) => total + overlap.areaM2, 0);
    // セル中心判定の離散誤差は セル幅/半径 の程度に収まる。
    assert.ok(Math.abs(assignedAreaM2 - footprintAreaM2) / footprintAreaM2 < 0.15);
    assert.ok(coverage.overlaps.length > 100);
    for (const overlap of coverage.overlaps) {
      assert.ok(overlap.areaM2
        <= cloudEquirectCellAreaM2(GRID, Math.floor(overlap.cellIndex / GRID.width)));
    }
  });

  test('equirect deposition: an ellipse spreads along its major-axis azimuth', () => {
    const coverage = cloudEquirectFootprintOverlap(v3(0, 0, 1), {
      eastM: 0, northM: 0,
      majorRadiusM: 1_000_000, minorRadiusM: 250_000, majorAxisAzimuthRad: 0,
    }, GRID);
    const rows = new Set(coverage.overlaps.map((overlap) => Math.floor(overlap.cellIndex / GRID.width)));
    const columns = new Set(coverage.overlaps.map((overlap) => overlap.cellIndex % GRID.width));
    assert.ok(columns.size > 2 * rows.size,
      `columns ${columns.size} should exceed 2x rows ${rows.size}`);
  });

  test('equirect deposition: a footprint straddling the dateline wraps to both grid edges', () => {
    const direction = directionAtDeg(0, 179.7);
    const coverage = cloudEquirectFootprintOverlap(
      direction, { eastM: 0, northM: 0, radiusM: 500_000 }, GRID);
    const columns = new Set(coverage.overlaps.map((overlap) => overlap.cellIndex % GRID.width));
    assert.ok(columns.has(0), 'east edge columns should be covered');
    assert.ok(columns.has(GRID.width - 1), 'west edge columns should be covered');
  });

  test('equirect deposition: a footprint covering the pole fills the whole top row', () => {
    const direction = directionAtDeg(85, 0);
    const coverage = cloudEquirectFootprintOverlap(
      direction, { eastM: 0, northM: 0, radiusM: 800_000 }, GRID);
    const topRowCells = coverage.overlaps.filter(
      (overlap) => Math.floor(overlap.cellIndex / GRID.width) === 0);
    assert.equal(topRowCells.length, GRID.width);
    // 極側の小さいセルにも実面積で積まれる。
    const polarCellAreaM2 = cloudEquirectCellAreaM2(GRID, 0);
    for (const overlap of topRowCells) {
      assert.ok(overlap.areaM2 <= polarCellAreaM2 * (1 + 1e-9));
    }
  });

  test('equirect deposition: a footprint beyond the representable sphere leaves mass unassigned', () => {
    const radiusM = 1.5 * Math.PI * SPHERE_RADIUS_M;
    const massGrid = makeMassGrid();
    const deposition = depositCloudEventMaterialCohortsEquirect(
      material(track(2, v3(0, 0, 1), 100), []), 2,
      { parentLiquid: circleOfRadiusM(radiusM), releasedIceCohorts: [] },
      GRID, massGrid,
    );
    const expectedMassKg = 4;
    const assignedKg = integratedMassKg(deposition.columnsByLayer[0]!.liquidKgM2ByCell, massGrid);
    const unassignedKg = deposition.unassignedMassKgByPhase.liquid;
    // 接平面上の footprint のうち球面上に写せるのは全球分 4πR² だけ。
    const expectedAssignedFraction = 4 * Math.PI * SPHERE_RADIUS_M * SPHERE_RADIUS_M
      / (Math.PI * radiusM * radiusM);
    assert.ok(Math.abs(assignedKg / expectedMassKg - expectedAssignedFraction) < 0.02);
    assert.ok(unassignedKg > expectedMassKg * 0.5);
    assert.ok(Math.abs(assignedKg + unassignedKg - expectedMassKg) / expectedMassKg < 1e-10);
  });

  test('equirect deposition: liquid and ice conserve mass across altitude layers', () => {
    const massGrid = makeMassGrid();
    const cohorts = [iceCohort(3, 0, directionAtDeg(30, 0), 5_000)];
    const eventMaterial = material(track(2, v3(0, 0, 1), 100), cohorts);
    const shapes: CloudEventFootprintShapes = {
      parentLiquid: circleOfRadiusM(500_000),
      releasedIceCohorts: [{ cohortIndex: 0, shape: circleOfRadiusM(500_000) }],
    };
    const deposition = depositCloudEventMaterialCohortsEquirect(
      eventMaterial, 1_000_000, shapes, GRID, massGrid);
    const liquidKg = integratedMassKg(deposition.columnsByLayer[0]!.liquidKgM2ByCell, massGrid)
      + deposition.unassignedMassKgByPhase.liquid;
    const iceKg = integratedMassKg(deposition.columnsByLayer[1]!.iceKgM2ByCell, massGrid)
      + deposition.unassignedMassKgByPhase.ice;
    assert.ok(Math.abs(liquidKg - 2_000_000) / 2_000_000 < 1e-10);
    assert.ok(Math.abs(iceKg - 3_000_000) / 3_000_000 < 1e-10);
    // 氷は別の方向へ置かれるので、親液水が載った赤道直下のセルには氷が来ない。
    const parentIndex = cloudEquirectCellIndex(GRID, v3(0, 0, 1));
    assert.equal(deposition.columnsByLayer[1]!.iceKgM2ByCell[parentIndex], 0);
  });

  test('equirect deposition: touched cells are exactly the cells that receive mass', () => {
    const massGrid = makeMassGrid();
    const cohorts = [iceCohort(3, 0, directionAtDeg(30, 0), 5_000)];
    const eventMaterial = material(track(2, v3(0, 0, 1), 100), cohorts);
    const shapes: CloudEventFootprintShapes = {
      parentLiquid: circleOfRadiusM(500_000),
      releasedIceCohorts: [{ cohortIndex: 0, shape: circleOfRadiusM(500_000) }],
    };
    const deposition = depositCloudEventMaterialCohortsEquirect(
      eventMaterial, 1_000_000, shapes, GRID, massGrid);
    const touched = new Set(deposition.touchedCellIndices);
    const nonzero = new Set<number>();
    for (const layer of deposition.columnsByLayer) {
      for (const [index, value] of layer.liquidKgM2ByCell.entries()) {
        if (value !== 0) nonzero.add(index);
      }
      for (const [index, value] of layer.iceKgM2ByCell.entries()) {
        if (value !== 0) nonzero.add(index);
      }
    }
    // 正の質量を持つイベントでは、質量のあるセルと触れたセルが一致する。
    assert.deepEqual(touched, nonzero);
    // 触れたセルだけ積分しても全質量が回収できる。
    let assignedKg = 0;
    for (const layer of deposition.columnsByLayer) {
      for (const index of touched) {
        assignedKg += (layer.liquidKgM2ByCell[index]! + layer.iceKgM2ByCell[index]!)
          * massGrid.cells[index]!.areaM2;
      }
    }
    const expectedKg = (2 + 3) * 1_000_000 - deposition.unassignedMassKgByPhase.liquid
      - deposition.unassignedMassKgByPhase.ice;
    assert.ok(Math.abs(assignedKg - expectedKg) / expectedKg < 1e-10);
  });

  test('equirect deposition: a prepared target deposits identically and mismatched targets throw', () => {
    const massGrid = makeMassGrid();
    const target = prepareCloudEquirectDepositionTarget(GRID, massGrid);
    const eventMaterial = material(track(2, v3(0, 0, 1), 100), []);
    const shapes: CloudEventFootprintShapes = {
      parentLiquid: circleOfRadiusM(500_000), releasedIceCohorts: [],
    };
    const prepared = depositCloudEventMaterialCohortsEquirect(
      eventMaterial, 4, shapes, GRID, massGrid, target);
    const plain = depositCloudEventMaterialCohortsEquirect(
      eventMaterial, 4, shapes, GRID, massGrid);
    assert.deepEqual(prepared, plain);
    // 別の格子や質量格子を指す target を渡すと投げる。
    const otherGrid: CloudEquirectGrid = { ...GRID, width: GRID.width / 2 };
    const otherTarget = prepareCloudEquirectDepositionTarget(otherGrid, {
      cells: Array.from({ length: otherGrid.width * otherGrid.height }, (_, index) => ({
        areaM2: cloudEquirectCellAreaM2(otherGrid, Math.floor(index / otherGrid.width)),
      })),
      layerEdgesM: [0, 3_000, 9_000],
    });
    assert.throws(() => depositCloudEventMaterialCohortsEquirect(
      eventMaterial, 4, shapes, GRID, massGrid, otherTarget), RangeError);
    assert.throws(() => depositCloudEventMaterialCohortsEquirect(
      eventMaterial, 4, shapes, GRID,
      { cells: [], layerEdgesM: [0, 3_000, 9_000] }, target), RangeError);
  });

  test('equirect deposition: the same input deposits identically', () => {
    const massGrid = makeMassGrid();
    const eventMaterial = material(track(2, v3(0, 0, 1), 100), [iceCohort(3, 0, directionAtDeg(80, 179), 5_000)]);
    const shapes: CloudEventFootprintShapes = {
      parentLiquid: circleOfRadiusM(500_000),
      releasedIceCohorts: [{ cohortIndex: 0, shape: circleOfRadiusM(800_000) }],
    };
    const first = depositCloudEventMaterialCohortsEquirect(eventMaterial, 4, shapes, GRID, massGrid);
    const second = depositCloudEventMaterialCohortsEquirect(eventMaterial, 4, shapes, GRID, massGrid);
    assert.deepEqual(first, second);
  });

  test('equirect deposition: invalid grid, direction, shapes, and mass grid are rejected', () => {
    const massGrid = makeMassGrid();
    const shapes: CloudEventFootprintShapes = {
      parentLiquid: circleOfRadiusM(500_000), releasedIceCohorts: [],
    };
    const eventMaterial = material(track(2, v3(0, 0, 1), 100), []);
    assert.throws(() => depositCloudEventMaterialCohortsEquirect(
      eventMaterial, 2, shapes, { ...GRID, width: 0 }, massGrid), RangeError);
    assert.throws(() => depositCloudEventMaterialCohortsEquirect(
      material(track(2, v3(0, 0, 2), 100), []), 2, shapes, GRID, massGrid), RangeError);
    assert.throws(() => depositCloudEventMaterialCohortsEquirect(
      { ...eventMaterial, totalMassKgM2: 99 }, 2, shapes, GRID, massGrid), RangeError);
    assert.throws(() => depositCloudEventMaterialCohortsEquirect(
      eventMaterial, 2, { parentLiquid: null, releasedIceCohorts: [] }, GRID, massGrid), RangeError);
    assert.throws(() => depositCloudEventMaterialCohortsEquirect(
      material(null, [iceCohort(3, 0, v3(0, 0, 1), 5_000)]), 2,
      { parentLiquid: null, releasedIceCohorts: [] }, GRID, massGrid), RangeError);
    assert.throws(() => depositCloudEventMaterialCohortsEquirect(
      eventMaterial, 2, shapes, GRID,
      { ...massGrid, cells: massGrid.cells.map((cell, index) => ({
        areaM2: index === 0 ? cell.areaM2 * 2 : cell.areaM2,
      })) }), RangeError);
    assert.throws(() => cloudEquirectFootprintOverlap(
      v3(0, 0, 1), { eastM: 0, northM: 0, majorRadiusM: 1, minorRadiusM: 2, majorAxisAzimuthRad: 0 },
      GRID), RangeError);
  });
}
