// 局所三次元格子の光路長と二相の消散を、解析的なセル交差長で検査する。
import * as assert from 'node:assert/strict';
import { cloudFootprintOverlap } from '../../src/game/cloud/cloud-footprint-overlap';
import { depositCloudParcelMass } from '../../src/game/cloud/cloud-mass-deposition';
import { extinctionFromCloudMass } from '../../src/game/cloud/cloud-mass-extinction';
import { integrateCloudLocalOpticalPath } from '../../src/game/cloud/cloud-local-optical-path';
import type { CloudExtinctionLayer } from '../../src/game/cloud/cloud-mass-extinction';
import type { CloudFootprintGrid } from '../../src/game/cloud/cloud-footprint-overlap';
import { test } from '../harness';

const GRID: CloudFootprintGrid = {
  originEastM: 0, originNorthM: 0, cellWidthM: 100, cellHeightM: 100, width: 2, height: 1,
};
const LAYERS: readonly CloudExtinctionLayer[] = [
  { lowerAltitudeM: 0, upperAltitudeM: 100, liquidPerMByCell: [0.01, 0], icePerMByCell: [0, 0] },
  { lowerAltitudeM: 100, upperAltitudeM: 200, liquidPerMByCell: [0, 0], icePerMByCell: [0.02, 0.03] },
];

function near(actual: number, expected: number): void {
  assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);
}

