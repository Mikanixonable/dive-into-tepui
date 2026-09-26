// ラボの全セルと任意時刻からイベント履歴を再構成する表示導出。物理予報ではなく、
// 質量保存と任意時刻再構成を検査する決定論的 surrogate model。描画装置へ渡す場合も、
// 装置側に出生・供給履歴の正本を持たせず、ここで導出した immutable な宣言だけを渡す。
// イベント固有の供給率・継続時間・氷収率・有効湿度は出生のハッシュで散らし、
// 冷気外出流が風下へ起こす娘イベントは有限世代で止める。

import { len, v3 } from '../../math/vec3';
import { mulberry32 } from '../../math/random';
import { advectSphericalPositionUnitVector } from '../../physics/cloud-spherical-transport';
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
  // セル固有の出生グリッドの位相。s、0..birthIntervalSeconds 未満。省略時は 0 で、
  // 全セルが同じ epoch グリッドを共有する。独立した対流の出生はセルごとに別の時刻へ
  // 起きるので、セル間で出生を同期させたくない供給源がここへ位相を置く。
  readonly birthPhaseSeconds?: number;
  // 材料軌道を復元する消費者が読む地理的な配置。診断だけのセルは省略してよく、
  // ID から位置は推定されない。
  readonly sourcePosition?: CloudEventSourcePosition;
  // 放出された氷が上層の流れへ入る幾何高度 [m]。
  readonly iceReleaseHeightM?: number;
}

export interface CloudEventSourcePosition {
  readonly directionUnitVector: Vec3;
  readonly geometricHeightM: number;
}

// 冷気外出流を運ぶ地表付近の風。単位位置方向と時刻から、その位置の接線速度 [m/s] を返す。
export type CloudEventOutflowWindAt = (
  directionUnitVector: Vec3,
  timeSeconds: number,
) => Vec3;

