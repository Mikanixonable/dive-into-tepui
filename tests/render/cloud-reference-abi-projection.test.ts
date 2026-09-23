// GOES-R ABI 固定格子の画素中心座標と GRS80 逆投影を検査する。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import {
  abiFixedGridToGeodetic,
  decodeAbiFixedGridCoordinate,
  geodeticToAbiFixedGrid,
} from '../../tools/cloud-reference/abi-projection';

const GOES_EAST = {
  perspectivePointHeightMeters: 35_786_023,
  semiMajorAxisMeters: 6_378_137,
  semiMinorAxisMeters: 6_356_752.31414,
  longitudeOfProjectionOriginRadians: -75 * Math.PI / 180,
};

const GOES_WEST_SAMPLE = {
  ...GOES_EAST,
  longitudeOfProjectionOriginRadians: -137 * Math.PI / 180,
};

/** NOAA GOES-R PUG navigation coordinates and the sample NetCDF packing are fixed here. */
export function register(): void {
  test('cloud reference ABI projection: packed grid coordinates decode to pixel-center angles', () => {
    assert.equal(decodeAbiFixedGridCoordinate(1, 0.000112, -0.151816), -0.151704);
    assert.equal(decodeAbiFixedGridCoordinate(-1, -0.000112, 0.151816), 0.151928);
    assert.throws(() => decodeAbiFixedGridCoordinate(Number.NaN, 1, 0));
  });

  test('cloud reference ABI projection: nadir is the declared sub-satellite point', () => {
    const geodetic = abiFixedGridToGeodetic({ xAngleRadians: 0, yAngleRadians: 0 }, GOES_WEST_SAMPLE);
    assert.ok(geodetic);
    assert.equal(geodetic.latitudeRadians, 0);
    assert.equal(geodetic.longitudeRadians, GOES_WEST_SAMPLE.longitudeOfProjectionOriginRadians);
  });

  test('cloud reference ABI projection: off-axis navigation matches the NOAA PUG reference point', () => {
    const geodetic = abiFixedGridToGeodetic({ xAngleRadians: -0.024052, yAngleRadians: 0.095340 }, GOES_EAST);
    assert.ok(geodetic);
    assert.ok(Math.abs(geodetic.latitudeRadians * 180 / Math.PI - 33.846162) < 0.00001);
    assert.ok(Math.abs(geodetic.longitudeRadians * 180 / Math.PI - -84.690932) < 0.00001);
  });

  test('cloud reference ABI projection: sweep=x forward and inverse navigation agree with an independent point', () => {
    const expected = { latitudeRadians: 33.846162 * Math.PI / 180, longitudeRadians: -84.690932 * Math.PI / 180 };
    const fixedGrid = geodeticToAbiFixedGrid(expected, GOES_EAST);
    assert.ok(fixedGrid);
    assert.ok(Math.abs(fixedGrid.xAngleRadians - -0.024052) < 0.000001);
    assert.ok(Math.abs(fixedGrid.yAngleRadians - 0.095340) < 0.000001);
    const restored = abiFixedGridToGeodetic(fixedGrid, GOES_EAST);
    assert.ok(restored);
    assert.ok(Math.abs(restored.latitudeRadians - expected.latitudeRadians) < 1e-10);
    assert.ok(Math.abs(restored.longitudeRadians - expected.longitudeRadians) < 1e-10);
  });

  test('cloud reference ABI projection: points beyond the ellipsoid limb are invalid', () => {
    const horizonAngle = Math.asin(GOES_EAST.semiMajorAxisMeters / (GOES_EAST.perspectivePointHeightMeters + GOES_EAST.semiMajorAxisMeters));
    assert.ok(abiFixedGridToGeodetic({ xAngleRadians: horizonAngle, yAngleRadians: 0 }, GOES_EAST));
    assert.equal(abiFixedGridToGeodetic({ xAngleRadians: horizonAngle + 1e-5, yAngleRadians: 0 }, GOES_EAST), null);
    assert.equal(geodeticToAbiFixedGrid({ latitudeRadians: 0, longitudeRadians: Math.PI }, GOES_EAST), null);
  });
}
