import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { createCloudEnvironmentProfile } from '../../src/game/cloud/cloud-environment';
import type {
  CloudEnvironmentLevelInput, CloudEnvironmentProfile,
} from '../../src/game/cloud/cloud-environment';
import {
  ConvectiveCloudGlobalFieldJob,
  ConvectiveCloudGlobalFieldSupply,
  globalEventCellBands,
  mergeCloudGlobalFieldSupplyResults,
  type CloudGlobalFieldSupplyResult,
} from '../../src/game/cloud/cloud-global-field-supply';
import {
  ConvectiveCloudGlobalFieldWorkerSupply,
  type CloudGlobalFieldWorkerPort,
} from '../../src/game/cloud/cloud-global-field-worker-client';
import { AtmosphericWindField } from '../../src/render/cloud/atmospheric-wind';
import { validateCloudGlobalMassField } from '../../src/render/cloud/global-mass-field';
import { makeWindAt } from '../../src/game/cloud/cloud-local-field-supply';
import type { CloudEventWindAt } from '../../src/game/cloud/cloud-event-transport';
import type {
  CloudGlobalFieldWorkerMessage, CloudGlobalFieldWorkerReply,
} from '../../src/game/cloud/cloud-global-field-worker';

const RADIUS_M = 6_378_137;
const GRID_WIDTH = 128;
const GRID_HEIGHT = 64;
const CELL_SPACING_M = 450e3;
const SEED = 7;
const SIDEREAL_DAY = 86164.0905;

function windAt(): CloudEventWindAt {
  return makeWindAt(new AtmosphericWindField());
}

// 熱帯の深対流を代表する単一柱。cloud-global-field-supply.test.ts と同じ固定入力。
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

function makeSupply(): ConvectiveCloudGlobalFieldSupply {
  return new ConvectiveCloudGlobalFieldSupply(
    () => makeEnvironment(), SEED, RADIUS_M, GRID_WIDTH, GRID_HEIGHT, windAt());
}

// 帯 range の導出を同期で走らせて部分結果を返す。worker が行う駆動そのまま。
function deriveBand(bandIndexStart: number, bandIndexEnd: number): CloudGlobalFieldSupplyResult {
  const job = new ConvectiveCloudGlobalFieldJob(
    43_200, () => makeEnvironment(), SEED, RADIUS_M, GRID_WIDTH, GRID_HEIGHT,
    windAt(), CELL_SPACING_M, bandIndexStart, bandIndexEnd);
  job.step(Number.POSITIVE_INFINITY);
  const result = job.result;
  assert.ok(result !== null);
  return result;
}

// 浮動小数の加算順が帯の分割で変わるぶんだけ、場の各要素は最下位桁でずれうる。
// kg/m² 桁の値に対して絶対 1e-9 は実質的な一致の判定になる。
function assertFieldClose(actual: Float64Array, expected: Float64Array, label: string): void {
  assert.equal(actual.length, expected.length);
  let maxDiff = 0;
  for (let index = 0; index < actual.length; index += 1) {
    maxDiff = Math.max(maxDiff, Math.abs(actual[index]! - expected[index]!));
  }
  assert.ok(maxDiff <= 1e-9, `${label}: max element diff ${maxDiff}`);
}

function assertResultClose(
  actual: CloudGlobalFieldSupplyResult, expected: CloudGlobalFieldSupplyResult,
): void {
  assert.equal(actual.field.width, expected.field.width);
  assert.equal(actual.field.height, expected.field.height);
  assertFieldClose(actual.field.liquidKgM2, expected.field.liquidKgM2, 'liquid');
  assertFieldClose(actual.field.iceKgM2, expected.field.iceKgM2, 'ice');
  assert.equal(actual.eventCount, expected.eventCount);
  assert.ok(Math.abs(actual.eventMassKgByPhase.liquid - expected.eventMassKgByPhase.liquid)
    <= 1e-6 * Math.max(1, expected.eventMassKgByPhase.liquid));
  assert.ok(Math.abs(actual.unassignedMassKgByPhase.liquid
    - expected.unassignedMassKgByPhase.liquid)
    <= 1e-6 * Math.max(1, expected.unassignedMassKgByPhase.liquid));
}