export interface CloudEventOutflow {
  // 0 で無効。1 以上で、対流イベントの冷気外出流が風下に起こす娘イベントをこの世代数まで連鎖させる。
  readonly maxGeneration: number;
  // 親イベントの供給終了から娘イベントの出生までの遅延。s。
  readonly propagationDelaySeconds: number;
  // 外出流が親の源位置から低層風に運ばれて進む距離。m。
  readonly propagationDistanceM: number;
  // 娘イベントを配置する球面の半径。m。
  readonly sphereRadiusM: number;
  readonly windAt: CloudEventOutflowWindAt;
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
  // 冷気外出流による娘イベントの設定。省略時は娘イベントを生じさせない。
  readonly outflow?: CloudEventOutflow;
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

export interface ConvectiveCloudEventLifecycle {
  // イベント固有の有効供給率。kg m^-2 s^-1。
  readonly liquidSupplyRateKgM2S: number;
  // イベント固有の有効供給継続時間。s。
  readonly convectiveDurationSeconds: number;
  // イベント固有の氷収率。無次元。
  readonly iceYieldFraction: number;
  // イベント固有の有効上層相対湿度。昇華率はこれから導く。0..1。
  readonly upperRelativeHumidity: number;
}

export interface ConvectiveCloudEvent {
  readonly id: string;
  readonly cellId: string;
  // 親イベントの出生 epoch。娘イベントでは出生時刻を birthIntervalSeconds で割った値。
  readonly birthEpoch: number;
  readonly birthTimeSeconds: number;
  readonly ageSeconds: number;
  readonly sourcePosition?: CloudEventSourcePosition;
  readonly supplyActive: boolean;
  readonly mass: CloudEventMassLedger;
  // 一つの有界な氷放出記録。再帰的な親子グラフは保持しない。
  readonly iceRelease: CloudIceRelease;
  // このイベントに効いた供給・寿命の値。セル環境または親イベントを母数に、
  // 出生の決定的ハッシュで散らしたもの。
  readonly lifecycle: ConvectiveCloudEventLifecycle;
  // 0 は環境の候補出生、1 以上は冷気外出流が風下へ起こした娘の世代。有限世代で止まる。
  readonly generation: number;
  // 娘イベントを起こした親の ID。generation が 0 のとき null。
  readonly parentEventId: string | null;
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
// イベントごとの寿命ゆらぎ。セル環境値を母数に、出生の決定的ハッシュからこの範囲で散らす。
const EVENT_TRAIT_MIN_FACTOR = 0.5;
const EVENT_TRAIT_FACTOR_RANGE = 1.0;
const EVENT_TRAIT_MAX_FACTOR = EVENT_TRAIT_MIN_FACTOR + EVENT_TRAIT_FACTOR_RANGE;
// 昇華の散らしは率ではなく有効湿度をこの幅でずらす形で入れる。乾いた空気の取り込みを代理する
// 無次元シフトで、省略質量上界の最湿損失率(湿度1)を緩めないための形を選んでいる。
const EVENT_HUMIDITY_SHIFT = 0.6;
// 対流ポテンシャルでイベントの勢力を割引く係数。弱い環境のイベントほど短命・小規模になる。
const EVENT_POTENTIAL_VIGOR_BASE = 0.6;
// 娘イベントが親から受け継ぐ供給強度の割合。寒冷プールの押し上げが起こす二次対流を、親の
// 供給率の約3割と見積もる surrogate 定数(観測校正済みの値ではない)。
const OUTFLOW_DAUGHTER_SUPPLY_FRACTION = 0.3;
const OUTFLOW_PROPAGATION_STEPS = 16;
const OUTFLOW_STALL_WIND_M_PER_S = 1e-9;
const MAX_OUTFLOW_GENERATION = 8;

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

// 出生判定のハッシュと独立した系列を得るため、イベント固有値の種は別タグで取る。
function eventTraitHash(seed: number, cellId: string, epoch: number): number {
  return hash32(`${seed >>> 0}\u0000${cellId}\u0000${epoch}\u0000traits`);
}

function traitFactor(uniform: number): number {
  return EVENT_TRAIT_MIN_FACTOR + EVENT_TRAIT_FACTOR_RANGE * uniform;
}

function clamp01(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}

function convectiveVigorFactor(convectivePotential: number): number {
  return EVENT_POTENTIAL_VIGOR_BASE
    + (1 - EVENT_POTENTIAL_VIGOR_BASE) * convectivePotential;
}

// 全イベントの供給継続時間が越えない天井。省略質量上界も同じ天井を使う。
function eventDurationCeilingSeconds(
  cell: ConvectiveCloudCell,
  birthIntervalSeconds: number,
): number {
  return Math.min(
    EVENT_TRAIT_MAX_FACTOR * cell.convectiveDurationSeconds,
    birthIntervalSeconds,
  );
}

function exponentialIntegral(durationSeconds: number, decayRatePerSecond: number): number {
  if (durationSeconds <= 0) return 0;
  if (decayRatePerSecond <= 1e-15) return durationSeconds;
  return -Math.expm1(-decayRatePerSecond * durationSeconds) / decayRatePerSecond;
}

function eventMass(
  lifecycle: ConvectiveCloudEventLifecycle,
  ageSeconds: number,
): CloudEventMassLedger {
  const suppliedDurationSeconds = Math.min(ageSeconds, lifecycle.convectiveDurationSeconds);
  const suppliedKgM2 = lifecycle.liquidSupplyRateKgM2S * suppliedDurationSeconds;
  const liquidLossRate = 1 / LIQUID_LOSS_TIME_SECONDS;
  const liquidBaseKgM2 = lifecycle.liquidSupplyRateKgM2S * (1 - lifecycle.iceYieldFraction)
    * Math.exp(-liquidLossRate * Math.max(ageSeconds - suppliedDurationSeconds, 0))
    * exponentialIntegral(suppliedDurationSeconds, liquidLossRate);

  const releasedDurationSeconds = Math.min(
    suppliedDurationSeconds,
    Math.max(ageSeconds - ICE_RELEASE_DELAY_SECONDS, 0),
  );
  const unreleasedDurationSeconds = suppliedDurationSeconds - releasedDurationSeconds;
  const unreleasedYieldKgM2 = lifecycle.liquidSupplyRateKgM2S
    * lifecycle.iceYieldFraction * unreleasedDurationSeconds;
  const iceLossRate = iceSublimationRatePerSecond(lifecycle.upperRelativeHumidity);
  const iceKgM2 = lifecycle.liquidSupplyRateKgM2S * lifecycle.iceYieldFraction
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

// horizon より古いイベントが要求時刻に残す質量の上界。イベント固有の散らしは最大係数側へ、
// 娘イベントは1 slot あたりの供給量が親の OUTFLOW_DAUGHTER_SUPPLY_FRACTION × 散らし上限倍に
// 収まることを使って世代分の幾何和で畳み込み、最も遅い放出完了時刻は世代数ぶんの親出生からの
// ずれを加えて保守的に取る。
function omittedMassUpperBoundKgM2(
  cells: readonly ConvectiveCloudCell[],
  historyHorizonSeconds: number,
  birthIntervalSeconds: number,
  outflow: CloudEventOutflow | null,
): number {
  const wetIceLossRate = 1 / ICE_SUBLIMATION_TIME_SECONDS;
  const cohortSpacingLoss = -Math.expm1(-wetIceLossRate * birthIntervalSeconds);
  const maxGeneration = outflow?.maxGeneration ?? 0;
  // 世代ごとの娘供給量の親比の上限 = 受継割合 × 散らし上限 × 勢力上限(1)。
  const descendantRatio = OUTFLOW_DAUGHTER_SUPPLY_FRACTION * EVENT_TRAIT_MAX_FACTOR;
  const descendantFactor = descendantRatio >= 1
    ? 1 + maxGeneration
    : (1 - descendantRatio ** (maxGeneration + 1)) / (1 - descendantRatio);
  const descendantSpanSeconds = maxGeneration
    * (birthIntervalSeconds + (outflow?.propagationDelaySeconds ?? 0));
  let upperBoundKgM2 = 0;
  for (const cell of cells) {
    if (cell.convectivePotential === 0 || cell.liquidSupplyRateKgM2S === 0
      || cell.convectiveDurationSeconds === 0) continue;
    const maxEventDurationSeconds = eventDurationCeilingSeconds(cell, birthIntervalSeconds);
    const releaseCompleteSeconds = maxEventDurationSeconds
      + ICE_RELEASE_DELAY_SECONDS + descendantSpanSeconds;
    if (historyHorizonSeconds < releaseCompleteSeconds) {
      throw new RangeError('history horizon is shorter than the event release tail');
    }
    const suppliedPerSlotKgM2 = cell.liquidSupplyRateKgM2S
      * EVENT_TRAIT_MAX_FACTOR * maxEventDurationSeconds * descendantFactor;
    const youngestOmittedAgeSeconds = historyHorizonSeconds;
    upperBoundKgM2 += suppliedPerSlotKgM2
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
    if (cell.birthPhaseSeconds !== undefined
      && (!(cell.birthPhaseSeconds >= 0) || !Number.isFinite(cell.birthPhaseSeconds)
        || cell.birthPhaseSeconds >= domain.birthIntervalSeconds)) {
      throw new RangeError('birthPhaseSeconds must be in [0, birthIntervalSeconds)');
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
  const outflow = domain.outflow;
  if (outflow !== undefined) {
    if (!Number.isInteger(outflow.maxGeneration)
      || outflow.maxGeneration < 0 || outflow.maxGeneration > MAX_OUTFLOW_GENERATION) {
      throw new RangeError(`outflow.maxGeneration must be an integer from 0 to ${MAX_OUTFLOW_GENERATION}`);
    }
    if (!(outflow.propagationDelaySeconds >= 0) || !Number.isFinite(outflow.propagationDelaySeconds)) {
      throw new RangeError('outflow.propagationDelaySeconds must be finite and non-negative');
    }
    if (!(outflow.propagationDistanceM >= 0) || !Number.isFinite(outflow.propagationDistanceM)) {
      throw new RangeError('outflow.propagationDistanceM must be finite and non-negative');
    }
    if (outflow.maxGeneration > 0) {
      if (typeof outflow.windAt !== 'function') {
        throw new TypeError('outflow.windAt must be a function');
      }
      if (!(outflow.sphereRadiusM > 0) || !Number.isFinite(outflow.sphereRadiusM)) {
        throw new RangeError('outflow.sphereRadiusM must be finite and positive');
      }
    }
  }
  const omittedUpperBoundKgM2 = omittedMassUpperBoundKgM2(
    domain.cells,
    domain.historyHorizonSeconds,
    domain.birthIntervalSeconds,
    outflow ?? null,
  );
  if (omittedUpperBoundKgM2 > domain.maximumOmittedMassKgM2) {
    throw new RangeError('omitted event mass upper bound exceeds maximumOmittedMassKgM2');
  }
  const firstEpoch = Math.ceil(
    (domain.timeSeconds - domain.historyHorizonSeconds) / domain.birthIntervalSeconds,
  );
  const lastEpoch = Math.floor(domain.timeSeconds / domain.birthIntervalSeconds);
  // 件数・整数域の境界検査は最大の位相ずれ(= 間隔)で行う。位相は間隔未満なので、
  // どのセルの探索窓もこの上限を超えない。
  const parentFirstEpoch = parentSearchFirstEpoch(
    domain, firstEpoch, domain.birthIntervalSeconds);
  if (!Number.isSafeInteger(firstEpoch) || !Number.isSafeInteger(lastEpoch)
    || !Number.isSafeInteger(parentFirstEpoch)) {
    throw new RangeError('time and birth interval must produce safe integer epochs');
  }
  const epochCandidates = Math.max(0, lastEpoch - parentFirstEpoch + 1);
  if (!Number.isFinite(epochCandidates)
    || epochCandidates > MAX_EPOCH_CANDIDATES
    || epochCandidates * cellIds.size > MAX_CELL_EPOCH_PAIRS) {
    throw new RangeError('history horizon and cell count exceed the bounded event search');
  }
  return omittedUpperBoundKgM2;
}

// horizon 内に生まれる娘イベントの祖先は、世代数ぶんの(出生間隔+伝播遅延)だけ古い
// epoch に居うるので、親候補の探索はそこまで遡る。外出流が無効なら履歴窓の先頭そのもの。
// セルの出生位相 phaseSeconds はセル固有のグリッドのずれで、探索窓も同じだけずらす。
function parentSearchFirstEpoch(
  domain: CloudEventDomain, firstEpoch: number, phaseSeconds: number,
): number {
  const outflow = domain.outflow;
  if (outflow === undefined || outflow.maxGeneration === 0) return firstEpoch;
  return Math.floor(
    (domain.timeSeconds - domain.historyHorizonSeconds
      - outflow.maxGeneration
        * (domain.birthIntervalSeconds + outflow.propagationDelaySeconds)
      - phaseSeconds)
    / domain.birthIntervalSeconds,
  );
}

interface EventSpec {
  readonly id: string;
  readonly cellId: string;
  readonly birthEpoch: number;
  readonly birthTimeSeconds: number;
  readonly ageSeconds: number;
  readonly sourcePosition: CloudEventSourcePosition | null;
  readonly iceReleaseHeightM: number | null;
  readonly lifecycle: ConvectiveCloudEventLifecycle;
  readonly generation: number;
  readonly parentEventId: string | null;
}

function buildEvent(spec: EventSpec): ConvectiveCloudEvent {
  const mass = eventMass(spec.lifecycle, spec.ageSeconds);
  const releasedDurationSeconds = Math.min(
    Math.min(spec.ageSeconds, spec.lifecycle.convectiveDurationSeconds),
    Math.max(spec.ageSeconds - ICE_RELEASE_DELAY_SECONDS, 0),
  );
  const releaseStartTimeSeconds = releasedDurationSeconds > 0
    ? spec.birthTimeSeconds + ICE_RELEASE_DELAY_SECONDS
    : null;
  const releaseEndTimeSeconds = releaseStartTimeSeconds === null
    ? null
    : releaseStartTimeSeconds + releasedDurationSeconds;
  const releaseRateKgM2S = spec.lifecycle.liquidSupplyRateKgM2S * spec.lifecycle.iceYieldFraction;
  const meanReleaseTimeSeconds = releasedDurationSeconds > 0
    ? survivingIceMeanReleaseTimeSeconds(
      spec.birthTimeSeconds + ICE_RELEASE_DELAY_SECONDS, releasedDurationSeconds,
      iceSublimationRatePerSecond(spec.lifecycle.upperRelativeHumidity),
    )
    : null;
  return {
    id: spec.id,
    cellId: spec.cellId,
    birthEpoch: spec.birthEpoch,
    birthTimeSeconds: spec.birthTimeSeconds,
    ageSeconds: spec.ageSeconds,
    ...(spec.sourcePosition === null ? {} : {
      sourcePosition: Object.freeze({
        directionUnitVector: Object.freeze(v3(
          spec.sourcePosition.directionUnitVector.x,
          spec.sourcePosition.directionUnitVector.y,
          spec.sourcePosition.directionUnitVector.z,
        )),
        geometricHeightM: spec.sourcePosition.geometricHeightM,
      }),
    }),
    supplyActive: spec.ageSeconds < spec.lifecycle.convectiveDurationSeconds,
    mass,
    iceRelease: {
      id: `${spec.id}:ice`,
      parentEventId: spec.id,
      releasedKgM2: releaseRateKgM2S * releasedDurationSeconds,
      remainingKgM2: mass.iceKgM2,
      meanReleaseTimeSeconds,
      releaseRateKgM2S,
      releaseStartTimeSeconds,
      releaseEndTimeSeconds,
      sublimationRatePerSecond: iceSublimationRatePerSecond(spec.lifecycle.upperRelativeHumidity),
      releaseHeightM: meanReleaseTimeSeconds === null ? null : spec.iceReleaseHeightM,
    },
    lifecycle: spec.lifecycle,
    generation: spec.generation,
    parentEventId: spec.parentEventId,
  };
}

// セル環境値を母数に、出生ハッシュで4系統(供給率・継続時間・氷収率・有効湿度)を散らす。
// 散らした値が氷放出・質量収支・輸送まで一貫して効くよう、イベント自身が有効値を保持する。
function sampleEventLifecycle(
  cell: ConvectiveCloudCell,
  rand: () => number,
  supplyBaseKgM2S: number,
  durationBaseSeconds: number,
  birthIntervalSeconds: number,
): ConvectiveCloudEventLifecycle {
  const supplyFactor = traitFactor(rand());
  const durationFactor = traitFactor(rand());
  const yieldFactor = traitFactor(rand());
  const humidityShift = rand();
  const vigor = convectiveVigorFactor(cell.convectivePotential);
  return Object.freeze({
    liquidSupplyRateKgM2S: supplyBaseKgM2S * supplyFactor * vigor,
    convectiveDurationSeconds: Math.min(
      durationBaseSeconds * durationFactor * vigor,
      eventDurationCeilingSeconds(cell, birthIntervalSeconds),
    ),
    iceYieldFraction: ICE_YIELD_FRACTION * yieldFactor,
    upperRelativeHumidity: clamp01(
      cell.upperRelativeHumidity + EVENT_HUMIDITY_SHIFT * (humidityShift - 0.5),
    ),
  });
}

function createEvent(
  domain: CloudEventDomain,
  cell: ConvectiveCloudCell,
  epoch: number,
): ConvectiveCloudEvent {
  const birthTimeSeconds = epoch * domain.birthIntervalSeconds
    + (cell.birthPhaseSeconds ?? 0);
  const ageSeconds = Math.max(domain.timeSeconds - birthTimeSeconds, 0);
  const lifecycle = sampleEventLifecycle(
    cell,
    mulberry32(eventTraitHash(domain.seed, cell.id, epoch)),
    cell.liquidSupplyRateKgM2S,
    cell.convectiveDurationSeconds,
    domain.birthIntervalSeconds,
  );
  const id = `${cell.id}:${epoch}:${eventHash(domain.seed, cell.id, epoch).toString(16).padStart(8, '0')}`;
  return buildEvent({
    id,
    cellId: cell.id,
    birthEpoch: epoch,
    birthTimeSeconds,
    ageSeconds,
    sourcePosition: cell.sourcePosition ?? null,
    iceReleaseHeightM: cell.iceReleaseHeightM ?? null,
    lifecycle,
    generation: 0,
    parentEventId: null,
  });
}

// 外出流が低層風に運ばれて propagationDistanceM 進んだ先の単位方向を返す。距離を
// OUTFLOW_PROPAGATION_STEPS 等分してその都度の風で移流する決定的な分割則。
function outflowArrivalDirection(
  startDirectionUnitVector: Vec3,
  startHeightM: number,
  startTimeSeconds: number,
  outflow: CloudEventOutflow,
): Vec3 {
  let direction = startDirectionUnitVector;
  let timeSeconds = startTimeSeconds;
  const stepDistanceM = outflow.propagationDistanceM / OUTFLOW_PROPAGATION_STEPS;
  for (let index = 0; index < OUTFLOW_PROPAGATION_STEPS; index += 1) {
    const wind = outflow.windAt(direction, timeSeconds);
    if (![wind.x, wind.y, wind.z].every(Number.isFinite)) {
      throw new RangeError('outflow wind must be finite');
    }
    const speedMPerS = len(wind);
    if (speedMPerS <= OUTFLOW_STALL_WIND_M_PER_S) break;
    const stepSeconds = stepDistanceM / speedMPerS;
    direction = advectSphericalPositionUnitVector(
      direction, wind, outflow.sphereRadiusM + startHeightM, stepSeconds,
    );
    timeSeconds += stepSeconds;
  }
  return direction;
}

// 親イベントの供給終了で外出流が離れ、低層風で propagationDistanceM 進んだ風下に、
// 遅延 propagationDelaySeconds のあと娘イベントが生まれる。強度は親の有効供給率の
// OUTFLOW_DAUGHTER_SUPPLY_FRACTION 倍を母数に同じ散らしを掛ける。
function createDaughterEvent(
  domain: CloudEventDomain,
  outflow: CloudEventOutflow,
  cell: ConvectiveCloudCell,
  parent: ConvectiveCloudEvent,
  generation: number,
): ConvectiveCloudEvent | null {
  const parentSource = parent.sourcePosition;
  if (parentSource === undefined || parent.mass.suppliedKgM2 <= 0) return null;
  const outflowStartTimeSeconds = parent.birthTimeSeconds
    + parent.lifecycle.convectiveDurationSeconds;
  const birthTimeSeconds = outflowStartTimeSeconds + outflow.propagationDelaySeconds;
  if (birthTimeSeconds > domain.timeSeconds) return null;
  const directionUnitVector = outflowArrivalDirection(
    parentSource.directionUnitVector,
    parentSource.geometricHeightM,
    outflowStartTimeSeconds,
    outflow,
  );
  const traitSeed = hash32(`${parent.id}\u0000daughter`);
  const lifecycle = sampleEventLifecycle(
    cell,
    mulberry32(traitSeed),
    parent.lifecycle.liquidSupplyRateKgM2S * OUTFLOW_DAUGHTER_SUPPLY_FRACTION,
    parent.lifecycle.convectiveDurationSeconds,
    domain.birthIntervalSeconds,
  );
  const id = `${parent.id}:g${generation}:${traitSeed.toString(16).padStart(8, '0')}`;
  return buildEvent({
    id,
    cellId: parent.cellId,
    birthEpoch: birthTimeSeconds / domain.birthIntervalSeconds,
    birthTimeSeconds,
    ageSeconds: domain.timeSeconds - birthTimeSeconds,
    sourcePosition: {
      directionUnitVector,
      geometricHeightM: parentSource.geometricHeightM,
    },
    iceReleaseHeightM: cell.iceReleaseHeightM ?? null,
    lifecycle,
    generation,
    parentEventId: parent.id,
  });
}

// 有界世代の娘イベントを返す。horizon 内に生まれたものだけが履歴に入るが、孫の親には
// horizon より古い娘も使うので、連鎖の途中結果は時刻で枝刈りするだけで捨てない。
function sampleDescendantEvents(
  domain: CloudEventDomain,
  outflow: CloudEventOutflow,
  cellsById: ReadonlyMap<string, ConvectiveCloudCell>,
  parents: readonly ConvectiveCloudEvent[],
  horizonStartSeconds: number,
): ConvectiveCloudEvent[] {
  const descendants: ConvectiveCloudEvent[] = [];
  let frontier = parents;
  for (let generation = 1; generation <= outflow.maxGeneration; generation += 1) {
    const next: ConvectiveCloudEvent[] = [];
    for (const parent of frontier) {
      const cell = cellsById.get(parent.cellId);
      if (cell === undefined) continue;
      const daughter = createDaughterEvent(domain, outflow, cell, parent, generation);
      if (daughter === null) continue;
      next.push(daughter);
      if (daughter.birthTimeSeconds >= horizonStartSeconds
        && daughter.mass.liquidKgM2 + daughter.mass.iceKgM2 > 0) {
        descendants.push(daughter);
      }
    }
    frontier = next;
  }
  return descendants;
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
  const horizonStartSeconds = domain.timeSeconds - domain.historyHorizonSeconds;
  const cellsById = new Map(domain.cells.map((cell) => [cell.id, cell]));
  const cells = [...cellsById.values()]
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const events: ConvectiveCloudEvent[] = [];
  const parents: ConvectiveCloudEvent[] = [];
  const outflowActive = domain.outflow !== undefined && domain.outflow.maxGeneration > 0;

  for (const cell of cells) {
    // セルの出生グリッドは epoch×間隔+位相。horizon と親探索窓はセルごとのグリッドへ揃える。
    const phaseSeconds = cell.birthPhaseSeconds ?? 0;
    const firstEpoch = Math.ceil(
      (horizonStartSeconds - phaseSeconds) / domain.birthIntervalSeconds);
    const lastEpoch = Math.floor(
      (domain.timeSeconds - phaseSeconds) / domain.birthIntervalSeconds);
    const parentFirstEpoch = parentSearchFirstEpoch(domain, firstEpoch, phaseSeconds);
    for (let epoch = parentFirstEpoch; epoch <= lastEpoch; epoch += 1) {
      if (eventHash(domain.seed, cell.id, epoch) / UINT32_RANGE >= cell.convectivePotential) continue;
      const event = createEvent(domain, cell, epoch);
      // 源位置を持つイベントだけが外出流の親になりうる(娘の風下位置を決められないため)。
      if (outflowActive && event.sourcePosition !== undefined) parents.push(event);
      if (event.birthTimeSeconds >= horizonStartSeconds
        && event.mass.liquidKgM2 + event.mass.iceKgM2 > 0) events.push(event);
    }
  }

  if (outflowActive) {
    events.push(...sampleDescendantEvents(
      domain, domain.outflow, cellsById, parents, horizonStartSeconds,
    ));
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
