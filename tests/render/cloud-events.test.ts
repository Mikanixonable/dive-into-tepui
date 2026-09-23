import * as assert from 'node:assert/strict';
import {
  sampleConvectiveCloudEvents,
  type CloudEventDomain,
  type ConvectiveCloudCell,
} from '../../src/game/cloud/cloud-events';
import {
  reconstructCloudEventMaterialCohorts,
  reconstructCloudEventMaterialTracks,
} from '../../src/game/cloud/cloud-event-transport';
import { cross, norm, v3 } from '../../src/math/vec3';
import { advectSphericalPositionUnitVector } from '../../src/physics/cloud-spherical-transport';
import {
  iceEffectiveRadiusM,
  iceOpticalDepth,
  liquidEffectiveRadiusM,
  liquidOpticalDepth,
} from '../../src/physics/cloud-thermodynamics';
import { test } from '../harness';

function cell(id: string, overrides: Partial<ConvectiveCloudCell> = {}): ConvectiveCloudCell {
  return {
    id,
    supplySourceId: `source-${id}`,
    convectivePotential: 1,
    upperRelativeHumidity: 0.8,
    liquidSupplyRateKgM2S: 0.01,
    convectiveDurationSeconds: 900,
    ...overrides,
  };
}

function domain(overrides: Partial<CloudEventDomain> = {}): CloudEventDomain {
  return {
    seed: 12345,
    birthIntervalSeconds: 1_800,
    historyHorizonSeconds: 7_200,
    maximumOmittedMassKgM2: 1_000,
    maxEventCount: 100,
    timeSeconds: 1_800,
    cells: [cell('cell-a')],
    ...overrides,
  };
}

function eventAt(timeSeconds: number, source = cell('cell-a')) {
  const sample = sampleConvectiveCloudEvents(domain({
    timeSeconds,
    historyHorizonSeconds: 36_000,
    cells: [source],
  }));
  const event = sample.events.find((item) => item.birthEpoch === 0);
  assert.ok(event, `expected epoch 0 event at ${timeSeconds}s`);
  return event;
}

function closeTo(actual: number, expected: number, tolerance = 1e-12): void {
  assert.ok(Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)),
    `${actual} is not within ${tolerance} relative tolerance of ${expected}`);
}

function altitudeSplitWind(direction: ReturnType<typeof v3>, heightM: number, vertical = false) {
  const horizontalRadius = Math.hypot(direction.x, direction.z);
  const east = horizontalRadius > 1e-12
    ? v3(direction.z / horizontalRadius, 0, -direction.x / horizontalRadius)
    : v3(1, 0, 0);
  const north = norm(cross(direction, east));
  const lower = heightM < 5_000;
  const horizontal = lower ? east : north;
  return {
    tangentVelocityMPerS: v3(horizontal.x * 10, horizontal.y * 10, horizontal.z * 10),
    verticalVelocityMPerS: vertical && lower ? 0.1 : 0,
  };
}

interface NumericallyIntegratedMass {
  readonly suppliedKgM2: number;
  readonly liquidKgM2: number;
  readonly iceKgM2: number;
  readonly lostKgM2: number;
}

