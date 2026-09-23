// ラボの全セルと任意時刻からイベント履歴を再構成する表示導出。物理予報ではなく、
// 質量保存と任意時刻再構成を検査する決定論的 surrogate model。描画装置へ渡す場合も、
// 装置側に出生・供給履歴の正本を持たせず、ここで導出した immutable な宣言だけを渡す。

import { len, v3 } from '../../math/vec3';
import type { Vec3 } from '../../math/vec3';

const SECONDS_PER_HOUR = 3_600;
const UINT32_RANGE = 0x1_0000_0000;
const MAX_DOMAIN_EVENTS = 100_000;
const MAX_EPOCH_CANDIDATES = 100_000;
const MAX_CELL_EPOCH_PAIRS = 1_000_000;

export interface ConvectiveCloudCell {
  readonly id: string;
  // 一意な環境供給元。1 source は独立した1 m² columnを表し、複数cellへ分配しない。
  readonly supplySourceId: string;
  // 0..1 のラボ制御値。対流の物理的な発生確率ではない。
  readonly convectivePotential: number;
  // 上層の相対湿度。0..1、昇華率を調整する無次元の代理値。
  readonly upperRelativeHumidity: number;
  // 雲柱の単位面積あたり供給率。kg m^-2 s^-1。
  readonly liquidSupplyRateKgM2S: number;
  // 対流供給が続く時間。s。
  readonly convectiveDurationSeconds: number;
  // Optional geographic placement for consumers that reconstruct material tracks.
  // Diagnostic-only cells may omit it; no location is inferred from an ID.
  readonly sourcePosition?: CloudEventSourcePosition;
  // Geometric altitude [m] at which released ice enters the upper-level flow.
  readonly iceReleaseHeightM?: number;
}

export interface CloudEventSourcePosition {
  readonly directionUnitVector: Vec3;
  readonly geometricHeightM: number;
}

export interface CloudEventDomain {
  readonly seed: number;
  // 雲イベントの候補出生間隔。s。
  readonly birthIntervalSeconds: number;
  // 再構成するイベント履歴の有限期間。s。
  readonly historyHorizonSeconds: number;
  // horizonより古いイベントが要求時刻に残す質量上界の許容値。kg m^-2。
  readonly maximumOmittedMassKgM2: number;
  // 再構成するイベントの上限。1..100000。
  readonly maxEventCount: number;
  // 要求時刻。s。絶対 epoch と同じ任意の基準を使う。
  readonly timeSeconds: number;
  readonly cells: readonly ConvectiveCloudCell[];
}

export interface CloudEventMassLedger {
  // 1 m² の雲柱を基準にした質量。kg m^-2。
  readonly initialKgM2: number;
  readonly suppliedKgM2: number;
  readonly lostKgM2: number;
  readonly liquidKgM2: number;
  readonly iceKgM2: number;
}

export interface CloudIceRelease {
  readonly id: string;
  readonly parentEventId: string;
  readonly releasedKgM2: number;
  readonly remainingKgM2: number;
  // 生存氷質量で重み付けした代表放出時刻。
  readonly meanReleaseTimeSeconds: number | null;
  // 連続放出と昇華の解析式を再現するための係数。
  readonly releaseRateKgM2S: number;
  readonly releaseStartTimeSeconds: number | null;
  readonly releaseEndTimeSeconds: number | null;
  readonly sublimationRatePerSecond: number;
  readonly releaseHeightM: number | null;
}

export interface CloudIceReleaseCohort {
  readonly index: number;
  readonly releaseStartTimeSeconds: number;
  readonly releaseEndTimeSeconds: number;
  readonly meanReleaseTimeSeconds: number;
  readonly remainingKgM2: number;
}

export interface ConvectiveCloudEvent {
  readonly id: string;
  readonly cellId: string;
  readonly birthEpoch: number;
  readonly birthTimeSeconds: number;
  readonly ageSeconds: number;
  readonly sourcePosition?: CloudEventSourcePosition;
  readonly supplyActive: boolean;
  readonly mass: CloudEventMassLedger;
  // 一つの有界な氷放出記録。再帰的な親子グラフは保持しない。
  readonly iceRelease: CloudIceRelease;
}

export interface CloudEventSample {
  readonly timeSeconds: number;
  readonly events: readonly ConvectiveCloudEvent[];
  readonly truncatedEventCount: number;
  readonly truncatedMassKgM2: number;
  readonly omittedMassUpperBoundKgM2: number;
}

