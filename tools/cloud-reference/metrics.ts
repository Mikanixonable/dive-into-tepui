// 雲参照 manifest の契約と比較指標を定義する。

export interface CloudReferenceMetricSample {
  readonly generated: number | null;
  readonly reference: number | null;
  readonly validMask: boolean;
}

export type CloudReferenceMetricSampleDisposition = 'included' | 'masked' | 'missing-generated' | 'missing-reference';

const REQUIRED_REFERENCE_FAMILIES = [
  'marine-open-and-closed-cell',
  'deep-convection-and-anvil',
  'scalloped-and-undulatus-cloud',
  'midlatitude-front-and-multilayer-cloud',
] as const;

/** 評価標本を mask と欠測から区別して判定する。 */
export function cloudReferenceMetricSampleDisposition(
  sample: CloudReferenceMetricSample,
): CloudReferenceMetricSampleDisposition {
  if (sample.validMask !== true) return 'masked';
  if (!Number.isFinite(sample.generated)) return 'missing-generated';
  if (!Number.isFinite(sample.reference)) return 'missing-reference';
  return 'included';
}

/** 参照系列の中央値・IQR と観測不確かさ床でスカラー差を正規化する。 */
export function cloudReferenceScalarDistance(
  generated: number,
  referenceMedian: number,
  referenceIqr: number,
  uncertaintyFloor: number,
): number {
  if (!Number.isFinite(generated) || !Number.isFinite(referenceMedian)) {
    throw new Error('Cloud reference scalar distance requires finite values');
  }
  if (!Number.isFinite(referenceIqr) || referenceIqr < 0) {
    throw new Error('Cloud reference scalar distance requires a non-negative IQR');
  }
  if (!Number.isFinite(uncertaintyFloor) || uncertaintyFloor <= 0) {
    throw new Error('Cloud reference scalar distance requires a positive uncertainty floor');
  }
  const distance = Math.abs(generated - referenceMedian) / Math.max(referenceIqr, uncertaintyFloor);
  if (!Number.isFinite(distance)) throw new Error('Cloud reference scalar distance must be finite');
  return distance;
}

/** 固定 bin の中心へ置いた正規化質量間の一次 Wasserstein 距離を返す。 */
export function cloudReferenceFixedBinWassersteinDistance(
  generatedBins: readonly number[],
  referenceBins: readonly number[],
  binEdges: readonly number[],
): number {
  if (generatedBins.length === 0 || generatedBins.length !== referenceBins.length
    || binEdges.length !== generatedBins.length + 1) {
    throw new Error('Cloud reference Wasserstein distance requires one more edge than equally sized non-empty histograms');
  }
  if (!isIncreasingNumberArray(binEdges)) {
    throw new Error('Cloud reference Wasserstein distance requires increasing finite bin edges');
  }
  const generatedTotal = histogramTotal(generatedBins);
  const referenceTotal = histogramTotal(referenceBins);
  let generatedCdf = 0;
  let referenceCdf = 0;
  let distance = 0;
  for (let index = 0; index < generatedBins.length - 1; index += 1) {
    generatedCdf += generatedBins[index]! / generatedTotal;
    referenceCdf += referenceBins[index]! / referenceTotal;
    const leftCenter = (binEdges[index]! + binEdges[index + 1]!) / 2;
    const rightCenter = (binEdges[index + 1]! + binEdges[index + 2]!) / 2;
    distance += Math.abs(generatedCdf - referenceCdf) * (rightCenter - leftCenter);
  }
  if (!Number.isFinite(distance)) throw new Error('Cloud reference Wasserstein distance must be finite');
  return distance;
}

/** 角度 [rad] の最短円周距離を返す。 */
export function cloudReferenceCircularDistance(
  generatedRad: number,
  referenceRad: number,
): number {
  if (!Number.isFinite(generatedRad) || !Number.isFinite(referenceRad)) {
    throw new Error('Cloud reference circular distance requires finite angles');
  }
  return Math.abs(Math.atan2(
    Math.sin(generatedRad - referenceRad),
    Math.cos(generatedRad - referenceRad),
  ));
}

