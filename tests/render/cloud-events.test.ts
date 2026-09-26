import * as assert from 'node:assert/strict';
import {
  sampleConvectiveCloudEvents,
  type CloudEventDomain,
  type ConvectiveCloudCell,
  type ConvectiveCloudEvent,
} from '../../src/game/cloud/cloud-events';
import {
  reconstructCloudEventMaterialCohorts,
  reconstructCloudEventMaterialTracks,
} from '../../src/game/cloud/cloud-event-transport';
import { cross, norm, scale, v3 } from '../../src/math/vec3';
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

// 数値積分はサンプルしたイベントの有効パラメータをそのまま使う。
// イベント固有の散らしが入っているので、セル環境値ではなく lifecycle から取る。
function integrateEventMass(event: ConvectiveCloudEvent, targetSeconds: number): NumericallyIntegratedMass {
  const dtSeconds = 1;
  const releaseSteps = Math.round(15 * 60 / dtSeconds);
  const liquidDecayPerSecond = 1 / (20 * 60);
  const iceDecayPerSecond = event.iceRelease.sublimationRatePerSecond;
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
    // 有効継続時間は秒に揃わないので、刻みの中の供給区間を厳密に取る。
    const suppliedInStepSeconds = Math.max(0,
      Math.min(elapsedAtStartSeconds + dtSeconds, event.lifecycle.convectiveDurationSeconds)
      - Math.min(elapsedAtStartSeconds, event.lifecycle.convectiveDurationSeconds));
    const supplyKgM2 = event.lifecycle.liquidSupplyRateKgM2S * suppliedInStepSeconds;
    suppliedKgM2 += supplyKgM2;
    const newLiquidInputKgM2 = supplyKgM2 * (1 - event.lifecycle.iceYieldFraction);
    const oldLiquidSurvival = Math.exp(-liquidDecayPerSecond * dtSeconds);
    const liquidLossKgM2 = liquidBaseKgM2 * (1 - oldLiquidSurvival)
      + newLiquidInputKgM2 * (1 - liquidSurvivalOfContinuousInput);
    liquidBaseKgM2 = liquidBaseKgM2 * oldLiquidSurvival
      + newLiquidInputKgM2 * liquidSurvivalOfContinuousInput;
    lostKgM2 += liquidLossKgM2;

    const newPendingKgM2 = supplyKgM2 * event.lifecycle.iceYieldFraction;
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
        const event = eventAt(timeSeconds, source);
        const analytic = event.mass;
        const numeric = integrateEventMass(event, timeSeconds);
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
    // イベント固有の継続時間の天井はセル値の1.5倍なので、horizon はその放出尾を
    // 収められる長さへ対になる継続時間を選ぶ。
    const cells = ['a', 'b', 'c', 'd'].map((id) => cell(id, { convectiveDurationSeconds: 200 }));
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
      // セルの継続時間 900 s のイベントは最大 1350 s 続きうるので、放出尾 2250 s を
      // 収める horizon が要る。
      historyHorizonSeconds: 2_400,
      maxEventCount: 1,
      cells,
    };
    const sample = sampleConvectiveCloudEvents(domain({
      ...domainSettings,
      maximumOmittedMassKgM2: 2_000,
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

  test('cloud event transport: 全放出氷コホートは解析質量と二層風の解析軌跡を保つ', () => {
    const source = cell('cohort-track', {
      sourcePosition: { directionUnitVector: v3(0, 0, 1), geometricHeightM: 1_000 },
      iceReleaseHeightM: 7_000,
    });
    const event = eventAt(7_200, source);
    const windAt = (direction: ReturnType<typeof v3>, heightM: number) => ({
      tangentVelocityMPerS: heightM < 5_000
        ? scale(cross(v3(0, 1, 0), direction), 10)
        : scale(cross(v3(-1, 0, 0), direction), 10),
      verticalVelocityMPerS: 0,
    });
    const tracks = reconstructCloudEventMaterialCohorts(event, 6_371_000, 5, windAt, 32);
    assert.equal(tracks.releasedIceCohorts.length, 32);
    closeTo(
      tracks.releasedIceCohorts.reduce((sum, cohort) => sum + cohort.massKgM2, 0),
      event.mass.iceKgM2,
      2e-14,
    );
    closeTo(tracks.totalMassKgM2, event.mass.liquidKgM2 + event.mass.iceKgM2, 2e-14);

    for (const cohort of tracks.releasedIceCohorts) {
      const lowerAngle = 10 * cohort.meanReleaseTimeSeconds / (6_371_000 + 1_000);
      const upperAngle = 10 * (7_200 - cohort.meanReleaseTimeSeconds) / (6_371_000 + 7_000);
      const expected = v3(
        Math.sin(lowerAngle),
        Math.cos(lowerAngle) * Math.sin(upperAngle),
        Math.cos(lowerAngle) * Math.cos(upperAngle),
      );
      const error = Math.hypot(
        cohort.directionUnitVector.x - expected.x,
        cohort.directionUnitVector.y - expected.y,
        cohort.directionUnitVector.z - expected.z,
      ) * (6_371_000 + 7_000);
      assert.ok(error < 0.05, `cohort ${cohort.cohortIndex} analytic path error ${error} m`);
      assert.ok(cohort.meanReleaseTimeSeconds >= cohort.releaseStartTimeSeconds);
      assert.ok(cohort.meanReleaseTimeSeconds <= cohort.releaseEndTimeSeconds);
    }
    assert.ok(tracks.releasedIceCohorts[0]!.directionUnitVector.y
      > tracks.releasedIceCohorts.at(-1)!.directionUnitVector.y);
  });

  test('cloud event transport: 分割数を増やすと質量加重位置が収束する', () => {
    const source = cell('cohort-convergence', {
      sourcePosition: { directionUnitVector: v3(0, 0, 1), geometricHeightM: 1_000 },
      iceReleaseHeightM: 7_000,
    });
    const event = eventAt(7_200, source);
    const windAt = (direction: ReturnType<typeof v3>, heightM: number) => ({
      tangentVelocityMPerS: heightM < 5_000
        ? scale(cross(v3(0, 1, 0), direction), 10)
        : scale(cross(v3(-1, 0, 0), direction), 10),
      verticalVelocityMPerS: 0,
    });
    const weightedDirection = (cohortCount: number) => {
      const cohorts = reconstructCloudEventMaterialCohorts(
        event, 6_371_000, 10, windAt, cohortCount,
      ).releasedIceCohorts;
      const mass = cohorts.reduce((sum, cohort) => sum + cohort.massKgM2, 0);
      return v3(
        cohorts.reduce((sum, cohort) => sum + cohort.directionUnitVector.x * cohort.massKgM2, 0) / mass,
        cohorts.reduce((sum, cohort) => sum + cohort.directionUnitVector.y * cohort.massKgM2, 0) / mass,
        cohorts.reduce((sum, cohort) => sum + cohort.directionUnitVector.z * cohort.massKgM2, 0) / mass,
      );
    };
    const coarse = weightedDirection(4);
    const fine = weightedDirection(32);
    const reference = weightedDirection(128);
    const error = (left: ReturnType<typeof v3>, right: ReturnType<typeof v3>) => Math.hypot(
      left.x - right.x, left.y - right.y, left.z - right.z,
    );
    assert.ok(error(fine, reference) < error(coarse, reference));
  });

  test('cloud event transport: 放出境界とコホート上限を検査する', () => {
    const source = cell('cohort-boundary', {
      sourcePosition: { directionUnitVector: v3(0, 0, 1), geometricHeightM: 1_000 },
      iceReleaseHeightM: 7_000,
    });
    const beforeRelease = eventAt(900, source);
    const atDelay = eventAt(15 * 60, source);
    const stationaryWind = () => ({
      tangentVelocityMPerS: v3(0, 0, 0), verticalVelocityMPerS: 0,
    });
    assert.equal(reconstructCloudEventMaterialCohorts(
      beforeRelease, 6_371_000, 30, stationaryWind,
    ).releasedIceCohorts.length, 0);
    assert.equal(atDelay.iceRelease.releaseStartTimeSeconds, null);
    assert.throws(() => reconstructCloudEventMaterialCohorts(
      beforeRelease, 6_371_000, 30, stationaryWind, 257,
    ), /cohortCount must be an integer/);
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

  test('cloud events: 同じセルのイベントは出生ごとに異なる寿命パラメータを持つ', () => {
    const source = cell('cell-a');
    const sample = sampleConvectiveCloudEvents(domain({
      timeSeconds: 36_000,
      historyHorizonSeconds: 36_000,
      cells: [source],
    }));
    assert.ok(sample.events.length >= 5);
    // 供給率・継続時間・氷収率・有効湿度のどれか1つでも全イベント一致なら、
    // 全イベントが同じ寿命曲線を描くことになる。
    const durations = new Set(sample.events.map((item) => item.lifecycle.convectiveDurationSeconds));
    const rates = new Set(sample.events.map((item) => item.lifecycle.liquidSupplyRateKgM2S));
    const yields = new Set(sample.events.map((item) => item.lifecycle.iceYieldFraction));
    const humidities = new Set(sample.events.map((item) => item.lifecycle.upperRelativeHumidity));
    assert.ok(durations.size > 1, 'all events share the same duration');
    assert.ok(rates.size > 1, 'all events share the same supply rate');
    assert.ok(yields.size > 1, 'all events share the same ice yield');
    assert.ok(humidities.size > 1, 'all events share the same effective humidity');
    for (const event of sample.events) {
      assert.equal(event.generation, 0);
      assert.equal(event.parentEventId, null);
      // ポテンシャル1では勢力係数が1なので、散らしの範囲は 0.5〜1.5 倍の内側。
      assert.ok(event.lifecycle.liquidSupplyRateKgM2S >= 0.5 * source.liquidSupplyRateKgM2S);
      assert.ok(event.lifecycle.liquidSupplyRateKgM2S <= 1.5 * source.liquidSupplyRateKgM2S);
      assert.ok(event.lifecycle.convectiveDurationSeconds > 0);
      assert.ok(event.lifecycle.convectiveDurationSeconds
        <= 1.5 * source.convectiveDurationSeconds);
      assert.ok(event.lifecycle.iceYieldFraction <= 1.5 * 0.35);
      assert.ok(event.lifecycle.upperRelativeHumidity >= 0);
      assert.ok(event.lifecycle.upperRelativeHumidity <= 1);
    }
    // 同一イベントは時刻を変えて評価しても同じ寿命パラメータを返す。
    const again = sampleConvectiveCloudEvents(domain({
      timeSeconds: 36_000,
      historyHorizonSeconds: 36_000,
      cells: [source],
    }));
    assert.deepEqual(again, sample);
  });

  test('cloud events: 弱い対流ポテンシャルのセルではイベントが短命・小規模になる', () => {
    // 同じセルID・seed・epoch では散らしの乱数が同じなので、両方のポテンシャルで生まれた
    // イベント同士を比べれば勢力係数の差だけが残る。
    const shared: Partial<CloudEventDomain> = {
      timeSeconds: 36_000,
      historyHorizonSeconds: 36_000,
    };
    const strong = sampleConvectiveCloudEvents(domain({
      ...shared,
      cells: [cell('cell-a', { convectivePotential: 1 })],
    }));
    const weak = sampleConvectiveCloudEvents(domain({
      ...shared,
      cells: [cell('cell-a', { convectivePotential: 0.3 })],
    }));
    const weakById = new Map(weak.events.map((item) => [item.id, item]));
    const pairs = strong.events
      .map((item) => ({ strong: item, weak: weakById.get(item.id) }))
      .filter((pair): pair is { strong: ConvectiveCloudEvent; weak: ConvectiveCloudEvent } => (
        pair.weak !== undefined
      ));
    assert.ok(pairs.length > 0);
    for (const pair of pairs) {
      assert.ok(pair.weak.lifecycle.liquidSupplyRateKgM2S
        < pair.strong.lifecycle.liquidSupplyRateKgM2S);
      assert.ok(pair.weak.lifecycle.convectiveDurationSeconds
        < pair.strong.lifecycle.convectiveDurationSeconds);
    }
  });

  const outflowWind = (direction: ReturnType<typeof v3>) => (
    scale(cross(v3(0, 1, 0), direction), 10)
  );

  function outflowDomain(overrides: Partial<CloudEventDomain> = {}): CloudEventDomain {
    return domain({
      timeSeconds: 7_200,
      historyHorizonSeconds: 14_400,
      cells: [cell('cell-a', {
        sourcePosition: { directionUnitVector: v3(0, 0, 1), geometricHeightM: 1_000 },
        iceReleaseHeightM: 7_000,
      })],
      outflow: {
        maxGeneration: 2,
        propagationDelaySeconds: 600,
        propagationDistanceM: 31_855,
        sphereRadiusM: 6_371_000,
        windAt: outflowWind,
      },
      ...overrides,
    });
  }

  test('cloud events: 冷気外出流は風下に有界世代の娘イベントを生む', () => {
    const sample = sampleConvectiveCloudEvents(outflowDomain());
    const primaries = sample.events.filter((item) => item.generation === 0);
    const daughters = sample.events.filter((item) => item.generation === 1);
    const grandchildren = sample.events.filter((item) => item.generation === 2);
    assert.ok(primaries.length > 0);
    assert.ok(daughters.length > 0);
    assert.ok(grandchildren.length > 0);
    // 世代は上限で止まり、無限連鎖しない。
    assert.ok(sample.events.every((item) => item.generation <= 2));

    const byId = new Map(sample.events.map((item) => [item.id, item]));
    for (const daughter of daughters) {
      assert.notEqual(daughter.parentEventId, null);
      const parent = byId.get(daughter.parentEventId!);
      assert.ok(parent !== undefined && parent.generation === 0);
      // 出生時刻は親の供給終了 + 伝播遅延。
      closeTo(daughter.birthTimeSeconds,
        parent.birthTimeSeconds + parent.lifecycle.convectiveDurationSeconds + 600);
      // 強度は親より弱い(受継割合 × 散らし上限 1.5 で 0.45 倍を越えない)。
      assert.ok(daughter.lifecycle.liquidSupplyRateKgM2S
        < parent.lifecycle.liquidSupplyRateKgM2S);
      assert.equal(daughter.cellId, parent.cellId);
      assert.ok(daughter.birthTimeSeconds <= sample.timeSeconds);
      assert.ok(daughter.birthTimeSeconds >= sample.timeSeconds - 14_400);
    }
    for (const grandchild of grandchildren) {
      assert.notEqual(grandchild.parentEventId, null);
      // 孫の親は horizon より前に生まれた娘も含むので、履歴に載っていない場合もある。
      // 載っているなら第1世代で、載っていなくても ID が第1世代の娘を指す。
      const parent = byId.get(grandchild.parentEventId!);
      if (parent !== undefined) assert.equal(parent.generation, 1);
      else assert.ok(grandchild.parentEventId!.includes(':g1:'));
    }

    // 一定の大円風では、外出流が距離ぶんの角移動をして娘が置かれる。
    const epochZeroParent = primaries.find((item) => item.birthEpoch === 0);
    assert.ok(epochZeroParent !== undefined);
    const daughter = daughters.find((item) => item.parentEventId === epochZeroParent.id);
    assert.ok(daughter !== undefined);
    const expectedAngleRad = 31_855 / (6_371_000 + 1_000);
    const expected = v3(Math.sin(expectedAngleRad), 0, Math.cos(expectedAngleRad));
    const position = daughter.sourcePosition!;
    assert.ok(Math.hypot(
      position.directionUnitVector.x - expected.x,
      position.directionUnitVector.y - expected.y,
      position.directionUnitVector.z - expected.z,
    ) < 1e-9);
    assert.equal(position.geometricHeightM, 1_000);

    // 同じ domain を再評価しても同じ系列が返る。
    assert.deepEqual(sampleConvectiveCloudEvents(outflowDomain()), sample);
  });

  test('cloud events: 娘イベントは親の供給が終わったあとに生まれ、残存を読める', () => {
    const domainFor = (timeSeconds: number) => outflowDomain({ timeSeconds });
    const reference = sampleConvectiveCloudEvents(domainFor(7_200));
    const parent = reference.events.find((item) => item.generation === 0 && item.birthEpoch === 0);
    assert.ok(parent !== undefined);
    const daughterBirthSeconds = parent.birthTimeSeconds
      + parent.lifecycle.convectiveDurationSeconds + 600;
    assert.ok(daughterBirthSeconds < 7_200);

    // 娘の出生前にはその娘は現れず、出生後には親と並んで現れる。
    const before = sampleConvectiveCloudEvents(domainFor(daughterBirthSeconds - 1));
    assert.ok(before.events.every((item) => item.parentEventId !== parent.id));
    const after = sampleConvectiveCloudEvents(domainFor(daughterBirthSeconds + 1));
    const daughter = after.events.find((item) => item.parentEventId === parent.id);
    assert.ok(daughter !== undefined);
    closeTo(daughter.birthTimeSeconds, daughterBirthSeconds);
    assert.ok(daughter.mass.liquidKgM2 + daughter.mass.iceKgM2 > 0);
    const agedParent = after.events.find((item) => item.id === parent.id);
    assert.ok(agedParent !== undefined && agedParent.supplyActive === false);
  });

  test('cloud events: 外出流が無効または親に源位置が無ければ娘イベントは生まれない', () => {
    const withoutOutflow = sampleConvectiveCloudEvents(domain());
    assert.ok(withoutOutflow.events.every((item) => item.generation === 0));
    const disabled = sampleConvectiveCloudEvents(domain({
      cells: [cell('cell-a', {
        sourcePosition: { directionUnitVector: v3(0, 0, 1), geometricHeightM: 1_000 },
      })],
      outflow: {
        maxGeneration: 0,
        propagationDelaySeconds: 600,
        propagationDistanceM: 31_855,
        sphereRadiusM: 6_371_000,
        windAt: outflowWind,
      },
    }));
    assert.ok(disabled.events.every((item) => item.generation === 0));
    // 源位置を持たない親は風下を決められないので、有効でも娘を生まない。
    const unpositioned = sampleConvectiveCloudEvents(outflowDomain({
      cells: [cell('cell-a')],
    }));
    assert.ok(unpositioned.events.every((item) => item.generation === 0));
  });

  test('cloud events: 外出流設定の不正値は拒否する', () => {
    const outflow = {
      maxGeneration: 2,
      propagationDelaySeconds: 600,
      propagationDistanceM: 31_855,
      sphereRadiusM: 6_371_000,
      windAt: outflowWind,
    };
    const locatedCell = cell('cell-a', {
      sourcePosition: { directionUnitVector: v3(0, 0, 1), geometricHeightM: 1_000 },
    });
    assert.throws(() => sampleConvectiveCloudEvents(domain({
      cells: [locatedCell],
      outflow: { ...outflow, maxGeneration: 9 },
    })), /outflow\.maxGeneration/);
    assert.throws(() => sampleConvectiveCloudEvents(domain({
      cells: [locatedCell],
      outflow: { ...outflow, propagationDelaySeconds: -1 },
    })), /propagationDelaySeconds/);
    assert.throws(() => sampleConvectiveCloudEvents(domain({
      cells: [locatedCell],
      outflow: { ...outflow, propagationDistanceM: -5 },
    })), /propagationDistanceM/);
    assert.throws(() => sampleConvectiveCloudEvents(domain({
      cells: [locatedCell],
      outflow: { ...outflow, windAt: 'not-a-function' as never },
    })), /windAt/);
    assert.throws(() => sampleConvectiveCloudEvents(domain({
      cells: [locatedCell],
      outflow: { ...outflow, sphereRadiusM: 0 },
    })), /sphereRadiusM/);
  });
}
