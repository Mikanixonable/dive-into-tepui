// 円形 footprint と局所接平面格子の交差面積・質量分配を検査する。
import * as assert from 'node:assert/strict';
import { cloudFootprintOverlap, type CloudFootprintCircle, type CloudFootprintGrid } from '../../src/game/cloud/cloud-footprint-overlap';
import { depositCloudParcelMass } from '../../src/game/cloud/cloud-mass-deposition';
import { test } from '../harness';

const UNIT_CIRCLE: CloudFootprintCircle = { eastM: 0, northM: 0, radiusM: 1 };

function grid(
  originEastM: number,
  originNorthM: number,
  width: number,
  height: number,
  cellWidthM = 1,
  cellHeightM = 1,
): CloudFootprintGrid {
  return { originEastM, originNorthM, width, height, cellWidthM, cellHeightM };
}

function overlapAreaM2(overlaps: readonly { readonly areaM2: number }[]): number {
  return overlaps.reduce((total, overlap) => total + overlap.areaM2, 0);
}

function withinRelativeError(actual: number, expected: number, relativeTolerance = 1e-10): void {
  assert.ok(Math.abs(actual - expected) <= Math.abs(expected) * relativeTolerance,
    `actual ${actual} should match ${expected} within relative error ${relativeTolerance}`);
}

