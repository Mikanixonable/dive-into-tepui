import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { createCloudEnvironmentProfile } from '../../src/game/cloud/cloud-environment';
import type {
  CloudEnvironmentLevelInput, CloudEnvironmentProfile,
} from '../../src/game/cloud/cloud-environment';
import {
  ConvectiveCloudGlobalFieldSupply,
  type CloudGlobalFieldSupplyResult,
  type CloudGlobalMassField,
} from '../../src/game/cloud/cloud-global-field-supply';
import { cloudEquirectCellAreaM2 } from '../../src/game/cloud/cloud-equirect-grid';
import { AtmosphericWindField } from '../../src/render/cloud/atmospheric-wind';
import { makeWindAt } from '../../src/game/cloud/cloud-local-field-supply';
import type { Vec3 } from '../../src/math/vec3';
import type { CloudEventWindAt } from '../../src/game/cloud/cloud-event-transport';

const RADIUS_M = 6_378_137;
const GRID_WIDTH = 128;
const GRID_HEIGHT = 64;

// 大気風モデルを輸送用の口へ包む。
function windAt(): CloudEventWindAt {
  return makeWindAt(new AtmosphericWindField());
}

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

function makeSupply(
  environmentAt: (direction: Vec3, timeSeconds: number) => CloudEnvironmentProfile,
): ConvectiveCloudGlobalFieldSupply {
  return new ConvectiveCloudGlobalFieldSupply(
    environmentAt, 7, RADIUS_M, GRID_WIDTH, GRID_HEIGHT, windAt());
}

// 場の堆積質量 [kg](相別)。セルごとの列質量へ帯の実面積を掛けて積分する。
function depositedMassKg(
  field: CloudGlobalMassField, channel: 'liquid' | 'ice',
): number {
  const columns = channel === 'liquid' ? field.liquidKgM2 : field.iceKgM2;
  const layerCount = field.layerEdgesM.length - 1;
  const cellCount = field.width * field.height;
  let total = 0;
  for (let layer = 0; layer < layerCount; layer += 1) {
    const base = layer * cellCount;
    for (let row = 0; row < field.height; row += 1) {
      const areaM2 = cloudEquirectCellAreaM2(field, row);
      const rowBase = base + row * field.width;
      for (let column = 0; column < field.width; column += 1) {
        total += columns[rowBase + column]! * areaM2;
      }
    }
  }
  return total;
}

// 全層を足した列質量を行・列へ射影して返す。
function columnMassByRowColumn(
  field: CloudGlobalMassField,
): { readonly byRow: number[]; readonly byColumn: number[] } {
  const layerCount = field.layerEdgesM.length - 1;
  const cellCount = field.width * field.height;
  const byRow = new Array<number>(field.height).fill(0);
  const byColumn = new Array<number>(field.width).fill(0);
  for (let layer = 0; layer < layerCount; layer += 1) {
    const base = layer * cellCount;
    for (let index = 0; index < cellCount; index += 1) {
      const mass = field.liquidKgM2[base + index]! + field.iceKgM2[base + index]!;
      byRow[Math.floor(index / field.width)]! += mass;
      byColumn[index % field.width]! += mass;
    }
  }
  return { byRow, byColumn };
}