// 気候画素を持たない供給口。worker client の遅延供給が null を返し続けるだけの形。
const noClimate = { climatePixels: () => null };

// 画素を持つ供給口。init メッセージへ実画素が載る経路を見るための形。
const someClimate = {
  climatePixels: () => ({ width: 2, height: 1, data: new Uint8Array(2 * 1 * 4).fill(7) }),
};

// 応答を同期で返す模造 worker。postMessage の中で要求を組立て側へ見せ、
// derive には決め打ちの格子形の部分場で応答する。
class MockWorkerPort implements CloudGlobalFieldWorkerPort {
  public onmessage:
    ((event: { readonly data: CloudGlobalFieldWorkerReply }) => void) | null = null;
  public onerror: ((event: ErrorEvent) => void) | null = null;
  public readonly posted: CloudGlobalFieldWorkerMessage[] = [];
  public terminated = false;
  // 応答しない要求を残したい検査のため、false の間は derive へ応答しない。
  public responds = true;

  public postMessage(message: unknown): void {
    const request = message as CloudGlobalFieldWorkerMessage;
    this.posted.push(request);
    if (request.kind !== 'derive' || !this.responds) return;
    const layerCount = 4;
    const texelCount = request.gridWidth * request.gridHeight * layerCount;
    this.onmessage?.({ data: {
      kind: 'result',
      id: request.id,
      width: request.gridWidth,
      height: request.gridHeight,
      sphereRadiusM: request.sphereRadiusM,
      layerEdgesM: [0, 1_500, 4_000, 7_000, 10_000],
      liquidKgM2: new Float64Array(texelCount).fill(0.5),
      iceKgM2: new Float64Array(texelCount).fill(0.25),
      eventMassKgByPhase: { liquid: 1, ice: 0.5 },
      unassignedMassKgByPhase: { liquid: 0, ice: 0 },
      eventCount: 1,
      truncatedEventCount: 0,
      omittedMassUpperBoundKgM2: 0.001,
    } });
  }

  public terminate(): void {
    this.terminated = true;
  }
}