// 昇華の基準時定数は2時間、飽和未満で最大5倍まで速くなるラボ用閉包。
// 固定係数の数値実験であり、観測校正済みの水蒸気輸送・粒径依存の式ではない。
const ICE_SUBLIMATION_TIME_SECONDS = 2 * SECONDS_PER_HOUR;
const MAX_DRY_AIR_MULTIPLIER = 5;
const LIQUID_LOSS_TIME_SECONDS = 20 * 60;
const ICE_RELEASE_DELAY_SECONDS = 15 * 60;
const ICE_YIELD_FRACTION = 0.35;
const MAX_ICE_RELEASE_COHORTS = 256;

function iceSublimationRatePerSecond(upperRelativeHumidity: number): number {
  const humidity = Math.min(Math.max(upperRelativeHumidity, 0), 1);
  return (1 + (1 - humidity) * (MAX_DRY_AIR_MULTIPLIER - 1))
    / ICE_SUBLIMATION_TIME_SECONDS;
}

function hash32(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d);
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x846ca68b);
  return (hash ^ (hash >>> 16)) >>> 0;
}

function eventHash(seed: number, cellId: string, epoch: number): number {
  return hash32(`${seed >>> 0}\u0000${cellId}\u0000${epoch}`);
}

function exponentialIntegral(durationSeconds: number, decayRatePerSecond: number): number {
  if (durationSeconds <= 0) return 0;
  if (decayRatePerSecond <= 1e-15) return durationSeconds;
  return -Math.expm1(-decayRatePerSecond * durationSeconds) / decayRatePerSecond;
}

function eventMass(
  cell: ConvectiveCloudCell,
  ageSeconds: number,
): CloudEventMassLedger {
  const suppliedDurationSeconds = Math.min(ageSeconds, cell.convectiveDurationSeconds);
  const suppliedKgM2 = cell.liquidSupplyRateKgM2S * suppliedDurationSeconds;
  const liquidLossRate = 1 / LIQUID_LOSS_TIME_SECONDS;
  const liquidBaseKgM2 = cell.liquidSupplyRateKgM2S * (1 - ICE_YIELD_FRACTION)
    * Math.exp(-liquidLossRate * Math.max(ageSeconds - suppliedDurationSeconds, 0))
    * exponentialIntegral(suppliedDurationSeconds, liquidLossRate);

  const releasedDurationSeconds = Math.min(
    suppliedDurationSeconds,
    Math.max(ageSeconds - ICE_RELEASE_DELAY_SECONDS, 0),
  );
  const unreleasedDurationSeconds = suppliedDurationSeconds - releasedDurationSeconds;
  const unreleasedYieldKgM2 = cell.liquidSupplyRateKgM2S
    * ICE_YIELD_FRACTION * unreleasedDurationSeconds;
  const iceLossRate = iceSublimationRatePerSecond(cell.upperRelativeHumidity);
  const iceKgM2 = cell.liquidSupplyRateKgM2S * ICE_YIELD_FRACTION
    * Math.exp(-iceLossRate * Math.max(ageSeconds - ICE_RELEASE_DELAY_SECONDS - releasedDurationSeconds, 0))
    * exponentialIntegral(releasedDurationSeconds, iceLossRate);
  const liquidKgM2 = liquidBaseKgM2 + unreleasedYieldKgM2;
  const unaccountedKgM2 = suppliedKgM2 - liquidKgM2 - iceKgM2;
  const roundingToleranceKgM2 = 64 * Number.EPSILON * Math.max(1, suppliedKgM2);
  if (unaccountedKgM2 < -roundingToleranceKgM2) {
    throw new RangeError('cloud event mass exceeds its cumulative supply');
  }
  const lostKgM2 = unaccountedKgM2 < 0 ? 0 : unaccountedKgM2;

  return {
    initialKgM2: 0,
    suppliedKgM2,
    lostKgM2,
    liquidKgM2,
    iceKgM2,
  };
}