function integrateEventMass(cellSource: ConvectiveCloudCell, targetSeconds: number): NumericallyIntegratedMass {
  const dtSeconds = 1;
  const releaseSteps = Math.round(15 * 60 / dtSeconds);
  const liquidDecayPerSecond = 1 / (20 * 60);
  const iceDecayPerSecond = (1 + (1 - cellSource.upperRelativeHumidity) * 4) / (2 * 3_600);
  const liquidSurvivalOfContinuousInput = -Math.expm1(-liquidDecayPerSecond * dtSeconds)
    / (liquidDecayPerSecond * dtSeconds);
  const iceSurvivalOfContinuousInput = -Math.expm1(-iceDecayPerSecond * dtSeconds)
    / (iceDecayPerSecond * dtSeconds);
  const pendingReleaseKgM2: number[] = [];
  let liquidBaseKgM2 = 0;
  let pendingLiquidKgM2 = 0;
  let iceKgM2 = 0;
  let suppliedKgM2 = 0;
  let lostKgM2 = 0;
  for (let step = 0; step < targetSeconds / dtSeconds; step += 1) {
    const elapsedAtStartSeconds = step * dtSeconds;
    const supplyKgM2 = elapsedAtStartSeconds < cellSource.convectiveDurationSeconds
      ? cellSource.liquidSupplyRateKgM2S * dtSeconds
      : 0;
    suppliedKgM2 += supplyKgM2;
    const newLiquidInputKgM2 = supplyKgM2 * (1 - 0.35);
    const oldLiquidSurvival = Math.exp(-liquidDecayPerSecond * dtSeconds);
    const liquidLossKgM2 = liquidBaseKgM2 * (1 - oldLiquidSurvival)
      + newLiquidInputKgM2 * (1 - liquidSurvivalOfContinuousInput);
    liquidBaseKgM2 = liquidBaseKgM2 * oldLiquidSurvival
      + newLiquidInputKgM2 * liquidSurvivalOfContinuousInput;
    lostKgM2 += liquidLossKgM2;

    const newPendingKgM2 = supplyKgM2 * 0.35;
    pendingReleaseKgM2.push(newPendingKgM2);
    pendingLiquidKgM2 += newPendingKgM2;
    const releaseKgM2 = step >= releaseSteps ? pendingReleaseKgM2[step - releaseSteps]! : 0;
    pendingLiquidKgM2 -= releaseKgM2;
    const oldIceSurvival = Math.exp(-iceDecayPerSecond * dtSeconds);
    const iceLossKgM2 = iceKgM2 * (1 - oldIceSurvival)
      + releaseKgM2 * (1 - iceSurvivalOfContinuousInput);
    iceKgM2 = iceKgM2 * oldIceSurvival + releaseKgM2 * iceSurvivalOfContinuousInput;
    lostKgM2 += iceLossKgM2;
  }
  return { suppliedKgM2, liquidKgM2: liquidBaseKgM2 + pendingLiquidKgM2, iceKgM2, lostKgM2 };
}

