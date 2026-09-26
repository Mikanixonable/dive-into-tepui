import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { v3 } from '../../src/math/vec3';
import { createCloudEnvironmentProfile } from '../../src/game/cloud/cloud-environment';
import type {
  CloudEnvironmentLevelInput, CloudEnvironmentProfile,
} from '../../src/game/cloud/cloud-environment';
import { ConvectiveCloudLocalFieldSupply } from '../../src/game/cloud/cloud-local-field-supply';
import {
  sampleCloudLocalFieldCpu, validateCloudLocalFieldFrame,
} from '../../src/render/cloud/cloud-local-field';
import type { Vec3 } from '../../src/math/vec3';

const RADIUS_M = 6_378_137;
const CENTER = v3(0, 0, 1);

// 熱帯の深対流を代表する単一柱。テストでは供給側の入力だけを固定する。
function makeEnvironment(): CloudEnvironmentProfile {
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

// 潜熱フラックスを落とした乾いた柱。供給率がゼロなのでイベント質量は生じない。
function makeDryEnvironment(): CloudEnvironmentProfile {
  const levels: CloudEnvironmentLevelInput[] = [];
  for (let index = 0; index <= 60; index += 1) {
    const heightM = index * 250;
    levels.push({
      heightM,
      pressurePa: 100_000 * Math.exp(-heightM / 8_400),
      temperatureK: heightM <= 12_000 ? 280 - 6.5 * heightM / 1_000 : 202,
      waterVaporSpecificHumidityKgPerKg: 0.005 * Math.exp(-heightM / 2_200),
      liquidWaterMixingRatioKgPerKg: 0,
      iceMixingRatioKgPerKg: 0,
      eastWindMps: -5,
      northWindMps: 0,
      largeScaleVerticalVelocityMps: 0,
    });
  }
  return createCloudEnvironmentProfile({
    levels,
    surfaceSensibleHeatFluxWPerM2: 5,
    surfaceLatentHeatFluxWPerM2: 0,
    cloudTopLongwaveCoolingKPerS: 1e-4,
    gravityWaveSource: null,
    upperIceLayerBottomM: 7_000,
    upperIceLayerTopM: 12_000,
  });
}

// 消散の合計を北半分・南半分の格子行で分けて集計する。行番号が大きいほど北。
function hemisphereExtinction(data: {
  readonly width: number;
  readonly height: number;
  readonly layerEdgesM: ArrayLike<number>;
  readonly liquidExtinctionPerM: Float32Array;
  readonly iceExtinctionPerM: Float32Array;
}): { readonly north: number; readonly south: number } {
  const layerCount = data.layerEdgesM.length - 1;
  const planeCount = data.width * data.height;
  let north = 0;
  let south = 0;
  for (const channel of [data.liquidExtinctionPerM, data.iceExtinctionPerM]) {
    for (let layer = 0; layer < layerCount; layer += 1) {
      for (let y = 0; y < data.height; y += 1) {
        let row = 0;
        const rowBase = layer * planeCount + y * data.width;
        for (let x = 0; x < data.width; x += 1) row += channel[rowBase + x]!;
        if (y < data.height / 2) south += row;
        else north += row;
      }
    }
  }
  return { north, south };
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
    const supply = new ConvectiveCloudLocalFieldSupply(() => makeEnvironment(), 7, RADIUS_M);
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
    const supply = new ConvectiveCloudLocalFieldSupply(() => makeEnvironment(), 7, RADIUS_M);
    const earlier = supply.derive(3_600, CENTER);
    const later = supply.derive(43_200, CENTER);
    assert.ok(earlier !== null && later !== null);
    assert.notDeepEqual(earlier.data.liquidExtinctionPerM, later.data.liquidExtinctionPerM);
  });

  test('cloud local field supply: 別の中心方向には別の場を張る', () => {
    const supply = new ConvectiveCloudLocalFieldSupply(() => makeEnvironment(), 7, RADIUS_M);
    const equatorial = supply.derive(7_200, CENTER);
    const shifted = supply.derive(7_200, v3(0, 0.5, Math.sqrt(0.75)));
    assert.ok(equatorial !== null && shifted !== null);
    validateCloudLocalFieldFrame(shifted.frame);
    assert.notDeepEqual(equatorial.frame.centerDirection, shifted.frame.centerDirection);
    // 方向が違えば、場の内容は一般に一致しない。
    assert.notDeepEqual(equatorial.data.iceExtinctionPerM, shifted.data.iceExtinctionPerM);
  });

  test('cloud local field supply: 有効角距離の外の方向は透明を返す', () => {
    const supply = new ConvectiveCloudLocalFieldSupply(() => makeEnvironment(), 7, RADIUS_M);
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
    const supply = new ConvectiveCloudLocalFieldSupply(() => makeEnvironment(), 7, RADIUS_M);
    assert.throws(() => supply.derive(Number.NaN, CENTER), RangeError);
    assert.throws(() => supply.derive(7_200, v3(1, 1, 0)), RangeError);
    assert.throws(() => supply.derive(7_200, v3(0, 0, 0)), RangeError);
    assert.throws(
      () => new ConvectiveCloudLocalFieldSupply(() => makeEnvironment(), 7, -1), RangeError);
    assert.throws(
      () => new ConvectiveCloudLocalFieldSupply(() => makeEnvironment(), Number.NaN, RADIUS_M),
      RangeError);
    assert.throws(
      () => new ConvectiveCloudLocalFieldSupply(null as never, 7, RADIUS_M), TypeError);
  });

  test('cloud local field supply: 環境はセル位置ごとに引かれる', () => {
    const environment = makeEnvironment();
    const directions: Vec3[] = [];
    const supply = new ConvectiveCloudLocalFieldSupply((direction) => {
      directions.push(direction);
      return environment;
    }, 7, RADIUS_M);
    const result = supply.derive(7_200, CENTER);
    assert.ok(result !== null);
    // 全セルぶんの引き出しが行われ、どれも場の中の単位方向である。
    assert.ok(directions.length >= 81);
    for (const direction of directions) {
      assert.ok(Math.abs(Math.hypot(direction.x, direction.y, direction.z) - 1) < 1e-9);
    }
    // セルは中心のまわりに散るので、引かれた方向は全セル同一ではない。
    const uniqueLatitudes = new Set(directions.map((d) => d.y.toPrecision(6)));
    assert.ok(uniqueLatitudes.size > 1);
  });

  test('cloud local field supply: 方向で変わる環境は場の供給分布を変える', () => {
    // 北(y>0)だけ水供給のある環境源。赤道に張った場では北のセルだけが供給を受ける。
    const humid = makeEnvironment();
    const dry = makeDryEnvironment();
    const supply = new ConvectiveCloudLocalFieldSupply(
      (direction) => (direction.y > 0 ? humid : dry), 7, RADIUS_M);
    const result = supply.derive(7_200, CENTER);
    assert.ok(result !== null);
    const { north, south } = hemisphereExtinction(result.data);
    assert.ok(north > 0);
    assert.ok(north > south);
  });

  test('cloud local field supply: 分割ジョブは同期導出と同じ場を返す', () => {
    const supply = new ConvectiveCloudLocalFieldSupply(() => makeEnvironment(), 7, RADIUS_M);
    const direct = supply.derive(7_200, CENTER);
    const job = supply.startJob(7_200, CENTER);
    while (!job.step(5).done) {
      assert.equal(job.result, null); // 完成まで途中経過は出さない
    }
    const stepped = job.result;
    assert.ok(direct !== null && stepped !== null);
    assert.deepEqual(stepped.frame, direct.frame);
    assert.deepEqual(stepped.data.liquidExtinctionPerM, direct.data.liquidExtinctionPerM);
    assert.deepEqual(stepped.data.iceExtinctionPerM, direct.data.iceExtinctionPerM);
  });

  test('cloud local field supply: ゼロ予算でも反復すれば完成する', () => {
    const supply = new ConvectiveCloudLocalFieldSupply(() => makeEnvironment(), 7, RADIUS_M);
    const job = supply.startJob(7_200, CENTER);
    // 1回の駆動では終わらない — セルは81件あり、1駆動1単位より先へ進めない。
    assert.equal(job.step(0).done, false);
    let steps = 1;
    while (!job.step(0).done) {
      steps += 1;
      if (steps > 1_000) throw new Error('job did not finish');
    }
    assert.ok(steps > 1);
    assert.ok(job.result !== null);
    // 完成以後の駆動は done のまま。
    assert.equal(job.step(0).done, true);
  });

  test('cloud local field supply: ジョブは非有限・非単位の入力を RangeError で始めない', () => {
    const supply = new ConvectiveCloudLocalFieldSupply(() => makeEnvironment(), 7, RADIUS_M);
    assert.throws(() => supply.startJob(Number.NaN, CENTER), RangeError);
    assert.throws(() => supply.startJob(7_200, v3(1, 1, 0)), RangeError);
    const job = supply.startJob(7_200, CENTER);
    assert.throws(() => job.step(Number.NaN), RangeError);
  });
}