export function register(): void {
  test('cloud global field worker: 帯分割の merge は全体導出と一致する', () => {
    const whole = makeSupply().derive(43_200);
    const bandCount = globalEventCellBands(RADIUS_M, CELL_SPACING_M).length;
    for (const rangeCount of [1, 2, 3, bandCount]) {
      const width = Math.ceil(bandCount / rangeCount);
      const parts: CloudGlobalFieldSupplyResult[] = [];
      for (let start = 0; start < bandCount; start += width) {
        parts.push(deriveBand(start, Math.min(start + width, bandCount)));
      }
      assertResultClose(mergeCloudGlobalFieldSupplyResults(parts), whole);
    }
  });

  test('cloud global field worker: 帯 range の境界外は RangeError', () => {
    const bandCount = globalEventCellBands(RADIUS_M, CELL_SPACING_M).length;
    const make = (start: number, end: number): ConvectiveCloudGlobalFieldJob =>
      new ConvectiveCloudGlobalFieldJob(
        43_200, () => makeEnvironment(), SEED, RADIUS_M, GRID_WIDTH, GRID_HEIGHT,
        windAt(), CELL_SPACING_M, start, end);
    assert.throws(() => make(-1, 1), RangeError);
    assert.throws(() => make(0.5, 1), RangeError);
    assert.throws(() => make(2, 1), RangeError);
    assert.throws(() => make(0, bandCount + 1), RangeError);
    // 空 range は合法的な分割(並列度 > 帯数)なので投げず、空の場を返す。
    const empty = make(bandCount, bandCount);
    empty.step(Number.POSITIVE_INFINITY);
    assert.ok(empty.result !== null);
    assert.ok(empty.result.field.liquidKgM2.every((value) => value === 0));
    assert.equal(empty.result.eventCount, 0);
  });

  test('cloud global field worker: client は GlobalMassFieldSupply 契約を満たす', () => {
    const ports: MockWorkerPort[] = [];
    const supply = new ConvectiveCloudGlobalFieldWorkerSupply(
      makeSupply(), noClimate, RADIUS_M, SIDEREAL_DAY, 3,
      () => {
        const port = new MockWorkerPort();
        ports.push(port);
        return port;
      });
    const job = supply.startJob(43_200);
    // 同期応答の模造なので、開始の時点ですべての帯の応答は届いている。
    assert.equal(job.step(0).done, true);
    const result = job.result as CloudGlobalFieldSupplyResult | null;
    assert.ok(result !== null);
    validateCloudGlobalMassField(result.field);
    // worker 数ぶんの帯要求が投げられ、各 worker は init を先に受けている。
    assert.equal(ports.length, 3);
    for (const port of ports) {
      assert.equal(port.posted[0]?.kind, 'init');
      assert.ok(port.posted.some((message) => message.kind === 'derive'));
    }
    // 3帯の部分場(0.5 + 0.25)が merge されている。
    const texel = GRID_WIDTH * GRID_HEIGHT + 7;
    assert.equal(result.field.liquidKgM2[texel], 1.5);
    assert.equal(result.field.iceKgM2[texel], 0.75);
    assert.equal(result.eventCount, 3);
    assert.equal(result.truncatedEventCount, 0);
    assert.equal(result.omittedMassUpperBoundKgM2, 0.003);
  });

  test('cloud global field worker: init の気候画素は worker ごとに独立したバッファを持つ', () => {
    const ports: MockWorkerPort[] = [];
    const supply = new ConvectiveCloudGlobalFieldWorkerSupply(
      makeSupply(), someClimate, RADIUS_M, SIDEREAL_DAY, 3,
      () => {
        const port = new MockWorkerPort();
        ports.push(port);
        return port;
      });
    const job = supply.startJob(43_200);
    job.step(0);
    // 転送はバッファの所有権を移すので、同じ画素列でも worker ごとに別の写しが
    // 届く — 共有の1枚を連続して転送すると、2人目以降の postMessage が投げる。
    const inits = ports.map((port) => {
      const init = port.posted.find((message) => message.kind === 'init');
      assert.ok(init !== undefined && init.kind === 'init');
      assert.ok(init.climatePixels !== null);
      return init.climatePixels;
    });
    assert.equal(inits.length, 3);
    for (const pixels of inits) {
      assert.deepEqual([...pixels!.data], new Array(8).fill(7));
    }
    const buffers = new Set(inits.map((pixels) => pixels!.data.buffer));
    assert.equal(buffers.size, 3);
  });

  test('cloud global field worker: 応答の無い帯があるあいだ done は立たず、cancel で畳める', () => {
    const ports: MockWorkerPort[] = [];
    const supply = new ConvectiveCloudGlobalFieldWorkerSupply(
      makeSupply(), noClimate, RADIUS_M, SIDEREAL_DAY, 2,
      () => {
        const port = new MockWorkerPort();
        ports.push(port);
        return port;
      });
    // 2番目の worker だけ応答しない。先の job では両方応答するので完了する。
    const job = supply.startJob(43_200);
    assert.equal(job.step(0).done, true);
    ports[1]!.responds = false;
    // 応答しない worker を含む次の job で途中経過と破棄を見る。
    const pendingJob = supply.startJob(43_201);
    assert.equal(pendingJob.step(0).done, false);
    assert.equal(pendingJob.result, null);
    pendingJob.cancel?.();
    assert.equal(pendingJob.step(0).done, true);
    assert.equal(pendingJob.result, null);
  });

  test('cloud global field worker: worker を組めない環境では同期供給へ落ちる', () => {
    const inner = makeSupply();
    // workerFactory へ null を渡した形は Worker の無い環境と同じ振る舞い。
    const supply = new ConvectiveCloudGlobalFieldWorkerSupply(
      inner, noClimate, RADIUS_M, SIDEREAL_DAY, 2, null);
    const job = supply.startJob(43_200);
    while (!job.step(Number.POSITIVE_INFINITY).done) { /* 完了まで駆動する */ }
    assert.deepEqual(job.result, inner.derive(43_200));
  });
}