function omittedMassUpperBoundKgM2(
  cells: readonly ConvectiveCloudCell[],
  historyHorizonSeconds: number,
  birthIntervalSeconds: number,
): number {
  const wetIceLossRate = 1 / ICE_SUBLIMATION_TIME_SECONDS;
  const cohortSpacingLoss = -Math.expm1(-wetIceLossRate * birthIntervalSeconds);
  let upperBoundKgM2 = 0;
  for (const cell of cells) {
    if (cell.convectivePotential === 0 || cell.liquidSupplyRateKgM2S === 0
      || cell.convectiveDurationSeconds === 0) continue;
    const releaseCompleteSeconds = cell.convectiveDurationSeconds + ICE_RELEASE_DELAY_SECONDS;
    if (historyHorizonSeconds < releaseCompleteSeconds) {
      throw new RangeError('history horizon is shorter than the event release tail');
    }
    const suppliedPerEventKgM2 = cell.liquidSupplyRateKgM2S * cell.convectiveDurationSeconds;
    const youngestOmittedAgeSeconds = historyHorizonSeconds;
    upperBoundKgM2 += suppliedPerEventKgM2
      * Math.exp(-wetIceLossRate * (youngestOmittedAgeSeconds - releaseCompleteSeconds))
      / cohortSpacingLoss;
  }
  return upperBoundKgM2;
}

function validateDomain(domain: CloudEventDomain): number {
  if (!Number.isFinite(domain.seed)) throw new RangeError('seed must be finite');
  if (!(domain.birthIntervalSeconds > 0) || !Number.isFinite(domain.birthIntervalSeconds)) {
    throw new RangeError('birthIntervalSeconds must be finite and positive');
  }
  if (!(domain.historyHorizonSeconds >= 0) || !Number.isFinite(domain.historyHorizonSeconds)) {
    throw new RangeError('historyHorizonSeconds must be finite and non-negative');
  }
  if (!(domain.maximumOmittedMassKgM2 >= 0) || !Number.isFinite(domain.maximumOmittedMassKgM2)) {
    throw new RangeError('maximumOmittedMassKgM2 must be finite and non-negative');
  }
  if (!Number.isInteger(domain.maxEventCount)
    || domain.maxEventCount < 1 || domain.maxEventCount > MAX_DOMAIN_EVENTS) {
    throw new RangeError(`maxEventCount must be an integer from 1 to ${MAX_DOMAIN_EVENTS}`);
  }
  if (!Number.isFinite(domain.timeSeconds)) throw new RangeError('timeSeconds must be finite');
  const cellIds = new Set<string>();
  const supplySourceIds = new Set<string>();
  for (const cell of domain.cells) {
    if (!cell.id) throw new RangeError('cell id must not be empty');
    if (cellIds.has(cell.id)) throw new RangeError(`duplicate cloud cell id: ${cell.id}`);
    cellIds.add(cell.id);
    if (!cell.supplySourceId) throw new RangeError('supplySourceId must not be empty');
    if (supplySourceIds.has(cell.supplySourceId)) {
      throw new RangeError(`duplicate cloud supply source: ${cell.supplySourceId}`);
    }
    supplySourceIds.add(cell.supplySourceId);
    if (!Number.isFinite(cell.convectivePotential)) throw new RangeError('convectivePotential must be finite');
    if (cell.convectivePotential < 0 || cell.convectivePotential > 1) {
      throw new RangeError('convectivePotential must be between 0 and 1');
    }
    if (!Number.isFinite(cell.upperRelativeHumidity)) throw new RangeError('upperRelativeHumidity must be finite');
    if (cell.upperRelativeHumidity < 0 || cell.upperRelativeHumidity > 1) {
      throw new RangeError('upperRelativeHumidity must be between 0 and 1');
    }
    if (!(cell.liquidSupplyRateKgM2S >= 0) || !Number.isFinite(cell.liquidSupplyRateKgM2S)) {
      throw new RangeError('liquidSupplyRateKgM2S must be finite and non-negative');
    }
    if (!(cell.convectiveDurationSeconds >= 0) || !Number.isFinite(cell.convectiveDurationSeconds)) {
      throw new RangeError('convectiveDurationSeconds must be finite and non-negative');
    }
    if (cell.convectiveDurationSeconds > domain.birthIntervalSeconds) {
      throw new RangeError('convectiveDurationSeconds must not exceed birthIntervalSeconds');
    }
    if (cell.sourcePosition !== undefined) {
      const position = cell.sourcePosition.directionUnitVector;
      if (![position.x, position.y, position.z, cell.sourcePosition.geometricHeightM].every(Number.isFinite)) {
        throw new RangeError('sourcePosition values must be finite');
      }
      if (Math.abs(len(position) - 1) > 1e-10) {
        throw new RangeError('sourcePosition.directionUnitVector must be normalized');
      }
      if (cell.sourcePosition.geometricHeightM < 0) {
        throw new RangeError('sourcePosition.geometricHeightM must be non-negative');
      }
    }
    if (cell.iceReleaseHeightM !== undefined
      && (!(cell.iceReleaseHeightM >= 0) || !Number.isFinite(cell.iceReleaseHeightM))) {
      throw new RangeError('iceReleaseHeightM must be finite and non-negative');
    }
  }
  const omittedUpperBoundKgM2 = omittedMassUpperBoundKgM2(
    domain.cells,
    domain.historyHorizonSeconds,
    domain.birthIntervalSeconds,
  );
  if (omittedUpperBoundKgM2 > domain.maximumOmittedMassKgM2) {
    throw new RangeError('omitted event mass upper bound exceeds maximumOmittedMassKgM2');
  }
  const firstEpoch = Math.ceil(
    (domain.timeSeconds - domain.historyHorizonSeconds) / domain.birthIntervalSeconds,
  );
  const lastEpoch = Math.floor(domain.timeSeconds / domain.birthIntervalSeconds);
  if (!Number.isSafeInteger(firstEpoch) || !Number.isSafeInteger(lastEpoch)) {
    throw new RangeError('time and birth interval must produce safe integer epochs');
  }
  const epochCandidates = Math.max(0, lastEpoch - firstEpoch + 1);
  if (!Number.isFinite(epochCandidates)
    || epochCandidates > MAX_EPOCH_CANDIDATES
    || epochCandidates * cellIds.size > MAX_CELL_EPOCH_PAIRS) {
    throw new RangeError('history horizon and cell count exceed the bounded event search');
  }
  return omittedUpperBoundKgM2;
}