/** manifest が比較に必要な出典・観測・評価条件を宣言しているか検査する。 */
export function validateCloudReferenceManifest(value: unknown): readonly string[] {
  if (!isRecord(value)) return ['manifest must be an object'];
  const errors: string[] = [];
  // マニフェストと指標の宣言を検査する。
  if (value.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  if (!isNonEmptyString(value.purpose)) errors.push('purpose must be a non-empty string');
  if (!isIsoUtc(value.recordedAt)) errors.push('recordedAt must be a UTC timestamp');

  const metrics = value.metrics;
  const metricIds = new Set<string>();
  const metricsById = new Map<string, unknown>();
  if (!Array.isArray(metrics) || metrics.length === 0) {
    errors.push('metrics must be a non-empty array');
  } else {
    for (const metric of metrics) {
      validateMetric(metric, metricIds, errors);
      if (isRecord(metric) && isNonEmptyString(metric.id)) metricsById.set(metric.id, metric);
    }
  }

  // 系列の識別子と、調整／検証日の分離を検査する。
  const cases = value.cases;
  if (!Array.isArray(cases) || cases.length === 0) {
    errors.push('cases must be a non-empty array');
  } else {
    const caseIds = new Set<string>();
    const systems = new Set<string>();
    const families = new Map<string, { tuning: number; heldOut: number; days: Set<string> }>();
    for (const referenceCase of cases) {
      validateCase(referenceCase, caseIds, systems, metricsById, errors);
      if (!isRecord(referenceCase) || !isString(referenceCase.family)
        || (referenceCase.split !== 'tuning' && referenceCase.split !== 'held-out')
        || !isRecord(referenceCase.series) || !isIsoUtc(referenceCase.series.start)) continue;
      const family = families.get(referenceCase.family) ?? { tuning: 0, heldOut: 0, days: new Set<string>() };
      if (referenceCase.split === 'tuning') family.tuning += 1;
      else family.heldOut += 1;
      family.days.add(referenceCase.series.start.slice(0, 10));
      families.set(referenceCase.family, family);
    }
    for (const familyId of REQUIRED_REFERENCE_FAMILIES) {
      const family = families.get(familyId);
      if (family === undefined
        || family.tuning !== 1 || family.heldOut !== 1 || family.days.size !== 2) {
        errors.push(`family ${familyId} must use distinct tuning and held-out observation days`);
      }
    }
  }
  return errors;
}

/** ヒストグラムの有限かつ正の総質量を返す。 */
function histogramTotal(bins: readonly number[]): number {
  let total = 0;
  for (const value of bins) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error('Cloud reference histogram bins must be finite and non-negative');
    }
    total += value;
  }
  if (!Number.isFinite(total) || total <= 0) throw new Error('Cloud reference histogram must contain finite mass');
  return total;
}

