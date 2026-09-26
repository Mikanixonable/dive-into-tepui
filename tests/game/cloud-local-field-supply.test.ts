import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { v3 } from '../../src/math/vec3';
import { createCloudEnvironmentProfile } from '../../src/game/cloud/cloud-environment';
import type { CloudEnvironmentLevelInput } from '../../src/game/cloud/cloud-environment';
import { ConvectiveCloudLocalFieldSupply } from '../../src/game/cloud/cloud-local-field-supply';
import {
  sampleCloudLocalFieldCpu, validateCloudLocalFieldFrame,
} from '../../src/render/cloud/cloud-local-field';

const RADIUS_M = 6_378_137;
const CENTER = v3(0, 0, 1);

// 熱帯の深対流を代表する単一柱。earth-system が製品へ組むプロファイルと同じ形で、
// テストでは供給側の入力だけを固定する。
function makeEnvironment(): ReturnType<typeof createCloudEnvironmentProfile> {
  const levels: CloudEnvironmentLevelInput[] = [];
  for (let index = 0; index <= 60; index += 1) {
    const heightM = index * 250;
    levels.push({
      heightM,
      pressurePa: 100_000 * Math.exp(-heightM / 8_400),
      temperatureK: heightM <= 12_000 ? 300 - 6.5 * heightM / 1_000 : 222,
      waterVaporSpecificHumidityKgPerKg: 0.018 * Math.exp(-heightM / 2_200),
      liquidWaterMixingRatioKgPerKg: 0,
      iceMixingRatioKgPerKg: 0,
      eastWindMps: -5,
      northWindMps: 0,
      largeScaleVerticalVelocityMps: 0,
    });
  }
  return createCloudEnvironmentProfile({
    levels,
    surfaceSensibleHeatFluxWPerM2: 20,
    surfaceLatentHeatFluxWPerM2: 150,
    cloudTopLongwaveCoolingKPerS: 1e-4,
    gravityWaveSource: null,
    upperIceLayerBottomM: 7_000,
    upperIceLayerTopM: 12_000,
  });
}

function totalExtinction(data: {
  readonly liquidExtinctionPerM: Float32Array;
  readonly iceExtinctionPerM: Float32Array;
}): number {
  let total = 0;
  for (const value of data.liquidExtinctionPerM) total += value;
  for (const value of data.iceExtinctionPerM) total += value;
  return total;
}

export function register(): void {
  test('cloud local field supply: 同じ時刻と方向には同じ場を返し、frame は契約を満たす', () => {
    const supply = new ConvectiveCloudLocalFieldSupply(makeEnvironment(), 7, RADIUS_M);
    const first = supply.derive(7_200, CENTER);
    const second = supply.derive(7_200, CENTER);
    assert.ok(first !== null && second !== null);
    validateCloudLocalFieldFrame(first.frame);
    assert.deepEqual(first.frame, second.frame);
    assert.deepEqual(first.data.liquidExtinctionPerM, second.data.liquidExtinctionPerM);
    assert.deepEqual(first.data.iceExtinctionPerM, second.data.iceExtinctionPerM);
    // 生成経路から実際に雲が載っている。
    assert.ok(totalExtinction(first.data) > 0);
  });

  test('cloud local field supply: 別の時刻には別のイベント履歴が乗る', () => {
    const supply = new ConvectiveCloudLocalFieldSupply(makeEnvironment(), 7, RADIUS_M);
    const earlier = supply.derive(3_600, CENTER);
    const later = supply.derive(43_200, CENTER);
    assert.ok(earlier !== null && later !== null);
    assert.notDeepEqual(earlier.data.liquidExtinctionPerM, later.data.liquidExtinctionPerM);
  });

  test('cloud local field supply: 別の中心方向には別の場を張る', () => {
    const supply = new ConvectiveCloudLocalFieldSupply(makeEnvironment(), 7, RADIUS_M);
    const equatorial = supply.derive(7_200, CENTER);
    const shifted = supply.derive(7_200, v3(0, 0.5, Math.sqrt(0.75)));
    assert.ok(equatorial !== null && shifted !== null);
    validateCloudLocalFieldFrame(shifted.frame);
    assert.notDeepEqual(equatorial.frame.centerDirection, shifted.frame.centerDirection);
    // 方向が違えば、場の内容は一般に一致しない。
    assert.notDeepEqual(equatorial.data.iceExtinctionPerM, shifted.data.iceExtinctionPerM);
  });

  test('cloud local field supply: 有効角距離の外の方向は透明を返す', () => {
    const supply = new ConvectiveCloudLocalFieldSupply(makeEnvironment(), 7, RADIUS_M);
    const result = supply.derive(7_200, CENTER);
    assert.ok(result !== null);
    const { frame, data } = result;
    // 有効角距離を 20% 超えた方向。east へ倒した方向を直接組む。
    const angle = frame.maxAngularDistanceRad * 1.2;
    const outside = v3(Math.sin(angle), 0, Math.cos(angle));
    const sample = sampleCloudLocalFieldCpu(data, outside, 1_000, frame);
    assert.equal(sample.liquidExtinctionPerM, 0);
    assert.equal(sample.iceExtinctionPerM, 0);
  });

  test('cloud local field supply: 非有限・非単位の入力は RangeError', () => {
    const supply = new ConvectiveCloudLocalFieldSupply(makeEnvironment(), 7, RADIUS_M);
    assert.throws(() => supply.derive(Number.NaN, CENTER), RangeError);
    assert.throws(() => supply.derive(7_200, v3(1, 1, 0)), RangeError);
    assert.throws(() => supply.derive(7_200, v3(0, 0, 0)), RangeError);
    assert.throws(
      () => new ConvectiveCloudLocalFieldSupply(makeEnvironment(), 7, -1), RangeError);
    assert.throws(
      () => new ConvectiveCloudLocalFieldSupply(makeEnvironment(), Number.NaN, RADIUS_M),
      RangeError);
  });
}