export function register(): void {
  // 均一な湿潤環境での導出結果。複数ケースが同じ場を読むので1度だけ導く。
  let sharedResult: CloudGlobalFieldSupplyResult | null = null;
  const shared = (): CloudGlobalFieldSupplyResult => {
    sharedResult ??= makeSupply(() => makeEnvironment()).derive(43_200);
    return sharedResult;
  };

  test('cloud global field supply: 同じ時刻には同じ場を返し、質量が載る', () => {
    const supply = makeSupply(() => makeEnvironment());
    const first = supply.derive(43_200);
    const second = supply.derive(43_200);
    assert.deepEqual(second.field, first.field);
    assert.deepEqual(second.eventMassKgByPhase, first.eventMassKgByPhase);
    // 生成経路から実際に雲が載っている。
    assert.ok(first.eventCount > 0);
    assert.ok(depositedMassKg(first.field, 'liquid')
      + depositedMassKg(first.field, 'ice') > 0);
  });

  test('cloud global field supply: 別の時刻には別のイベント履歴が乗る', () => {
    const supply = makeSupply(() => makeEnvironment());
    const earlier = supply.derive(7_200);
    const later = supply.derive(43_200);
    assert.notDeepEqual(earlier.field.liquidKgM2, later.field.liquidKgM2);
  });

  test('cloud global field supply: 質量収支が相別に保たれる', () => {
    const result = shared();
    for (const phase of ['liquid', 'ice'] as const) {
      const depositedKg = depositedMassKg(result.field, phase);
      const expectedKg = result.eventMassKgByPhase[phase];
      const unassignedKg = result.unassignedMassKgByPhase[phase];
      const balanceKg = depositedKg + unassignedKg;
      const toleranceKg = Math.max(1e-6, Math.abs(expectedKg) * 1e-9);
      assert.ok(
        Math.abs(balanceKg - expectedKg) <= toleranceKg,
        `${phase}: deposited ${depositedKg} + unassigned ${unassignedKg} != supplied ${expectedKg}`);
    }
  });

  test('cloud global field supply: 分割ジョブは同期導出と同じ場を返す', () => {
    const supply = makeSupply(() => makeEnvironment());
    const direct = supply.derive(43_200);
    const job = supply.startJob(43_200);
    while (!job.step(20).done) {
      assert.equal(job.result, null); // 完成まで途中経過は出さない
    }
    const stepped = job.result;
    assert.ok(stepped !== null);
    assert.deepEqual(stepped, direct);
  });

  test('cloud global field supply: ゼロ予算でも反復すれば完成する', () => {
    const supply = makeSupply(() => makeEnvironment());
    const job = supply.startJob(43_200);
    // 1回の駆動では終わらない — セルは全球に数千あり、1駆動1単位より先へ進めない。
    assert.equal(job.step(0).done, false);
    let steps = 1;
    while (!job.step(0).done) {
      steps += 1;
      if (steps > 200_000) throw new Error('job did not finish');
    }
    assert.ok(steps > 1);
    assert.ok(job.result !== null);
    // 完成以後の駆動は done のまま。
    assert.equal(job.step(0).done, true);
  });

  test('cloud global field supply: 環境はセル位置ごとに表示時刻で引かれる', () => {
    const environment = makeEnvironment();
    const calls: { direction: Vec3; time: number }[] = [];
    const supply = makeSupply((direction, timeSeconds) => {
      calls.push({ direction, time: timeSeconds });
      return environment;
    });
    supply.derive(43_200);
    // 全球のセルぶんの引き出しが行われ、どれも単位方向・表示時刻である。
    assert.ok(calls.length >= 1_000);
    for (const call of calls) {
      assert.ok(
        Math.abs(Math.hypot(call.direction.x, call.direction.y, call.direction.z) - 1) < 1e-9);
      assert.equal(call.time, 43_200);
    }
    // セルは全球に散るので、引かれた方向は全セル同一ではない。
    const uniqueLatitudes = new Set(calls.map((c) => c.direction.y.toPrecision(6)));
    const uniqueLongitudes = new Set(calls.map(
      (c) => Math.atan2(c.direction.x, c.direction.z).toPrecision(6)));
    assert.ok(uniqueLatitudes.size > 10);
    assert.ok(uniqueLongitudes.size > 10);
  });

  test('cloud global field supply: 方向で変わる環境は質量分布を変える', () => {
    // 北(y>0)だけ水供給のある環境源。北のセルだけがイベントを起こす。
    const humid = makeEnvironment();
    const dry = makeDryEnvironment();
    const result = makeSupply(
      (direction) => (direction.y > 0 ? humid : dry)).derive(43_200);
    const { byRow } = columnMassByRowColumn(result.field);
    // 行 0 が北極側。北半分の行質量と南半分の行質量を分けて集計する。
    const half = Math.floor(GRID_HEIGHT / 2);
    const north = byRow.slice(0, half).reduce((total, mass) => total + mass, 0);
    const south = byRow.slice(half).reduce((total, mass) => total + mass, 0);
    assert.ok(north > 0);
    // 風でわずかに運ばれても、南半分へ届く質量は北よりはるかに小さい。
    assert.ok(north > south);
  });

  test('cloud global field supply: 極帯と日付変更線の列にも質量が載る', () => {
    const result = shared();
    const { byRow, byColumn } = columnMassByRowColumn(result.field);
    // 全球にセルを張った均一環境では、極に近い帯にもイベントが生まれる。
    const polarRows = [...byRow.slice(0, 4), ...byRow.slice(-4)];
    assert.ok(polarRows.reduce((total, mass) => total + mass, 0) > 0);
    // 列 0 の西端は -π(日付変更線)。その両側の列にも輸送・堆積が届く。
    const datelineColumns = [...byColumn.slice(0, 4), ...byColumn.slice(-4)];
    assert.ok(datelineColumns.reduce((total, mass) => total + mass, 0) > 0);
  });

  test('cloud global field supply: 非有限・不正な入力は RangeError', () => {
    const supply = makeSupply(() => makeEnvironment());
    assert.throws(() => supply.derive(Number.NaN), RangeError);
    assert.throws(() => supply.startJob(Number.POSITIVE_INFINITY), RangeError);
    assert.throws(
      () => new ConvectiveCloudGlobalFieldSupply(
        () => makeEnvironment(), 7, -1, GRID_WIDTH, GRID_HEIGHT, windAt()),
      RangeError);
    assert.throws(
      () => new ConvectiveCloudGlobalFieldSupply(
        () => makeEnvironment(), Number.NaN, RADIUS_M, GRID_WIDTH, GRID_HEIGHT, windAt()),
      RangeError);
    assert.throws(
      () => new ConvectiveCloudGlobalFieldSupply(
        () => makeEnvironment(), 7, RADIUS_M, 0, GRID_HEIGHT, windAt()),
      RangeError);
    assert.throws(
      () => new ConvectiveCloudGlobalFieldSupply(
        () => makeEnvironment(), 7, RADIUS_M, GRID_WIDTH, 0, windAt()),
      RangeError);
    assert.throws(
      () => new ConvectiveCloudGlobalFieldSupply(
        null as never, 7, RADIUS_M, GRID_WIDTH, GRID_HEIGHT, windAt()),
      TypeError);
    assert.throws(
      () => new ConvectiveCloudGlobalFieldSupply(
        () => makeEnvironment(), 7, RADIUS_M, GRID_WIDTH, GRID_HEIGHT, null as never),
      TypeError);
    const job = supply.startJob(43_200);
    assert.throws(() => job.step(Number.NaN), RangeError);
  });
}
