// ABI 角度画素を高度 0 の楕円体四隅として局所 ENU 平面へ写す。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { abiFixedGridPixelFootprintToEnu } from '../../tools/cloud-reference/abi-footprint';
import { collocateAbiScalarToFootprint } from '../../tools/cloud-reference/abi-collocation';
import type { AbiCollocationPoint } from '../../tools/cloud-reference/abi-collocation';
import type { AbiFixedGridProjection, AbiGeodeticCoordinate } from '../../tools/cloud-reference/abi-projection';

const projection: AbiFixedGridProjection = {
  perspectivePointHeightMeters: 35_786_023,
  semiMajorAxisMeters: 6_378_137,
  semiMinorAxisMeters: 6_356_752.31414,
  longitudeOfProjectionOriginRadians: -75 * Math.PI / 180,
};
const nadir: AbiGeodeticCoordinate = {
  latitudeRadians: 0,
  longitudeRadians: projection.longitudeOfProjectionOriginRadians,
};

function area(polygon: readonly AbiCollocationPoint[]): number {
  const origin = polygon[0]!;
  let twiceArea = 0;
  for (let index = 1; index < polygon.length - 1; index += 1) {
    const first = polygon[index]!;
    const second = polygon[index + 1]!;
    twiceArea += (first.x - origin.x) * (second.y - origin.y)
      - (first.y - origin.y) * (second.x - origin.x);
  }
  return Math.abs(twiceArea / 2);
}

/** 解析的な航法と隣接する角度 bin で ABI 画素の四隅を検査する。 */
export function register(): void {
  test('ABI footprint: nadir corners form an east-north ordered ENU polygon', () => {
    const footprint = abiFixedGridPixelFootprintToEnu(
      { xAngleRadians: 0, yAngleRadians: 0 }, 0.001, 0.001, projection, nadir,
    );
    assert.ok(footprint);
    assert.equal(footprint.length, 4);
    assert.ok(footprint[0]!.x < 0 && footprint[1]!.x > 0);
    assert.ok(footprint[0]!.y < 0 && footprint[2]!.y > 0);
    assert.ok(area(footprint) > 0);
  });

  test('ABI footprint: adjacent fixed-grid cells share only a boundary', () => {
    const step = 0.001;
    const left = abiFixedGridPixelFootprintToEnu(
      { xAngleRadians: 0, yAngleRadians: 0 }, step, step, projection, nadir,
    );
    const right = abiFixedGridPixelFootprintToEnu(
      { xAngleRadians: step, yAngleRadians: 0 }, step, step, projection, nadir,
    );
    assert.ok(left && right);
    const overlap = collocateAbiScalarToFootprint([
      { footprint: left, value: 1, validMask: true },
    ], right, 0);
    assert.equal(overlap.validOverlapArea, 0);
    assert.equal(overlap.validCoverageFraction, 0);
    assert.equal(overlap.value, null);
  });

  test('ABI footprint: doubled angular resolution steps produce a larger nadir pixel', () => {
    const fine = abiFixedGridPixelFootprintToEnu(
      { xAngleRadians: 0, yAngleRadians: 0 }, 0.0001, 0.0001, projection, nadir,
    );
    const coarse = abiFixedGridPixelFootprintToEnu(
      { xAngleRadians: 0, yAngleRadians: 0 }, 0.0002, 0.0002, projection, nadir,
    );
    assert.ok(fine && coarse);
    assert.ok(area(coarse) > area(fine));
    assert.ok(Math.abs(area(coarse) / area(fine) - 4) < 0.001);
  });

  test('ABI footprint: any corner beyond the limb invalidates the pixel footprint', () => {
    const horizonAngle = Math.asin(
      projection.semiMajorAxisMeters
        / (projection.perspectivePointHeightMeters + projection.semiMajorAxisMeters),
    );
    assert.equal(abiFixedGridPixelFootprintToEnu(
      { xAngleRadians: horizonAngle, yAngleRadians: 0 }, 0.001, 0.001, projection, nadir,
    ), null);
  });

  test('ABI footprint: angular steps and ENU reference coordinates are validated', () => {
    assert.throws(() => abiFixedGridPixelFootprintToEnu(
      { xAngleRadians: 0, yAngleRadians: 0 }, 0, 0.001, projection, nadir,
    ));
    assert.throws(() => abiFixedGridPixelFootprintToEnu(
      { xAngleRadians: 0, yAngleRadians: 0 }, 0.001, 0.001, projection,
      { latitudeRadians: Math.PI, longitudeRadians: 0 },
    ));
  });
}