/** 指標宣言に演算子・距離式・mask・欠測方針を求める。 */
function validateMetric(metric: unknown, metricIds: Set<string>, errors: string[]): void {
  if (!isRecord(metric)) {
    errors.push('metric must be an object');
    return;
  }
  if (!isNonEmptyString(metric.id) || metricIds.has(metric.id)) {
    errors.push('metric id must be unique');
  } else {
    metricIds.add(metric.id);
  }
  const id = String(metric.id);
  // 各指標の意味、品質条件、観測演算子を検査する。
  if (!isNonEmptyString(metric.quantity) || !isNonEmptyString(metric.unit)
    || !isNonEmptyString(metric.operator) || !isNonEmptyString(metric.mask)
    || metric.missingPolicy !== 'fail') {
    errors.push(`metric ${id} must declare quantity, unit, operator, mask, and fail on missing samples`);
  }
  if (!isRecord(metric.coveragePolicy) || !isPositiveNumber(metric.coveragePolicy.minimumValidFrames)
    || !isFraction(metric.coveragePolicy.minimumValidAreaFraction)) {
    errors.push(`metric ${id} must declare a positive frame count and valid-area fraction`);
  } else if (!Number.isInteger(metric.coveragePolicy.minimumValidFrames)) {
    errors.push(`metric ${id} minimumValidFrames must be an integer`);
  }
  if (metric.minimumSeriesDurationMinutes !== undefined
    && !isPositiveNumber(metric.minimumSeriesDurationMinutes)) {
    errors.push(`metric ${id} minimumSeriesDurationMinutes must be positive`);
  }
  if (metric.id === 'visible-toa-reflectance'
    && (!isDegreeRange(metric.applicableSolarZenithDeg, 0, 90)
      || !isDegreeRange(metric.applicableSatelliteZenithDeg, 0, 90))) {
    errors.push(`metric ${id} must declare valid solar and satellite zenith ranges`);
  }
  if (metric.distance === 'scalar-median-iqr-floor') {
    if (!isPositiveNumber(metric.uncertaintyFloor)) errors.push(`metric ${id} must have a positive uncertaintyFloor`);
    return;
  }
  if (metric.distance === 'fixed-bin-wasserstein') {
    if (!isIncreasingNumberArray(metric.binEdges)) errors.push(`metric ${id} must declare fixed increasing bin edges`);
    return;
  }
  if (metric.distance === 'circular-distance') {
    if (metric.unit !== 'rad') errors.push(`metric ${id} circular distance must use radians`);
    return;
  }
  errors.push(`metric ${id} has an unsupported distance`);
}

/** 参照系列に取得・観測・評価条件が揃っているか検査する。 */
function validateCase(
  referenceCase: unknown,
  caseIds: Set<string>,
  systems: Set<string>,
  metricsById: ReadonlyMap<string, unknown>,
  errors: string[],
): void {
  if (!isRecord(referenceCase)) {
    errors.push('case must be an object');
    return;
  }
  // 識別子と時系列の分割を検査する。
  const id = String(referenceCase.id);
  if (!isNonEmptyString(referenceCase.id) || caseIds.has(referenceCase.id)) {
    errors.push('case id must be unique');
  } else {
    caseIds.add(referenceCase.id);
  }
  if (!isNonEmptyString(referenceCase.family)) errors.push(`case ${id} must declare a family`);
  if (referenceCase.split !== 'tuning' && referenceCase.split !== 'held-out') {
    errors.push(`case ${id} must declare tuning or held-out split`);
  }
  const cloudSystemId = referenceCase.cloudSystemId;
  if (!isNonEmptyString(cloudSystemId) || systems.has(cloudSystemId)) {
    errors.push(`case ${id} must have an independent cloudSystemId`);
  } else {
    systems.add(cloudSystemId);
  }
  if (!isRecord(referenceCase.series) || !isIsoUtc(referenceCase.series.start)
    || !isIsoUtc(referenceCase.series.end) || !isPositiveNumber(referenceCase.series.intervalMinutes)
    || Date.parse(referenceCase.series.start) >= Date.parse(referenceCase.series.end)) {
    errors.push(`case ${id} must declare an increasing UTC series and positive interval`);
  }
  // 出典と観測の全条件を検査する。
  validateSource(referenceCase.source, id, errors);
  validateObservation(referenceCase.observation, id, errors);
  if (!Array.isArray(referenceCase.metricIds) || referenceCase.metricIds.length === 0
    || referenceCase.metricIds.some((metricId) => !isString(metricId) || !metricsById.has(metricId))
    || new Set(referenceCase.metricIds).size !== referenceCase.metricIds.length) {
    errors.push(`case ${id} must reference unique declared metrics`);
    return;
  }
  validateMetricCoverageSupport(referenceCase, id, metricsById, errors);
}

