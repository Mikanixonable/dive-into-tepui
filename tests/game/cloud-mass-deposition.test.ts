// 有限面積の雲水量が相と高度層を保ち、格子面積積分で回収できることを検査する。
import * as assert from 'node:assert/strict';
import { depositCloudParcelMass, type CloudMassGrid, type CloudMassParcel } from '../../src/game/cloud/cloud-mass-deposition';
import { test } from '../harness';

const GRID: CloudMassGrid = {
  cells: [{ areaM2: 4 }, { areaM2: 10 }, { areaM2: 4 }],
  layerEdgesM: [0, 100, 500],
};

function integratedMassKg(
  columnsKgM2: readonly number[],
  grid: CloudMassGrid,
): number {
  return columnsKgM2.reduce((total, columnKgM2, index) => total + columnKgM2 * grid.cells[index]!.areaM2, 0);
}

function parcel(
  changes: Partial<CloudMassParcel> = {},
): CloudMassParcel {
  return {
    phase: 'liquid', massKg: 0, altitudeM: 50, footprintAreaM2: 1, overlaps: [],
    ...changes,
  };
}

export function register(): void {
  test('cloud mass deposition: area overlap distributes exact liquid and ice mass into separate layers', () => {
    const result = depositCloudParcelMass([
      parcel({
        phase: 'liquid', massKg: 12, footprintAreaM2: 24,
        overlaps: [{ cellIndex: 0, areaM2: 4 }, { cellIndex: 1, areaM2: 8 }],
      }),
      parcel({
        phase: 'ice', massKg: 10, altitudeM: 100, footprintAreaM2: 20,
        overlaps: [{ cellIndex: 1, areaM2: 10 }],
      }),
    ], GRID);

    assert.deepEqual(result.columnsByLayer.map((layer) => [layer.lowerAltitudeM, layer.upperAltitudeM]), [
      [0, 100], [100, 500],
    ]);
    assert.deepEqual(result.columnsByLayer[0]!.liquidKgM2ByCell, [0.5, 0.4, 0]);
    assert.deepEqual(result.columnsByLayer[0]!.iceKgM2ByCell, [0, 0, 0]);
    assert.deepEqual(result.columnsByLayer[1]!.liquidKgM2ByCell, [0, 0, 0]);
    assert.deepEqual(result.columnsByLayer[1]!.iceKgM2ByCell, [0, 0.5, 0]);
    assert.equal(result.unassignedMassKgByPhase.liquid, 6);
    assert.equal(result.unassignedMassKgByPhase.ice, 5);

    const liquidAssignedKg = result.columnsByLayer.reduce(
      (total, layer) => total + integratedMassKg(layer.liquidKgM2ByCell, GRID), 0,
    );
    const iceAssignedKg = result.columnsByLayer.reduce(
      (total, layer) => total + integratedMassKg(layer.iceKgM2ByCell, GRID), 0,
    );
    assert.ok(Math.abs(liquidAssignedKg - 6) < 1e-14);
    assert.ok(Math.abs(iceAssignedKg - 5) < 1e-14);
    assert.ok(Math.abs(liquidAssignedKg + result.unassignedMassKgByPhase.liquid - 12) < 1e-14);
    assert.ok(Math.abs(iceAssignedKg + result.unassignedMassKgByPhase.ice - 10) < 1e-14);
    assert.ok(Math.abs(liquidAssignedKg + iceAssignedKg
      + result.unassignedMassKgByPhase.liquid + result.unassignedMassKgByPhase.ice - 22) < 1e-14);
  });

  test('cloud mass deposition: complete footprint coverage assigns all mass by cell area', () => {
    const grid: CloudMassGrid = {
      cells: [{ areaM2: 4 }, { areaM2: 6 }],
      layerEdgesM: [0, 100],
    };
    const result = depositCloudParcelMass([parcel({
      massKg: 20, footprintAreaM2: 10,
      overlaps: [{ cellIndex: 0, areaM2: 4 }, { cellIndex: 1, areaM2: 6 }],
    })], grid);
    const layer = result.columnsByLayer[0]!;
    assert.deepEqual(layer.liquidKgM2ByCell, [2, 2]);
    assert.equal(integratedMassKg(layer.liquidKgM2ByCell, grid), 20);
    assert.equal(result.unassignedMassKgByPhase.liquid, 0);
    assert.equal(result.unassignedMassKgByPhase.ice, 0);
  });

  test('cloud mass deposition: uncovered footprint is returned as unassigned mass', () => {
    const result = depositCloudParcelMass([parcel({
      massKg: 9, footprintAreaM2: 12,
      overlaps: [{ cellIndex: 2, areaM2: 3 }],
    })], GRID);
    const assigned = integratedMassKg(result.columnsByLayer[0]!.liquidKgM2ByCell, GRID);
    assert.equal(assigned, 2.25);
    assert.equal(result.unassignedMassKgByPhase.liquid, 6.75);
    assert.equal(assigned + result.unassignedMassKgByPhase.liquid, 9);
  });

  test('cloud mass deposition: footprint without cell overlap is fully reported as unassigned', () => {
    const result = depositCloudParcelMass([parcel({ massKg: 9, footprintAreaM2: 12 })], GRID);
    assert.equal(result.unassignedMassKgByPhase.liquid, 9);
    assert.equal(result.unassignedMassKgByPhase.ice, 0);
    assert.equal(result.columnsByLayer.flatMap((layer) => layer.liquidKgM2ByCell)
      .reduce((total, columnKgM2) => total + columnKgM2, 0), 0);
  });

  test('cloud mass deposition: decimal overlap roundoff preserves complete coverage without negative remainder', () => {
    const grid: CloudMassGrid = {
      cells: [{ areaM2: 0.1 }, { areaM2: 0.2 }],
      layerEdgesM: [0, 100],
    };
    const result = depositCloudParcelMass([parcel({
      massKg: 1, footprintAreaM2: 0.3,
      overlaps: [{ cellIndex: 0, areaM2: 0.1 }, { cellIndex: 1, areaM2: 0.2 }],
    })], grid);
    const assigned = integratedMassKg(result.columnsByLayer[0]!.liquidKgM2ByCell, grid);
    assert.ok(Math.abs(assigned - 1) < 1e-15);
    assert.equal(result.unassignedMassKgByPhase.liquid, 0);
    assert.ok(result.unassignedMassKgByPhase.liquid >= 0);
  });

  test('cloud mass deposition: layer edges include the bottom and final top and internal boundaries enter the upper layer', () => {
    const result = depositCloudParcelMass([
      parcel({ massKg: 1, altitudeM: 0, footprintAreaM2: 1, overlaps: [{ cellIndex: 0, areaM2: 1 }] }),
      parcel({ massKg: 2, altitudeM: 100, footprintAreaM2: 1, overlaps: [{ cellIndex: 0, areaM2: 1 }] }),
      parcel({ massKg: 3, altitudeM: 500, footprintAreaM2: 1, overlaps: [{ cellIndex: 0, areaM2: 1 }] }),
    ], GRID);
    assert.equal(integratedMassKg(result.columnsByLayer[0]!.liquidKgM2ByCell, GRID), 1);
    assert.equal(integratedMassKg(result.columnsByLayer[1]!.liquidKgM2ByCell, GRID), 5);
    assert.equal(result.unassignedMassKgByPhase.liquid, 0);
    assert.throws(() => depositCloudParcelMass([parcel({ altitudeM: -Number.MIN_VALUE })], GRID), RangeError);
    assert.throws(() => depositCloudParcelMass([parcel({ altitudeM: 500 + 1e-9 })], GRID), RangeError);
  });

  test('cloud mass deposition: invalid areas, phases, cells and layer edges are rejected', () => {
    const validOverlap = [{ cellIndex: 0, areaM2: 1 }];
    const invalidParcels = [
      parcel({ massKg: -1 }),
      parcel({ massKg: Number.NaN }),
      parcel({ altitudeM: Number.POSITIVE_INFINITY }),
      parcel({ footprintAreaM2: 0 }),
      parcel({ footprintAreaM2: Number.NaN }),
      parcel({ overlaps: [{ cellIndex: 0, areaM2: -1 }] }),
      parcel({ overlaps: [{ cellIndex: 0, areaM2: Number.POSITIVE_INFINITY }] }),
      parcel({ overlaps: [{ cellIndex: 0, areaM2: 5 }] }),
      parcel({ footprintAreaM2: 1, overlaps: [{ cellIndex: 0, areaM2: 0.75 }, { cellIndex: 1, areaM2: 0.5 }] }),
      parcel({ overlaps: [{ cellIndex: 0, areaM2: 0.5 }, { cellIndex: 0, areaM2: 0.5 }] }),
      parcel({ overlaps: [{ cellIndex: -1, areaM2: 0.5 }] }),
      parcel({ overlaps: [{ cellIndex: 1.5, areaM2: 0.5 }] }),
      parcel({ overlaps: [{ cellIndex: 3, areaM2: 0.5 }] }),
      { ...parcel(), phase: 'vapor' } as unknown as CloudMassParcel,
    ];
    for (const invalid of invalidParcels) assert.throws(() => depositCloudParcelMass([invalid], GRID), RangeError);

    assert.throws(() => depositCloudParcelMass([], { ...GRID, layerEdgesM: [0] }), RangeError);
    assert.throws(() => depositCloudParcelMass([], { ...GRID, layerEdgesM: [0, 0] }), RangeError);
    assert.throws(() => depositCloudParcelMass([], { ...GRID, layerEdgesM: [0, Number.NaN] }), RangeError);
    assert.throws(() => depositCloudParcelMass([], { ...GRID, layerEdgesM: [-1, 100] }), RangeError);
    assert.throws(() => depositCloudParcelMass([], { ...GRID, cells: [{ areaM2: 0 }] }), RangeError);
    assert.throws(() => depositCloudParcelMass([], { ...GRID, cells: [{ areaM2: Number.NaN }] }), RangeError);
    assert.throws(() => depositCloudParcelMass([], { ...GRID, cells: [{ areaM2: Number.POSITIVE_INFINITY }] }), RangeError);
    assert.throws(() => depositCloudParcelMass([parcel({ overlaps: validOverlap })], {
      ...GRID, layerEdgesM: [0, 100, 100],
    }), RangeError);
    assert.throws(() => depositCloudParcelMass([parcel({
      footprintAreaM2: Number.MAX_VALUE,
      overlaps: [{ cellIndex: 0, areaM2: Number.MAX_VALUE * 0.75 },
        { cellIndex: 1, areaM2: Number.MAX_VALUE * 0.75 }],
    })], {
      cells: [{ areaM2: Number.MAX_VALUE }, { areaM2: Number.MAX_VALUE }], layerEdgesM: [0, 100],
    }), RangeError);
  });
}