export function register(): void {
  test('cloud footprint overlap: analytic full, zero, half, and quarter disk oracles', () => {
    const full = cloudFootprintOverlap(UNIT_CIRCLE, grid(-1, -1, 2, 2));
    assert.equal(full.footprintAreaM2, Math.PI);
    withinRelativeError(overlapAreaM2(full.overlaps), Math.PI);

    assert.deepEqual(cloudFootprintOverlap(UNIT_CIRCLE, grid(2, 2, 1, 1)).overlaps, []);
    withinRelativeError(overlapAreaM2(
      cloudFootprintOverlap(UNIT_CIRCLE, grid(-1, 0, 2, 1)).overlaps,
    ), Math.PI / 2);
    withinRelativeError(overlapAreaM2(
      cloudFootprintOverlap(UNIT_CIRCLE, grid(0, 0, 1, 1)).overlaps,
    ), Math.PI / 4);
  });

  test('cloud footprint overlap: a straight boundary crossing agrees with exact semicircle area', () => {
    const coverage = cloudFootprintOverlap(UNIT_CIRCLE, grid(0, -1, 1, 2));
    withinRelativeError(overlapAreaM2(coverage.overlaps), Math.PI / 2);
    assert.deepEqual(coverage.overlaps.map(({ cellIndex }) => cellIndex), [0, 1]);
  });

  test('cloud footprint overlap: off-center circular segment agrees with its exact cap formula', () => {
    const offsetM = 0.3;
    const exactCapAreaM2 = Math.acos(offsetM) - offsetM * Math.sqrt(1 - offsetM * offsetM);
    const coverage = cloudFootprintOverlap(UNIT_CIRCLE, grid(offsetM, -1, 1, 2));
    withinRelativeError(overlapAreaM2(coverage.overlaps), exactCapAreaM2, 1e-12);
  });

  test('cloud footprint overlap: a thin tangent cap retains its small positive area', () => {
    const leftM = 1 - 1e-8;
    const exactCapAreaM2 = Math.acos(leftM) - leftM * Math.sqrt((1 - leftM) * (1 + leftM));
    const coverage = cloudFootprintOverlap(UNIT_CIRCLE, grid(leftM, -1, 1, 2, 1 - leftM));
    assert.equal(coverage.overlaps.length, 2);
    withinRelativeError(overlapAreaM2(coverage.overlaps), exactCapAreaM2, 1e-3);
  });

  test('cloud footprint overlap: complete finite grid conserves circle area across many cells', () => {
    const coverage = cloudFootprintOverlap(
      { eastM: 0.17, northM: -0.23, radiusM: 1.37 },
      grid(-2, -2, 4, 4),
    );
    withinRelativeError(overlapAreaM2(coverage.overlaps), coverage.footprintAreaM2, 1e-11);
    assert.ok(coverage.overlaps.length > 4);
    const massGrid = {
      cells: Array.from({ length: 16 }, () => ({ areaM2: 1 })),
      layerEdgesM: [0, 100],
    };
    const deposition = depositCloudParcelMass([{
      phase: 'ice', massKg: 7, altitudeM: 50,
      footprintAreaM2: coverage.footprintAreaM2, overlaps: coverage.overlaps,
    }], massGrid);
    const assignedMassKg = deposition.columnsByLayer[0]!.iceKgM2ByCell.reduce(
      (total, columnKgM2, index) => total + columnKgM2 * massGrid.cells[index]!.areaM2, 0,
    );
    withinRelativeError(assignedMassKg, 7, 1e-14);
    assert.ok(deposition.unassignedMassKgByPhase.ice >= 0);
    assert.ok(deposition.unassignedMassKgByPhase.ice < 1e-14);
  });

  test('cloud footprint overlap: translating nearby geometry to a large origin preserves overlap areas', () => {
    const shiftM = 1e12;
    const local = cloudFootprintOverlap({ eastM: 0.17, northM: -0.23, radiusM: 1.37 }, grid(-2, -2, 4, 4));
    const translated = cloudFootprintOverlap(
      { eastM: shiftM + 0.17, northM: -shiftM - 0.23, radiusM: 1.37 },
      grid(shiftM - 2, -shiftM - 2, 4, 4),
    );
    assert.deepEqual(translated.overlaps.map(({ cellIndex }) => cellIndex),
      local.overlaps.map(({ cellIndex }) => cellIndex));
    for (let index = 0; index < local.overlaps.length; index += 1) {
      withinRelativeError(translated.overlaps[index]!.areaM2, local.overlaps[index]!.areaM2, 1e-3);
    }
  });

  test('cloud footprint overlap: huge grids visit only cells under the circle bounds', () => {
    const coverage = cloudFootprintOverlap(UNIT_CIRCLE, {
      originEastM: -1e12, originNorthM: -1,
      cellWidthM: 1, cellHeightM: 2,
      width: 2e12, height: 1,
    });
    assert.deepEqual(coverage.overlaps.map(({ cellIndex }) => cellIndex), [999_999_999_999, 1_000_000_000_000]);
    withinRelativeError(overlapAreaM2(coverage.overlaps), Math.PI);
  });

  test('cloud footprint overlap: a rectangle strictly inside the circle does not exceed its exact area', () => {
    const coverage = cloudFootprintOverlap({ eastM: 0, northM: 0, radiusM: 10 }, grid(0.5, -0.5, 1, 1));
    assert.deepEqual(coverage.overlaps, [{ cellIndex: 0, areaM2: 1 }]);
    const result = depositCloudParcelMass([{
      phase: 'liquid', massKg: 1, altitudeM: 50,
      footprintAreaM2: coverage.footprintAreaM2, overlaps: coverage.overlaps,
    }], { cells: [{ areaM2: 1 }], layerEdgesM: [0, 100] });
    assert.equal(result.columnsByLayer[0]!.liquidKgM2ByCell[0], 1 / coverage.footprintAreaM2);
  });

  test('cloud footprint overlap: clipped region leaves uncovered mass in deposition', () => {
    const coverage = cloudFootprintOverlap(UNIT_CIRCLE, grid(0, -0.5, 1, 1));
    const gridForMass = {
      cells: [{ areaM2: 1 }],
      layerEdgesM: [0, 100],
    };
    const result = depositCloudParcelMass([{
      phase: 'liquid', massKg: 10, altitudeM: 50,
      footprintAreaM2: coverage.footprintAreaM2, overlaps: coverage.overlaps,
    }], gridForMass);
    const assignedMassKg = result.columnsByLayer[0]!.liquidKgM2ByCell[0]!;
    withinRelativeError(assignedMassKg, 10 * overlapAreaM2(coverage.overlaps) / Math.PI);
    assert.ok(result.unassignedMassKgByPhase.liquid > 0);
    withinRelativeError(assignedMassKg + result.unassignedMassKgByPhase.liquid, 10);
  });

  test('cloud footprint overlap: invalid geometry is rejected', () => {
    assert.throws(() => cloudFootprintOverlap({ ...UNIT_CIRCLE, radiusM: 0 }, grid(-1, -1, 2, 2)), RangeError);
    assert.throws(() => cloudFootprintOverlap({ ...UNIT_CIRCLE, eastM: Number.NaN }, grid(-1, -1, 2, 2)), RangeError);
    assert.throws(() => cloudFootprintOverlap(UNIT_CIRCLE, grid(-1, -1, 0, 2)), RangeError);
    assert.throws(() => cloudFootprintOverlap(UNIT_CIRCLE, grid(-1, -1, 2.5, 2)), RangeError);
    assert.throws(() => cloudFootprintOverlap(UNIT_CIRCLE, grid(-1, -1, 2, 2, 0, 1)), RangeError);
  });
}