/** 実在する参照フレーム数と指標ごとの最低有効フレーム数を検査する。 */
function validateMetricCoverageSupport(
  referenceCase: Readonly<Record<string, unknown>>,
  id: string,
  metricsById: ReadonlyMap<string, unknown>,
  errors: string[],
): void {
  if (!Array.isArray(referenceCase.metricIds) || !isRecord(referenceCase.series)
    || !isIsoUtc(referenceCase.series.start) || !isIsoUtc(referenceCase.series.end)
    || !isPositiveNumber(referenceCase.series.intervalMinutes)) return;
  const intervalMilliseconds = referenceCase.series.intervalMinutes * 60_000;
  const durationMilliseconds = Date.parse(referenceCase.series.end) - Date.parse(referenceCase.series.start);
  const scheduledFrames = Math.floor(durationMilliseconds / intervalMilliseconds) + 1;
  const availableFrames = referenceCase.availableFrameCount ?? scheduledFrames;
  const frameOverrides = referenceCase.minimumValidFramesByMetric;
  if (frameOverrides !== undefined && referenceCase.availableFrameCount === undefined) {
    errors.push(`case ${id} must declare availableFrameCount when overriding metric frame coverage`);
    return;
  }
  if (!Number.isInteger(availableFrames) || !isPositiveNumber(availableFrames)
    || availableFrames > scheduledFrames) {
    errors.push(`case ${id} availableFrameCount must be a positive integer within the declared series`);
    return;
  }
  if (frameOverrides !== undefined && !isRecord(frameOverrides)) {
    errors.push(`case ${id} minimumValidFramesByMetric must be an object`);
    return;
  }
  if (isRecord(frameOverrides)) {
    for (const [metricId, minimumFrames] of Object.entries(frameOverrides)) {
      if (!referenceCase.metricIds.includes(metricId) || !Number.isInteger(minimumFrames)
        || !isPositiveNumber(minimumFrames) || minimumFrames > availableFrames) {
        errors.push(`case ${id} has an invalid minimumValidFramesByMetric entry for ${metricId}`);
      }
    }
  }
  for (const metricId of referenceCase.metricIds) {
    const metric = metricsById.get(metricId);
    const coverage = isRecord(metric) ? metric.coveragePolicy : null;
    if (!isRecord(coverage) || !isPositiveNumber(coverage.minimumValidFrames)) continue;
    const minimumSeriesDurationMinutes = isRecord(metric) && isPositiveNumber(metric.minimumSeriesDurationMinutes)
      ? metric.minimumSeriesDurationMinutes
      : null;
    const minimumFrames = minimumSeriesDurationMinutes !== null
      ? coverage.minimumValidFrames
      : (isRecord(frameOverrides) && frameOverrides[metricId] !== undefined
        ? frameOverrides[metricId]
        : coverage.minimumValidFrames);
    if (!isPositiveNumber(minimumFrames) || availableFrames < minimumFrames) {
      errors.push(`case ${id} metric ${metricId} requires at least ${minimumFrames} available frames`);
    }
    if (minimumSeriesDurationMinutes !== null) {
      const availableDurationMinutes = (availableFrames - 1) * referenceCase.series.intervalMinutes;
      if (availableDurationMinutes < minimumSeriesDurationMinutes) {
        errors.push(`case ${id} metric ${metricId} requires at least ${minimumSeriesDurationMinutes} minutes of available temporal support`);
      }
    }
  }
}

/** 取得再現性とライセンス確認に必要な出典情報を検査する。 */
function validateSource(source: unknown, id: string, errors: string[]): void {
  if (!isRecord(source) || !isNonEmptyString(source.provider) || !isNonEmptyString(source.product)
    || !isHttpsUrl(source.primaryDocumentationUrl) || !isHttpsUrl(source.licenseUrl)
    || !isHttpsUrl(source.catalogUrl) || !isIsoUtc(source.availabilityCheckedAt)
    || !isNonEmptyString(source.acquisitionCommand) || !isRecord(source.checksum)
    || source.checksum.algorithm !== 'sha256' || !isNonEmptyString(source.checksum.scope)
    || (source.checksum.value !== null && (!isString(source.checksum.value) || !/^[a-f0-9]{64}$/.test(source.checksum.value)))
    || source.checksum.requiredBeforeEvaluation !== true) {
    errors.push(`case ${id} must declare licensed source, checked availability, acquisition, and required SHA-256 receipt`);
  }
}