function createEvent(
  domain: CloudEventDomain,
  cell: ConvectiveCloudCell,
  epoch: number,
): ConvectiveCloudEvent {
  const birthTimeSeconds = epoch * domain.birthIntervalSeconds;
  const ageSeconds = Math.max(domain.timeSeconds - birthTimeSeconds, 0);
  const mass = eventMass(cell, ageSeconds);
  const releasedDurationSeconds = Math.min(
    Math.min(ageSeconds, cell.convectiveDurationSeconds),
    Math.max(ageSeconds - ICE_RELEASE_DELAY_SECONDS, 0),
  );
  const releaseStartTimeSeconds = releasedDurationSeconds > 0
    ? birthTimeSeconds + ICE_RELEASE_DELAY_SECONDS
    : null;
  const releaseEndTimeSeconds = releaseStartTimeSeconds === null
    ? null
    : releaseStartTimeSeconds + releasedDurationSeconds;
  const releaseRateKgM2S = cell.liquidSupplyRateKgM2S * ICE_YIELD_FRACTION;
  const meanReleaseTimeSeconds = releasedDurationSeconds > 0
    ? survivingIceMeanReleaseTimeSeconds(
      birthTimeSeconds + ICE_RELEASE_DELAY_SECONDS, releasedDurationSeconds,
      iceSublimationRatePerSecond(cell.upperRelativeHumidity),
    )
    : null;
  const id = `${cell.id}:${epoch}:${eventHash(domain.seed, cell.id, epoch).toString(16).padStart(8, '0')}`;
  return {
    id,
    cellId: cell.id,
    birthEpoch: epoch,
    birthTimeSeconds,
    ageSeconds,
    ...(cell.sourcePosition === undefined ? {} : {
      sourcePosition: Object.freeze({
        directionUnitVector: Object.freeze(v3(
          cell.sourcePosition.directionUnitVector.x,
          cell.sourcePosition.directionUnitVector.y,
          cell.sourcePosition.directionUnitVector.z,
        )),
        geometricHeightM: cell.sourcePosition.geometricHeightM,
      }),
    }),
    supplyActive: ageSeconds < cell.convectiveDurationSeconds,
    mass,
    iceRelease: {
      id: `${id}:ice`,
      parentEventId: id,
      releasedKgM2: releaseRateKgM2S * releasedDurationSeconds,
      remainingKgM2: mass.iceKgM2,
      meanReleaseTimeSeconds,
      releaseRateKgM2S,
      releaseStartTimeSeconds,
      releaseEndTimeSeconds,
      sublimationRatePerSecond: iceSublimationRatePerSecond(cell.upperRelativeHumidity),
      releaseHeightM: meanReleaseTimeSeconds === null ? null : cell.iceReleaseHeightM ?? null,
    },
  };
}

/** 生存質量で重み付けした連続放出区間の代表時刻を返す。 */
function survivingIceMeanReleaseTimeSeconds(
  startTimeSeconds: number,
  durationSeconds: number,
  lossRatePerSecond: number,
): number {
  const x = lossRatePerSecond * durationSeconds;
  const meanAgeAtReleaseEndSeconds = x < 1e-4
    ? durationSeconds / 2 - lossRatePerSecond * durationSeconds ** 2 / 12
      + lossRatePerSecond ** 3 * durationSeconds ** 4 / 720
    : x > 50
      ? 1 / lossRatePerSecond
      : 1 / lossRatePerSecond - durationSeconds / Math.expm1(x);
  return startTimeSeconds + durationSeconds - meanAgeAtReleaseEndSeconds;
}

