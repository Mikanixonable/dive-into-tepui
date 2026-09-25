// 局所三次元格子の光路長と二相の消散を、解析的なセル交差長で検査する。
import * as assert from 'node:assert/strict';
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