export function register(): void {
  test('cloud events: C3供給停止後も放出済み氷が有限寿命で残る', () => {
    const afterCessation = eventAt(1_800);
    assert.equal(afterCessation.supplyActive, false);
    assert.ok(afterCessation.iceRelease.releasedKgM2 > 0);
    assert.ok(afterCessation.iceRelease.remainingKgM2 > 0);
    assert.ok(afterCessation.iceRelease.remainingKgM2 < afterCessation.iceRelease.releasedKgM2);

    const later = eventAt(28_800);
    assert.equal(later.supplyActive, false);
    assert.ok(later.iceRelease.remainingKgM2 < afterCessation.iceRelease.remainingKgM2);
    assert.ok(later.iceRelease.remainingKgM2 > 0);
  });

  test('cloud events: C4乾燥した上層ほど氷損失が増え残存氷量が減る', () => {
    const humid = eventAt(7_200, cell('cell-a', { upperRelativeHumidity: 1 }));
    const dry = eventAt(7_200, cell('cell-a', { upperRelativeHumidity: 0 }));
    assert.ok(dry.mass.lostKgM2 > humid.mass.lostKgM2);
    assert.ok(dry.mass.iceKgM2 < humid.mass.iceKgM2);
    assert.ok(dry.iceRelease.remainingKgM2 < humid.iceRelease.remainingKgM2);
  });

  test('cloud events: C6供給量を倍にすると初期・供給・液水・氷が線形に増える', () => {
    const base = eventAt(1_800, cell('cell-a', { liquidSupplyRateKgM2S: 0.01 }));
    const doubled = eventAt(1_800, cell('cell-a', { liquidSupplyRateKgM2S: 0.02 }));
    assert.equal(base.mass.initialKgM2, 0);
    closeTo(doubled.mass.suppliedKgM2, 2 * base.mass.suppliedKgM2);
    closeTo(doubled.mass.liquidKgM2, 2 * base.mass.liquidKgM2);
    closeTo(doubled.mass.iceKgM2, 2 * base.mass.iceKgM2);
  });

  test('cloud events: 初期量+供給-損失=液水+氷を各年齢で満たし質量は非負', () => {
    for (const timeSeconds of [1, 300, 900, 1_800, 7_200, 28_800]) {
      const { mass } = eventAt(timeSeconds);
      for (const value of Object.values(mass)) assert.ok(value >= 0);
      closeTo(
        mass.initialKgM2 + mass.suppliedKgM2 - mass.lostKgM2,
        mass.liquidKgM2 + mass.iceKgM2,
      );
    }
  });

  test('cloud events: C3供給停止後と放出中の解析解が1秒数値積分へ収束する', () => {
    for (const upperRelativeHumidity of [0.2, 1]) {
      const source = cell('integrated', { upperRelativeHumidity });
      for (const timeSeconds of [1_350, 2_700]) {
        const analytic = eventAt(timeSeconds, source).mass;
        const numeric = integrateEventMass(source, timeSeconds);
        closeTo(analytic.suppliedKgM2, numeric.suppliedKgM2, 1e-12);
        closeTo(analytic.liquidKgM2, numeric.liquidKgM2, 2e-5);
        closeTo(analytic.iceKgM2, numeric.iceKgM2, 2e-5);
        closeTo(analytic.lostKgM2, numeric.lostKgM2, 2e-5);
      }
    }
  });

  test('cloud events: column質量はphysicsの粒径閉包と液水・氷の光学厚へ接続できる', () => {
    const { mass } = eventAt(2_700);
    const dryAirDensityKgPerM3 = 1.0;
    const layerDepthM = 1_000;
    const liquidMixingRatioKgPerKg = mass.liquidKgM2 / (dryAirDensityKgPerM3 * layerDepthM);
    const iceMixingRatioKgPerKg = mass.iceKgM2 / (dryAirDensityKgPerM3 * layerDepthM);
    const liquidRadiusM = liquidEffectiveRadiusM(dryAirDensityKgPerM3, liquidMixingRatioKgPerKg, 100e6);
    const iceRadiusM = iceEffectiveRadiusM(dryAirDensityKgPerM3, iceMixingRatioKgPerKg, 1e5);
    assert.ok(liquidRadiusM !== null && liquidRadiusM > 0);
    assert.ok(iceRadiusM !== null && iceRadiusM > 0);
    const liquidTau = liquidOpticalDepth(mass.liquidKgM2, liquidRadiusM);
    const iceTau = iceOpticalDepth(mass.iceKgM2, iceRadiusM, 2);
    assert.ok(Number.isFinite(liquidTau) && liquidTau > 0);
    assert.ok(Number.isFinite(iceTau) && iceTau > 0);
  });

  test('cloud events: 時刻を逆順に評価しても同じ epoch の結果へ戻る', () => {
    const times = [7_200, 1_800, 3_600, 600];
    const reverse = [...times].reverse();
    const evaluate = (timeSeconds: number) => sampleConvectiveCloudEvents(
      domain({ timeSeconds }),
    ).events.find((item) => item.birthEpoch === 0);
    const forwardResults = times.map(evaluate);
    const reverseResults = reverse.map(evaluate).reverse();
    assert.deepEqual(reverseResults, forwardResults);
  });

  test('cloud events: セル列挙順と重複呼び出しは ID とイベント値を変えない', () => {
    const cells = [cell('cell-c'), cell('cell-a'), cell('cell-b')];
    const first = sampleConvectiveCloudEvents(domain({ timeSeconds: 3_600, cells }));
    const reordered = sampleConvectiveCloudEvents(domain({
      timeSeconds: 3_600,
      cells: [...cells].reverse(),
    }));
    assert.deepEqual(reordered, first);
    assert.deepEqual(sampleConvectiveCloudEvents(domain({ timeSeconds: 3_600, cells })), first);
    assert.equal(new Set(first.events.map((item) => item.id)).size, first.events.length);
    for (const event of first.events) {
      assert.equal(event.iceRelease.parentEventId, event.id);
      assert.equal(event.iceRelease.id, `${event.id}:ice`);
    }
  });

  test('cloud events: 有限 horizon と件数上限は並べ替えても同じ上限部分集合を返す', () => {
    const cells = ['a', 'b', 'c', 'd'].map((id) => cell(id, { convectiveDurationSeconds: 300 }));
    const sample = sampleConvectiveCloudEvents(domain({
      timeSeconds: 3_600,
      birthIntervalSeconds: 600,
      historyHorizonSeconds: 1_200,
      maxEventCount: 2,
      cells,
    }));
    const reordered = sampleConvectiveCloudEvents(domain({
      timeSeconds: 3_600,
      birthIntervalSeconds: 600,
      historyHorizonSeconds: 1_200,
      maxEventCount: 2,
      cells: [...cells].reverse(),
    }));
    assert.equal(sample.events.length, 2);
    assert.equal(sample.truncatedEventCount, 6);
    assert.ok(sample.truncatedMassKgM2 > 0);
    assert.deepEqual(reordered, sample);
    assert.ok(sample.events.every((item) => item.birthTimeSeconds >= 2_400));
    assert.ok(sample.omittedMassUpperBoundKgM2 > 0);
  });

  test('cloud events: horizon上界と件数切り捨て質量の合計が予算を超えたら拒否する', () => {
    const cells = ['a', 'b'].map((id) => cell(id, { liquidSupplyRateKgM2S: 0.1 }));
    const domainSettings: Partial<CloudEventDomain> = {
      timeSeconds: 3_600,
      historyHorizonSeconds: 1_800,
      maxEventCount: 1,
      cells,
    };
    const sample = sampleConvectiveCloudEvents(domain({
      ...domainSettings,
      maximumOmittedMassKgM2: 1_000,
    }));
    assert.equal(sample.truncatedEventCount, 1);
    assert.ok(sample.truncatedMassKgM2 > 0);
    assert.throws(() => sampleConvectiveCloudEvents(domain({
      ...domainSettings,
      maximumOmittedMassKgM2: sample.omittedMassUpperBoundKgM2,
    })), /horizon and count-truncation mass exceed/);
  });

  test('cloud events: omitted mass予算は短いhorizonを拒否し、長いhorizonで上界を返す', () => {
    const source = cell('tail');
    assert.throws(() => sampleConvectiveCloudEvents(domain({
      historyHorizonSeconds: 1_799,
      maximumOmittedMassKgM2: 1_000,
      cells: [source],
    })), /shorter than the event release tail/);
    assert.throws(() => sampleConvectiveCloudEvents(domain({
      historyHorizonSeconds: 36_000,
      maximumOmittedMassKgM2: 0.1,
      cells: [source],
    })), /upper bound exceeds/);
    const sample = sampleConvectiveCloudEvents(domain({
      historyHorizonSeconds: 36_000,
      maximumOmittedMassKgM2: 1,
      cells: [source],
    }));
    assert.ok(sample.omittedMassUpperBoundKgM2 > 0);
    assert.ok(sample.omittedMassUpperBoundKgM2 <= 1);
  });

  test('cloud events: ID は seed・セル・出生 epoch で変わり時刻には依存しない', () => {
    const initial = eventAt(1_800);
    const later = eventAt(7_200);
    const otherSeed = sampleConvectiveCloudEvents(domain({ seed: 54321 })).events
      .find((item) => item.birthEpoch === 0);
    const otherCell = sampleConvectiveCloudEvents(domain({ cells: [cell('cell-b')] })).events
      .find((item) => item.birthEpoch === 0);
    assert.equal(initial.id, later.id);
    assert.notEqual(initial.id, otherSeed?.id);
    assert.notEqual(initial.id, otherCell?.id);
  });

  test('cloud event transport: shutdown後も親と放出氷を別高度の風で運び質量を保つ', () => {
    const source = cell('located', {
      sourcePosition: { directionUnitVector: v3(0, 0, 1), geometricHeightM: 1_000 },
      iceReleaseHeightM: 7_000,
    });
    const event = eventAt(7_200, source);
    assert.equal(event.supplyActive, false);
    assert.ok(event.iceRelease.remainingKgM2 > 0);
    assert.ok(event.iceRelease.meanReleaseTimeSeconds! >= 15 * 60);
    assert.ok(event.iceRelease.meanReleaseTimeSeconds! <= 30 * 60);
    const tracks = reconstructCloudEventMaterialTracks(
      event, 6_371_000, 30, (direction, heightM) => altitudeSplitWind(direction, heightM),
    );
    assert.ok(tracks.parent !== null);
    assert.ok(tracks.releasedIce !== null);
    assert.ok(tracks.parent!.directionUnitVector.x > tracks.parent!.directionUnitVector.y);
    assert.ok(tracks.releasedIce!.directionUnitVector.y > tracks.releasedIce!.directionUnitVector.x);
    closeTo(tracks.parent!.massKgM2, event.mass.liquidKgM2);
    closeTo(tracks.releasedIce!.massKgM2, event.mass.iceKgM2);
    closeTo(
      tracks.totalMassKgM2,
      event.mass.initialKgM2 + event.mass.suppliedKgM2 - event.mass.lostKgM2,
    );
  });

  test('cloud event transport: 放出氷は放出時刻までに移流した親の位置から上層風へ渡る', () => {
    const source = cell('located', {
      sourcePosition: { directionUnitVector: v3(0, 0, 1), geometricHeightM: 1_000 },
      iceReleaseHeightM: 7_000,
    });
    const event = eventAt(7_200, source);
    const tracks = reconstructCloudEventMaterialTracks(
      event,
      6_371_000,
      10,
      (direction, heightM) => {
        const east = altitudeSplitWind(direction, heightM).tangentVelocityMPerS;
        return { tangentVelocityMPerS: heightM < 5_000 ? east : v3(0, 0, 0), verticalVelocityMPerS: 0 };
      },
    );
    const expectedReleaseDirection = advectSphericalPositionUnitVector(
      v3(0, 0, 1), v3(10, 0, 0), 6_371_000 + 1_000,
      event.iceRelease.meanReleaseTimeSeconds!,
    );
    assert.ok(tracks.releasedIce !== null);
    assert.ok(Math.hypot(
      tracks.releasedIce!.directionUnitVector.x - expectedReleaseDirection.x,
      tracks.releasedIce!.directionUnitVector.y - expectedReleaseDirection.y,
      tracks.releasedIce!.directionUnitVector.z - expectedReleaseDirection.z,
    ) < 1e-12);
    assert.ok(Math.hypot(
      tracks.parent!.directionUnitVector.x - tracks.releasedIce!.directionUnitVector.x,
      tracks.parent!.directionUnitVector.y - tracks.releasedIce!.directionUnitVector.y,
      tracks.parent!.directionUnitVector.z - tracks.releasedIce!.directionUnitVector.z,
    ) > 1e-4);
  });

  test('cloud event transport: 上昇が親を上層風へ移し、風層の切替高度を保つ', () => {
    const source = cell('rising', {
      sourcePosition: { directionUnitVector: v3(0, 0, 1), geometricHeightM: 1_000 },
      iceReleaseHeightM: 7_000,
    });
    const event = eventAt(7_200, source);
    const tracks = reconstructCloudEventMaterialTracks(
      event,
      6_371_000,
      10,
      (direction, heightM) => ({
        ...altitudeSplitWind(direction, heightM),
        verticalVelocityMPerS: heightM < 5_000 ? 1 : 0,
      }),
    );
    assert.ok(tracks.parent !== null);
    closeTo(tracks.parent!.geometricHeightM, 5_000, 1e-10);
    assert.ok(tracks.parent!.directionUnitVector.x > 0);
    assert.ok(tracks.parent!.directionUnitVector.y > 0);
  });

  test('cloud event transport: same absolute time is deterministic after reverse-time cold evaluations', () => {
    const source = cell('located', {
      sourcePosition: { directionUnitVector: v3(0, 0, 1), geometricHeightM: 1_000 },
      iceReleaseHeightM: 7_000,
    });
    const evaluate = (timeSeconds: number) => {
      const event = eventAt(timeSeconds, source);
      return reconstructCloudEventMaterialTracks(
        event, 6_371_000, 30, (direction, heightM) => altitudeSplitWind(direction, heightM, true),
      );
    };
    const target = evaluate(7_200);
    evaluate(28_800);
    evaluate(600);
    assert.deepEqual(evaluate(7_200), target);
    assert.deepEqual(target, evaluate(7_200));
  });

  test('cloud events: 重複セル ID と探索上限超過は拒否する', () => {
    assert.throws(() => sampleConvectiveCloudEvents(domain({
      cells: [cell('same'), cell('same', { liquidSupplyRateKgM2S: 0.02 })],
    })), /duplicate cloud cell id/);
    assert.throws(() => sampleConvectiveCloudEvents(domain({
      cells: [
        cell('source-one', { supplySourceId: 'shared-source' }),
        cell('source-two', { supplySourceId: 'shared-source' }),
      ],
    })), /duplicate cloud supply source/);
    assert.throws(() => sampleConvectiveCloudEvents(domain({
      birthIntervalSeconds: 600,
      cells: [cell('overlap', { convectiveDurationSeconds: 900 })],
    })), /must not exceed birthIntervalSeconds/);
    assert.throws(() => sampleConvectiveCloudEvents(domain({
      cells: [cell('potential', { convectivePotential: 1.1 })],
    })), /convectivePotential must be between 0 and 1/);
    assert.throws(() => sampleConvectiveCloudEvents(domain({
      cells: [cell('humidity', { upperRelativeHumidity: -0.1 })],
    })), /upperRelativeHumidity must be between 0 and 1/);
    assert.throws(() => sampleConvectiveCloudEvents(domain({
      birthIntervalSeconds: 0.01,
      historyHorizonSeconds: 10_000,
      cells: [cell('bounded', { convectiveDurationSeconds: 0 })],
    })), /bounded event search/);
    assert.throws(() => sampleConvectiveCloudEvents(domain({
      timeSeconds: Number.MAX_VALUE,
      birthIntervalSeconds: Number.MIN_VALUE,
      cells: [cell('epoch', { convectiveDurationSeconds: 0 })],
    })), /safe integer epochs/);
  });

  test('cloud event transport: continuous release cohorts preserve mass and retain spatial spread', () => {
    const source = cell('cohorts', {
      sourcePosition: { directionUnitVector: v3(0, 0, 1), geometricHeightM: 1_000 },
      iceReleaseHeightM: 7_000,
      upperRelativeHumidity: 0.7,
    });
    const event = eventAt(7_200, source);
    const cohorts = reconstructCloudEventMaterialCohorts(
      event, 6_371_000, 10, 120,
      (direction, heightM) => altitudeSplitWind(direction, heightM),
    );
    assert.ok(cohorts.releasedIceCohorts.length > 1);
    const remaining = cohorts.releasedIceCohorts.reduce((sum, cohort) => sum + cohort.remainingKgM2, 0);
    closeTo(remaining, event.iceRelease.remainingKgM2, 1e-10);
    closeTo(
      cohorts.totalMassKgM2,
      event.mass.initialKgM2 + event.mass.suppliedKgM2 - event.mass.lostKgM2,
      1e-10,
    );
    const first = cohorts.releasedIceCohorts[0]!;
    const last = cohorts.releasedIceCohorts[cohorts.releasedIceCohorts.length - 1]!;
    assert.ok(first.representativeReleaseTimeSeconds < last.representativeReleaseTimeSeconds);
    assert.ok(Math.hypot(
      first.directionUnitVector.x - last.directionUnitVector.x,
      first.directionUnitVector.y - last.directionUnitVector.y,
      first.directionUnitVector.z - last.directionUnitVector.z,
    ) > 1e-6);
  });

  test('cloud event transport: cohort duration changes spatial resolution but not total remaining ice', () => {
    const source = cell('cohort-resolution', {
      sourcePosition: { directionUnitVector: v3(0, 0, 1), geometricHeightM: 1_000 },
      iceReleaseHeightM: 7_000,
      upperRelativeHumidity: 0.4,
    });
    const event = eventAt(7_200, source);
    const wind = (direction: ReturnType<typeof v3>, heightM: number) => altitudeSplitWind(direction, heightM);
    const coarse = reconstructCloudEventMaterialCohorts(event, 6_371_000, 30, 300, wind);
    const fine = reconstructCloudEventMaterialCohorts(event, 6_371_000, 30, 60, wind);
    assert.ok(fine.releasedIceCohorts.length > coarse.releasedIceCohorts.length);
    closeTo(coarse.totalMassKgM2, fine.totalMassKgM2, 1e-10);
    closeTo(coarse.totalMassKgM2, event.mass.liquidKgM2 + event.mass.iceKgM2, 1e-10);
  });

}