export function register(): void {
  test('cloud local optical path: footprint mass reaches vertical attenuation without coverage conversion', () => {
    const footprint = cloudFootprintOverlap(
      { eastM: 50, northM: 50, radiusM: 40 }, GRID,
    );
    const cellAreaM2 = GRID.cellWidthM * GRID.cellHeightM;
    const massKg = 0.2 * footprint.footprintAreaM2;
    const deposition = depositCloudParcelMass([{
      phase: 'liquid', massKg, altitudeM: 50,
      footprintAreaM2: footprint.footprintAreaM2, overlaps: footprint.overlaps,
    }], {
      cells: [{ areaM2: cellAreaM2 }, { areaM2: cellAreaM2 }], layerEdgesM: [0, 100],
    });
    near(deposition.unassignedMassKgByPhase.liquid, 0);
    const extinction = extinctionFromCloudMass(deposition, [{
      liquidEffectiveRadiusM: 10e-6, iceEffectiveRadiusM: 30e-6, iceExtinctionEfficiency: 2,
    }]);
    const path = integrateCloudLocalOpticalPath(
      { eastM: 50, northM: 50, altitudeM: 0 },
      { eastM: 50, northM: 50, altitudeM: 100 }, GRID, extinction,
    );
    const expectedTau = 3 * massKg / (cellAreaM2 * 2 * 1000 * 10e-6);
    near(path.liquidOpticalDepth, expectedTau);
    near(path.transmittance, Math.exp(-expectedTau));
  });

  test('cloud local optical path: vertical view and solar rays share two separated phases', () => {
    const from = { eastM: 50, northM: 50, altitudeM: 0 };
    const to = { eastM: 50, northM: 50, altitudeM: 200 };
    const view = integrateCloudLocalOpticalPath(from, to, GRID, LAYERS);
    const sun = integrateCloudLocalOpticalPath(to, from, GRID, LAYERS);
    near(view.liquidOpticalDepth, 1);
    near(view.iceOpticalDepth, 2);
    near(view.transmittance, Math.exp(-3));
    near(sun.transmittance, view.transmittance);
  });

  test('cloud local optical path: slant ray crosses cell and layer boundaries by exact lengths', () => {
    const ray = integrateCloudLocalOpticalPath(
      { eastM: 0, northM: 50, altitudeM: 0 },
      { eastM: 200, northM: 50, altitudeM: 200 }, GRID, LAYERS,
    );
    near(ray.liquidOpticalDepth, Math.SQRT2);
    near(ray.iceOpticalDepth, 3 * Math.SQRT2);
    near(ray.transmittance, Math.exp(-4 * Math.SQRT2));
  });

  test('cloud local optical path: grid exterior and holes are transparent', () => {
    const outside = integrateCloudLocalOpticalPath(
      { eastM: -20, northM: 50, altitudeM: 0 },
      { eastM: -10, northM: 50, altitudeM: 200 }, GRID, LAYERS,
    );
    assert.deepEqual(outside, { liquidOpticalDepth: 0, iceOpticalDepth: 0, transmittance: 1 });
    const hole = integrateCloudLocalOpticalPath(
      { eastM: 150, northM: 50, altitudeM: 0 },
      { eastM: 150, northM: 50, altitudeM: 100 }, GRID, LAYERS,
    );
    assert.deepEqual(hole, { liquidOpticalDepth: 0, iceOpticalDepth: 0, transmittance: 1 });
  });

  test('cloud local optical path: stationary cell boundary uses a single half-open cell', () => {
    const boundary = integrateCloudLocalOpticalPath(
      { eastM: 100, northM: 50, altitudeM: 100 },
      { eastM: 100, northM: 50, altitudeM: 200 }, GRID, LAYERS,
    );
    near(boundary.iceOpticalDepth, 3);
    near(boundary.liquidOpticalDepth, 0);
  });

  test('cloud local optical path: C9 separated layers match analytic vertical and 45-degree paths', () => {
    const grid: CloudFootprintGrid = {
      originEastM: -10_000, originNorthM: -10_000,
      cellWidthM: 20_000, cellHeightM: 20_000, width: 1, height: 1,
    };
    const layers: readonly CloudExtinctionLayer[] = [
      { lowerAltitudeM: 1_000, upperAltitudeM: 3_000,
        liquidPerMByCell: [2e-4], icePerMByCell: [0] },
      { lowerAltitudeM: 6_000, upperAltitudeM: 8_000,
        liquidPerMByCell: [0], icePerMByCell: [1e-4] },
    ];
    const origin = { eastM: 0, northM: 0, altitudeM: 0 };
    const vertical = integrateCloudLocalOpticalPath(origin,
      { eastM: 0, northM: 0, altitudeM: 9_000 }, grid, layers);
    near(vertical.liquidOpticalDepth, 0.4);
    near(vertical.iceOpticalDepth, 0.2);
    near(vertical.transmittance, Math.exp(-0.6));

    const slant = integrateCloudLocalOpticalPath(origin,
      { eastM: 9_000, northM: 0, altitudeM: 9_000 }, grid, layers);
    near(slant.liquidOpticalDepth, 0.4 * Math.SQRT2);
    near(slant.iceOpticalDepth, 0.2 * Math.SQRT2);
    near(slant.transmittance, Math.exp(-0.6 * Math.SQRT2));

    const gap = integrateCloudLocalOpticalPath(
      { eastM: 3_000, northM: 0, altitudeM: 3_000 },
      { eastM: 6_000, northM: 0, altitudeM: 6_000 }, grid, layers);
    assert.deepEqual(gap, { liquidOpticalDepth: 0, iceOpticalDepth: 0, transmittance: 1 });
    const lowerOnly = integrateCloudLocalOpticalPath(origin,
      { eastM: 0, northM: 0, altitudeM: 9_000 }, grid, [layers[0]!]);
    near(lowerOnly.liquidOpticalDepth, 0.4);
    near(lowerOnly.iceOpticalDepth, 0);
    const upperOnly = integrateCloudLocalOpticalPath(origin,
      { eastM: 0, northM: 0, altitudeM: 9_000 }, grid, [layers[1]!]);
    near(upperOnly.liquidOpticalDepth, 0);
    near(upperOnly.iceOpticalDepth, 0.2);
  });

  test('cloud local optical path: invalid coefficients and grid mismatch are rejected', () => {
    const from = { eastM: 50, northM: 50, altitudeM: 0 };
    const to = { eastM: 50, northM: 50, altitudeM: 200 };
    assert.throws(() => integrateCloudLocalOpticalPath(from, to, GRID, [
      { ...LAYERS[0]!, liquidPerMByCell: [-1, 0] },
    ]), RangeError);
    assert.throws(() => integrateCloudLocalOpticalPath(from, to, GRID, [
      { ...LAYERS[0]!, icePerMByCell: [0] },
    ]), RangeError);
    assert.throws(() => integrateCloudLocalOpticalPath(from, { ...to, altitudeM: Number.NaN }, GRID, LAYERS), RangeError);
    assert.throws(() => integrateCloudLocalOpticalPath(from, to, GRID, [
      LAYERS[0]!, { ...LAYERS[1]!, lowerAltitudeM: 99 },
    ]), RangeError);
  });
}