/** 観測値と生成側の対応付けに必要な幾何・校正条件を検査する。 */
function validateObservation(observation: unknown, id: string, errors: string[]): void {
  const region = isRecord(observation) ? observation.region : null;
  const angles = isRecord(observation) ? observation.angles : null;
  const projection = isRecord(observation) ? observation.projection : null;
  const calibration = isRecord(observation) ? observation.calibration : null;
  // 有効な観測範囲と幾何条件を検査する。
  if (!isRecord(observation) || !isIsoUtc(observation.observedAt)
    || !isNonEmptyStringArray(observation.bands) || !isNonEmptyString(observation.processingVersion)
    || !isNonEmptyStringArray(observation.qualityFlags)
    || !isRecord(region) || !isFiniteNumber(region.westLonDeg) || !isFiniteNumber(region.eastLonDeg)
    || !isFiniteNumber(region.southLatDeg) || !isFiniteNumber(region.northLatDeg)
    || region.westLonDeg >= region.eastLonDeg || region.southLatDeg >= region.northLatDeg
    || region.westLonDeg < -180 || region.eastLonDeg > 180
    || region.southLatDeg < -90 || region.northLatDeg > 90
    || !isRecord(angles) || !isNonEmptyString(angles.satellite) || !isNonEmptyString(angles.solar)
    || !isRecord(projection) || !isNonEmptyString(projection.name) || !isNonEmptyString(projection.epsg)
    || !isNonEmptyString(projection.resampling) || !isPositiveNumber(observation.effectiveGsdKm)
    || !isNonEmptyString(observation.parallaxCorrection) || !isNonEmptyString(observation.validMask)
    || !isRecord(calibration) || !isNonEmptyString(calibration.radiance)
    || !isNonEmptyString(calibration.reflectance) || !isNonEmptyString(calibration.toneMapping)) {
    errors.push(`case ${id} must declare timestamp, bands, quality, valid region, angles, projection, GSD, parallax, mask, and calibration`);
  }
}

/** 配列ではない object を record として判定する。 */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 値が文字列か判定する。 */
function isString(value: unknown): value is string {
  return typeof value === 'string';
}

/** 空白だけではない文字列か判定する。 */
function isNonEmptyString(value: unknown): value is string {
  return isString(value) && value.trim().length > 0;
}

/** 空でなく、空文字を含まない文字列列か判定する。 */
function isNonEmptyStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString);
}

/** 有限数か判定する。 */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** 有限の正数か判定する。 */
function isPositiveNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0;
}

/** 0 より大きく 1 以下の比率か判定する。 */
function isFraction(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0 && value <= 1;
}

/** 0 から 90 度内の昇順範囲か判定する。 */
function isDegreeRange(value: unknown, minimum: number, maximum: number): value is readonly [number, number] {
  return Array.isArray(value) && value.length === 2 && isFiniteNumber(value[0]) && isFiniteNumber(value[1])
    && value[0] >= minimum && value[1] <= maximum && value[0] <= value[1];
}

/** UTC の ISO 8601 秒時刻か判定する。 */
function isIsoUtc(value: unknown): value is string {
  return isString(value) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)
    && Number.isFinite(Date.parse(value));
}

/** HTTPS URL の形を持つ文字列か判定する。 */
function isHttpsUrl(value: unknown): value is string {
  return isString(value) && /^https:\/\/[^\s]+$/.test(value);
}

/** 有限数が狭義単調増加する列か判定する。 */
function isIncreasingNumberArray(value: unknown): value is readonly number[] {
  if (!Array.isArray(value) || value.length < 3 || !value.every(isFiniteNumber)) return false;
  for (let index = 1; index < value.length; index += 1) {
    if (value[index]! <= value[index - 1]!) return false;
  }
  return true;
}