/** 連続放出の解析質量を、有限個の時間コホートへ決定的に分割する。 */
export function splitCloudIceReleaseIntoCohorts(
  event: ConvectiveCloudEvent,
  cohortCount = 32,
): readonly CloudIceReleaseCohort[] {
  if (!Number.isInteger(cohortCount) || cohortCount < 1 || cohortCount > MAX_ICE_RELEASE_COHORTS) {
    throw new RangeError(`cohortCount must be an integer from 1 to ${MAX_ICE_RELEASE_COHORTS}`);
  }
  const { releaseStartTimeSeconds, releaseEndTimeSeconds, releaseRateKgM2S,
    sublimationRatePerSecond } = event.iceRelease;
  if (releaseStartTimeSeconds === null || releaseEndTimeSeconds === null
    || releaseRateKgM2S === 0 || event.iceRelease.remainingKgM2 === 0) return [];
  const sampleTimeSeconds = event.birthTimeSeconds + event.ageSeconds;
  const durationSeconds = releaseEndTimeSeconds - releaseStartTimeSeconds;
  const binDurationSeconds = durationSeconds / cohortCount;
  const cohorts: CloudIceReleaseCohort[] = [];
  for (let index = 0; index < cohortCount; index += 1) {
    const start = releaseStartTimeSeconds + binDurationSeconds * index;
    const end = index === cohortCount - 1
      ? releaseEndTimeSeconds
      : releaseStartTimeSeconds + binDurationSeconds * (index + 1);
    const binDuration = end - start;
    const tailSeconds = sampleTimeSeconds - end;
    const remainingKgM2 = releaseRateKgM2S
      * Math.exp(-sublimationRatePerSecond * tailSeconds)
      * exponentialIntegral(binDuration, sublimationRatePerSecond);
    if (remainingKgM2 === 0) continue;
    cohorts.push({
      index,
      releaseStartTimeSeconds: start,
      releaseEndTimeSeconds: end,
      meanReleaseTimeSeconds: survivingIceMeanReleaseTimeSeconds(
        start, binDuration, sublimationRatePerSecond,
      ),
      remainingKgM2,
    });
  }
  return cohorts;
}

// 同じ seed/cell ID/出生 epoch は常に同じイベントとなり、時刻・列挙順・カメラは ID に入らない。
// 有限 horizon と件数上限で履歴と親子記録の大きさを制限する。出力は event ID の昇順。
export function sampleConvectiveCloudEvents(domain: CloudEventDomain): CloudEventSample {
  const omittedUpperBoundKgM2 = validateDomain(domain);
  const firstEpoch = Math.ceil(
    (domain.timeSeconds - domain.historyHorizonSeconds) / domain.birthIntervalSeconds,
  );
  const lastEpoch = Math.floor(domain.timeSeconds / domain.birthIntervalSeconds);
  const cells = [...new Map(domain.cells.map((cell) => [cell.id, cell])).values()]
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const events: ConvectiveCloudEvent[] = [];

  for (const cell of cells) {
    for (let epoch = firstEpoch; epoch <= lastEpoch; epoch += 1) {
      if (eventHash(domain.seed, cell.id, epoch) / UINT32_RANGE >= cell.convectivePotential) continue;
      const event = createEvent(domain, cell, epoch);
      if (event.mass.liquidKgM2 + event.mass.iceKgM2 > 0) events.push(event);
    }
  }

  events.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const truncatedEventCount = Math.max(0, events.length - domain.maxEventCount);
  const truncatedMassKgM2 = events.slice(domain.maxEventCount)
    .reduce((massKgM2, event) => massKgM2 + event.mass.liquidKgM2 + event.mass.iceKgM2, 0);
  if (omittedUpperBoundKgM2 + truncatedMassKgM2 > domain.maximumOmittedMassKgM2) {
    throw new RangeError('horizon and count-truncation mass exceed maximumOmittedMassKgM2');
  }
  return {
    timeSeconds: domain.timeSeconds,
    events: events.slice(0, domain.maxEventCount),
    truncatedEventCount,
    truncatedMassKgM2,
    omittedMassUpperBoundKgM2: omittedUpperBoundKgM2,
  };
}
