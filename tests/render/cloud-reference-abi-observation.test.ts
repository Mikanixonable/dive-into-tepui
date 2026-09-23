// ABI の一画素評価で値、製品別品質、地球交差、太陽条件を分離することを検査する。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import {
  evaluateAbiObservationSample,
  evaluateAbiObservationTile,
} from '../../tools/cloud-reference/abi-observation';
import type { AbiFixedGridProjection } from '../../tools/cloud-reference/abi-projection';

const projection: AbiFixedGridProjection = {
  perspectivePointHeightMeters: 35_786_023,
  semiMajorAxisMeters: 6_378_137,
  semiMinorAxisMeters: 6_356_752.31414,
  longitudeOfProjectionOriginRadians: -137 * Math.PI / 180,
};

const packedSample = {
  packedValue: 100,
  fillValue: 4095,
  validRange: [0, 4094] as const,
  scaleFactor: 0.1,
  addOffset: 0,
};

/** ABI 一画素の品質判定と理由を検査する。 */
export function register(): void {
  test('cloud reference ABI observation: good daytime sample is unpacked once', () => {
    const result = evaluateAbiObservationSample(
      packedSample, 0, 'L1B_RAD', { xAngleRadians: 0, yAngleRadians: 0 }, projection,
      '2024-06-23T20:00:00Z', Math.PI / 180 * 70,
    );
    assert.equal(result.valid, true);
    assert.equal(result.value, 10);
    assert.deepEqual(result.reasons, []);
    assert.ok(result.angles !== null);
    assert.ok(result.angles!.solarZenithRadians < Math.PI / 2);
  });

  test('cloud reference ABI observation: L2 COD keeps product day/night separate from solar geometry', () => {
    const result = evaluateAbiObservationSample(
      packedSample, 1, 'L2_COD', { xAngleRadians: 0, yAngleRadians: 0 }, projection,
      '2024-06-23T20:00:00Z', null,
    );
    assert.equal(result.valid, true);
    assert.equal(result.quality.mode, 'night');
    assert.ok(result.angles !== null && result.angles.solarZenithRadians < Math.PI / 2);
    assert.deepEqual(result.reasons, []);
  });

  test('cloud reference ABI observation: invalid packed values have explicit reasons', () => {
    const fill = evaluateAbiObservationSample(
      { ...packedSample, packedValue: 4095 }, 0, 'L1B_RAD', { xAngleRadians: 0, yAngleRadians: 0 }, projection,
      '2024-06-23T20:00:00Z', null,
    );
    assert.deepEqual(fill.reasons, ['fill-value', 'outside-valid-range']);

    const outOfRange = evaluateAbiObservationSample(
      { ...packedSample, packedValue: 4095, fillValue: 4094 }, 0, 'L1B_RAD', { xAngleRadians: 0, yAngleRadians: 0 }, projection,
      '2024-06-23T20:00:00Z', null,
    );
    assert.deepEqual(outOfRange.reasons, ['outside-valid-range']);

    const nonFinite = evaluateAbiObservationSample(
      { ...packedSample, packedValue: Number.NaN }, 0, 'L1B_RAD', { xAngleRadians: 0, yAngleRadians: 0 }, projection,
      '2024-06-23T20:00:00Z', null,
    );
    assert.deepEqual(nonFinite.reasons, ['non-finite-packed-value']);
  });

  test('cloud reference ABI observation: limb, night, and visible zenith limit are distinct', () => {
    const limb = evaluateAbiObservationSample(
      packedSample, 0, 'L1B_RAD', { xAngleRadians: 0.4, yAngleRadians: 0 }, projection,
      '2024-06-23T20:00:00Z', null,
    );
    assert.deepEqual(limb.reasons, ['limb']);
    assert.equal(limb.angles, null);

    const night = evaluateAbiObservationSample(
      packedSample, 0, 'L1B_RAD', { xAngleRadians: 0, yAngleRadians: 0 }, projection,
      '2024-06-23T06:00:00Z', Math.PI / 180 * 70,
    );
    assert.ok(night.reasons.includes('night'));

    const daylightLimit = evaluateAbiObservationSample(
      packedSample, 0, 'L1B_RAD', { xAngleRadians: 0, yAngleRadians: 0 }, projection,
      '2024-06-23T20:00:00Z', 0,
    );
    assert.ok(daylightLimit.reasons.includes('solar-zenith-limit'));
    assert.ok(!daylightLimit.reasons.includes('night'));
  });

  test('cloud reference ABI observation: nighttime infrared remains usable and a small tile is row-major', () => {
    const infrared = evaluateAbiObservationSample(
      packedSample, 0, 'L1B_RAD', { xAngleRadians: 0, yAngleRadians: 0 }, projection,
      '2024-06-23T06:00:00Z', null,
    );
    assert.equal(infrared.valid, true);
    assert.ok(infrared.angles !== null && infrared.angles.solarZenithRadians > Math.PI / 2);
    assert.deepEqual(infrared.reasons, []);

    const tile = evaluateAbiObservationTile({
      packedSamples: [100, 4095, 200, 300],
      qualityValues: [0, 0, 1, 0],
      xAnglesRadians: [0, 0.001],
      yAnglesRadians: [0, 0.001],
      sample: { fillValue: 4095, validRange: [0, 4094], scaleFactor: 0.1, addOffset: 0 },
      product: 'L1B_RAD',
      projection,
      scanTimeUtc: '2024-06-23T20:00:00Z',
      maximumSolarZenithRadians: null,
    });
    assert.equal(tile.length, 4);
    assert.deepEqual(tile.map((pixel) => pixel.value), [10, null, null, 30]);
    assert.deepEqual(tile[1]!.reasons, ['fill-value', 'outside-valid-range']);
    assert.deepEqual(tile[2]!.reasons, ['quality-not-good']);
    assert.throws(() => evaluateAbiObservationTile({
      packedSamples: new Float32Array(65 * 64),
      qualityValues: new Uint8Array(65 * 64),
      xAnglesRadians: new Float32Array(65),
      yAnglesRadians: new Float32Array(64),
      sample: { fillValue: -1, validRange: [0, 1], scaleFactor: 1, addOffset: 0 },
      product: 'L1B_RAD',
      projection,
      scanTimeUtc: '2024-06-23T20:00:00Z',
      maximumSolarZenithRadians: null,
    }));
  });

  test('cloud reference ABI observation: retained GOES-18 C02 packed sample decodes to radiance', () => {
    // 2024-08-19 18:00:20.4Z の実取得ファイルで、行 8704・列 15847 を小窓読込した値。
    // OR_ABI-L1b-RadF-M6C02_G18_s20242321800204_e20242321809513_c20242321809562.nc
    const result = evaluateAbiObservationSample(
      {
        packedValue: 1112,
        fillValue: 4095,
        validRange: [0, 4094],
        scaleFactor: 0.1585923731327057,
        addOffset: -20.2899112701416,
      },
      0,
      'L1B_RAD',
      { xAngleRadians: 0.06999300420284271, yAngleRadians: 0.03000900149345398 },
      projection,
      '2024-08-19T18:00:20.4Z',
      null,
    );
    assert.equal(result.valid, true);
    assert.equal(result.quality.classification, 'good');
    assert.ok(Math.abs(result.value! - 156.0648) < 1e-4);
  });
}
