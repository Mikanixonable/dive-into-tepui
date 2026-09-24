// 雲参照 manifest が、比較値の取り違えと欠測による見かけの合格を防ぐことを検査する。
import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from '../harness';
import {
  cloudReferenceCircularDistance,
  cloudReferenceFixedBinWassersteinDistance,
  cloudReferenceMetricSampleDisposition,
  cloudReferenceScalarDistance,
  validateCloudReferenceManifest,
} from '../../tools/cloud-reference/metrics';
import { abiPixelAngles } from '../../tools/cloud-reference/abi-angles';
import { geodeticToAbiFixedGrid, abiFixedGridToGeodetic } from '../../tools/cloud-reference/abi-projection';

const GOES_EAST_ANGLES = {
  perspectivePointHeightMeters: 35_786_023,
  semiMajorAxisMeters: 6_378_137,
  semiMinorAxisMeters: 6_356_752.31414,
  longitudeOfProjectionOriginRadians: -75 * Math.PI / 180,
};
const GOES_WEST_ANGLES = { ...GOES_EAST_ANGLES, longitudeOfProjectionOriginRadians: -137.2 * Math.PI / 180 };

interface ReferenceCase {
  readonly id: string;
  readonly family: string;
  readonly split: 'tuning' | 'held-out';
  readonly cloudSystemId: string;
  readonly series: { readonly start: string; readonly end: string; readonly intervalMinutes: number };
  readonly source: {
    readonly primaryDocumentationUrl: string;
    readonly licenseUrl: string;
    readonly catalogUrl: string;
    readonly acquisitionCommand: string;
    readonly checksum: { readonly algorithm: string; readonly value: string | null; readonly requiredBeforeEvaluation: boolean };
  };
  readonly observation: {
    readonly observedAt: string;
    readonly bands: readonly string[];
    readonly processingVersion: string;
    readonly qualityFlags: readonly string[];
    readonly region: Readonly<Record<string, number>>;
    readonly angles: Readonly<Record<string, string>>;
    readonly projection: Readonly<Record<string, string>>;
    readonly effectiveGsdKm: number;
    readonly parallaxCorrection: string;
    readonly validMask: string;
    readonly calibration: Readonly<Record<string, string>>;
  };
  readonly metricIds: readonly string[];
}

interface ReferenceMetric {
  readonly id: string;
  readonly operator: string;
  readonly distance: string;
  readonly mask: string;
  readonly missingPolicy: string;
  readonly uncertaintyFloor?: number;
  readonly binEdges?: readonly number[];
}

interface ReferenceManifest {
  readonly schemaVersion: number;
  readonly metrics: readonly ReferenceMetric[];
  readonly cases: readonly ReferenceCase[];
}

const MANIFEST_PATH = resolve(process.cwd(), 'tools/cloud-reference/manifest.json');

/** ファイルから型付き manifest を読み込む。 */
function manifest(): ReferenceManifest {
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as ReferenceManifest;
}

/** 雲参照の manifest と指標契約を検査する。 */
export function register(): void {
  test('cloud reference metrics: ABI solar direction and zenith match independent NOAA GML samples', () => {
    const samples = [
      { latitudeDegrees: 0, longitudeDegrees: -75, time: '2024-03-20T16:00:00Z', projection: GOES_EAST_ANGLES },
      { latitudeDegrees: 33.846162, longitudeDegrees: -84.690932, time: '2024-06-21T16:00:00Z', projection: GOES_EAST_ANGLES },
      { latitudeDegrees: 35, longitudeDegrees: -125, time: '2024-06-10T20:00:00Z', projection: GOES_WEST_ANGLES },
      { latitudeDegrees: 0, longitudeDegrees: -137.2, time: '2024-06-21T02:00:00Z', projection: GOES_WEST_ANGLES },
      { latitudeDegrees: 58, longitudeDegrees: -135, time: '2024-12-21T20:00:00Z', projection: GOES_WEST_ANGLES },
      { latitudeDegrees: -25, longitudeDegrees: -130, time: '2024-09-22T18:00:00Z', projection: GOES_WEST_ANGLES },
    ];
    let maximumZenithError = 0;
    let maximumAzimuthError = 0;
    let maximumDirectionError = 0;
    let maximumDirectionSample = '';
    let observedSeventyDegreeSample = false;
    for (const sample of samples) {
      const geodetic = {
        latitudeRadians: sample.latitudeDegrees * Math.PI / 180,
        longitudeRadians: sample.longitudeDegrees * Math.PI / 180,
      };
      const fixedGrid = geodeticToAbiFixedGrid(geodetic, sample.projection);
      assert.ok(fixedGrid, `sample must be in view: ${JSON.stringify(sample)}`);
      const actual = abiPixelAngles(fixedGrid, sample.projection, sample.time);
      assert.ok(actual);
      const expected = noaaGmlSolarReference(sample.time, geodetic.latitudeRadians, geodetic.longitudeRadians);
      const zenithError = Math.abs(actual.solarZenithRadians - expected.zenithRadians);
      const azimuthError = circularRadiansDistance(actual.solarAzimuthRadians, expected.azimuthRadians);
      const directionError = solarDirectionSeparation(actual, expected);
      if (zenithError > maximumZenithError) {
        maximumZenithError = zenithError;
      }
      if (azimuthError > maximumAzimuthError) {
        maximumAzimuthError = azimuthError;
      }
      if (directionError > maximumDirectionError) {
        maximumDirectionError = directionError;
        maximumDirectionSample = `${sample.time} ${sample.latitudeDegrees}N ${sample.longitudeDegrees}E`;
      }
      if (Math.abs(expected.zenithRadians * 180 / Math.PI - 70) < 8) observedSeventyDegreeSample = true;
    }
    assert.ok(observedSeventyDegreeSample, 'the reference sample set must exercise solar zenith near 70 degrees');
    assert.ok(maximumZenithError < 0.5 * Math.PI / 180, `max zenith error ${maximumZenithError * 180 / Math.PI} deg`);
    assert.ok(maximumDirectionError < 0.6 * Math.PI / 180,
      `max solar direction error ${maximumDirectionError * 180 / Math.PI} deg at ${maximumDirectionSample}`);
    // 方位角は天頂軸の周りの座標で、高仰角では 3D 方向より変化に敏感になる。
    // この領域では NOAA の簡略式との角度差が相対的に大きくなる。
    assert.ok(maximumAzimuthError < 1.2 * Math.PI / 180, `max azimuth coordinate error ${maximumAzimuthError * 180 / Math.PI} deg`);
  });

  test('cloud reference metrics: solar angles match the published NREL SPA worked example', () => {
    // NREL/TP-560-34302 付録 A.5 の例: UTC−7 の 12:30:30 は 19:30:30Z。
    // この関数では例にある観測点高度 1830 m と大気差を省略している。
    const geodetic = { latitudeRadians: 39.742476 * Math.PI / 180, longitudeRadians: -105.1786 * Math.PI / 180 };
    const fixedGrid = geodeticToAbiFixedGrid(geodetic, GOES_WEST_ANGLES);
    assert.ok(fixedGrid);
    const actual = abiPixelAngles(fixedGrid, GOES_WEST_ANGLES, '2003-10-17T19:30:30Z');
    assert.ok(actual);
    assert.ok(Math.abs(actual.solarZenithRadians * 180 / Math.PI - 50.11162) < 0.02);
    assert.ok(circularDegreesDistance(actual.solarAzimuthRadians * 180 / Math.PI, 194.34024) < 0.001);
  });

  test('cloud reference metrics: ABI satellite zenith matches an independent ECEF ray and handles azimuth seam and limb', () => {
    const sample = { latitudeRadians: 35 * Math.PI / 180, longitudeRadians: -125 * Math.PI / 180 };
    const fixedGrid = geodeticToAbiFixedGrid(sample, GOES_WEST_ANGLES);
    assert.ok(fixedGrid);
    const geodetic = abiFixedGridToGeodetic(fixedGrid, GOES_WEST_ANGLES);
    const actual = abiPixelAngles(fixedGrid, GOES_WEST_ANGLES, '2024-06-10T20:00:00Z');
    assert.ok(geodetic);
    assert.ok(actual);
    const expectedViewingZenith = independentSatelliteZenith(geodetic.latitudeRadians, geodetic.longitudeRadians, GOES_WEST_ANGLES);
    assert.ok(Math.abs(actual.satelliteZenithRadians - expectedViewingZenith) < 1e-10);

    const nearNorth = geodeticToAbiFixedGrid({ latitudeRadians: 70 * Math.PI / 180, longitudeRadians: -75 * Math.PI / 180 }, GOES_EAST_ANGLES);
    assert.ok(nearNorth);
    let seamPair: readonly [NonNullable<ReturnType<typeof abiPixelAngles>>, NonNullable<ReturnType<typeof abiPixelAngles>>] | null = null;
    for (let minute = 0; minute < 1_440 && seamPair === null; minute += 1) {
      const beforeTime = new Date(Date.UTC(2024, 5, 21, 0, minute));
      const afterTime = new Date(beforeTime.getTime() + 60_000);
      const before = abiPixelAngles(nearNorth, GOES_EAST_ANGLES, beforeTime.toISOString());
      const after = abiPixelAngles(nearNorth, GOES_EAST_ANGLES, afterTime.toISOString());
      if (before !== null && after !== null && before.solarAzimuthRadians > 6 && after.solarAzimuthRadians < 0.3) {
        seamPair = [before, after];
      }
    }
    assert.ok(seamPair, 'summer high-latitude track must cross the north azimuth seam');
    assert.ok(circularRadiansDistance(seamPair[0].solarAzimuthRadians, seamPair[1].solarAzimuthRadians) < 0.1);

    const horizon = Math.asin(GOES_EAST_ANGLES.semiMajorAxisMeters
      / (GOES_EAST_ANGLES.perspectivePointHeightMeters + GOES_EAST_ANGLES.semiMajorAxisMeters));
    const limb = abiPixelAngles({ xAngleRadians: horizon, yAngleRadians: 0 }, GOES_EAST_ANGLES, '2024-06-21T12:00:00Z');
    assert.ok(limb);
    assert.ok(Math.abs(limb.satelliteZenithRadians - Math.PI / 2) < 1e-6);
    assert.equal(abiPixelAngles({ xAngleRadians: horizon + 1e-5, yAngleRadians: 0 }, GOES_EAST_ANGLES, '2024-06-21T12:00:00Z'), null);
    assert.throws(() => abiPixelAngles({ xAngleRadians: 0, yAngleRadians: 0 }, GOES_EAST_ANGLES, '2024-06-21T12:00:00'));
    assert.throws(() => abiPixelAngles({ xAngleRadians: 0, yAngleRadians: 0 }, GOES_EAST_ANGLES, '2024-02-31T12:00:00Z'));
  });

  test('cloud reference metrics: manifest fixes primary sources, geometry, calibration, and SHA-256 receipts', () => {
    const raw = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as unknown;
    assert.deepEqual(validateCloudReferenceManifest(raw), []);

    const reference = manifest();
    assert.equal(reference.schemaVersion, 1);
    assert.ok(reference.cases.every((entry) => entry.source.primaryDocumentationUrl.startsWith('https://')));
    assert.ok(reference.cases.every((entry) => entry.source.licenseUrl.startsWith('https://')));
    assert.ok(reference.cases.every((entry) => entry.source.catalogUrl.startsWith('https://')));
    assert.ok(reference.cases.every((entry) => entry.source.acquisitionCommand.length > 0));
    assert.ok(reference.cases.every((entry) => entry.source.checksum.algorithm === 'sha256'));
    assert.ok(reference.cases.every((entry) => entry.source.checksum.requiredBeforeEvaluation));
    assert.ok(reference.cases.every((entry) => entry.observation.observedAt.endsWith('Z')));
    assert.ok(reference.cases.every((entry) => entry.observation.bands.length > 0));
    assert.ok(reference.cases.every((entry) => entry.observation.processingVersion.length > 0));
    assert.ok(reference.cases.every((entry) => entry.observation.qualityFlags.length > 0));
    assert.ok(reference.cases.every((entry) => Object.keys(entry.observation.region).length === 4));
    assert.ok(reference.cases.every((entry) => Object.keys(entry.observation.angles).length === 2));
    assert.ok(reference.cases.every((entry) => Object.keys(entry.observation.projection).length >= 2));
    assert.ok(reference.cases.every((entry) => entry.observation.effectiveGsdKm > 0));
    assert.ok(reference.cases.every((entry) => entry.observation.parallaxCorrection.length > 0));
    assert.ok(reference.cases.every((entry) => entry.observation.validMask.length > 0));
    assert.ok(reference.cases.every((entry) => Object.keys(entry.observation.calibration).length >= 2));
  });

  test('cloud reference metrics: temporal metrics require enough frames in the case series', () => {
    const raw = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as {
      cases: { id: string; metricIds: string[] }[];
    };
    const mawar = raw.cases.find((entry) => entry.id === 'tropical-cyclone-mawar-2023-05-25');
    assert.ok(mawar);
    assert.ok(!mawar.metricIds.includes('lag-correlation'));

    mawar.metricIds.push('lag-correlation');
    assert.ok(validateCloudReferenceManifest(raw).some((error) =>
      error.includes('case tropical-cyclone-mawar-2023-05-25 metric lag-correlation requires at least 24 frames')));
  });

  test('cloud reference metrics: four required families split independent systems into tuning and held-out series', () => {
    const reference = manifest();
    const requiredFamilies = [
      'marine-open-and-closed-cell',
      'deep-convection-and-anvil',
      'scalloped-and-undulatus-cloud',
      'midlatitude-front-and-multilayer-cloud',
    ];
    for (const family of requiredFamilies) {
      const entries = reference.cases.filter((entry) => entry.family === family);
      assert.equal(entries.length, 2, family);
      assert.deepEqual(new Set(entries.map((entry) => entry.split)), new Set(['tuning', 'held-out']));
      assert.equal(new Set(entries.map((entry) => entry.cloudSystemId)).size, 2, family);
      assert.equal(new Set(entries.map((entry) => entry.series.start.slice(0, 10))).size, 2, family);
      assert.equal(new Set(entries.map((entry) => entry.cloudSystemId)).size, 2, family);
      assert.notEqual(entries[0]!.series.start.slice(0, 10), entries[1]!.series.start.slice(0, 10), family);
      assert.ok(entries.every((entry) => entry.series.intervalMinutes === 10), family);
    }
    assert.ok(reference.cases.some((entry) => entry.family === 'tropical-cyclone-auxiliary'));
    assert.ok(reference.cases.some((entry) => entry.family === 'orographic-cloud-auxiliary'));
  });

  test('cloud reference metrics: GOES acquisition spans the series and all required L1b/L2 products', () => {
    const reference = manifest();
    const target = reference.cases.find((entry) => entry.id === 'deep-convection-mexico-2024-06-10');
    assert.ok(target);
    const plan = JSON.parse(execFileSync(process.execPath, [
      'tools/cloud-reference/acquire.mjs',
      '--dry-run',
      target.id,
      `reference/${target.id}`,
    ], { cwd: process.cwd(), encoding: 'utf8' })) as { readonly args: readonly string[] }[];
    const sources = plan.map((step) => step.args[2]!);
    assert.equal(plan.length, 13 * 5);
    for (const product of ['ABI-L1b-RadF', 'ABI-L2-CODF', 'ABI-L2-ACHAF', 'ABI-L2-ACTPF', 'ABI-L2-ACMF']) {
      assert.ok(sources.some((source) => source.includes(`/${product}/2024/162/18/`)), product);
      assert.ok(sources.some((source) => source.includes(`/${product}/2024/163/06/`)), product);
    }

    // NOAA filenames add variable seconds to each nominal scan start, so selectors match
    // the scheduled UTC minute while excluding later scans in the endpoint hour.
    const codSelectors = plan.flatMap((step) => {
      if (!step.args[2]!.includes('/ABI-L2-CODF/')) return [];
      return step.args.flatMap((argument, index) => argument === '--include' ? [step.args[index + 1]!] : []);
    }).sort();
    const expectedCodSelectors: string[] = [];
    const seriesStartMs = Date.parse(target.series.start);
    const seriesEndMs = Date.parse(target.series.end);
    const intervalMs = target.series.intervalMinutes * 60_000;
    for (let scanMs = seriesStartMs; scanMs <= seriesEndMs; scanMs += intervalMs) {
      const scan = new Date(scanMs);
      const yearStart = Date.UTC(scan.getUTCFullYear(), 0, 1);
      const day = String(Math.floor((scanMs - yearStart) / 86_400_000) + 1).padStart(3, '0');
      const hour = String(scan.getUTCHours()).padStart(2, '0');
      const minute = String(scan.getUTCMinutes()).padStart(2, '0');
      expectedCodSelectors.push(`OR_ABI-L2-CODF-M6_G18_s${scan.getUTCFullYear()}${day}${hour}${minute}*.nc`);
    }
    assert.deepEqual(codSelectors, expectedCodSelectors.sort());
    assert.ok(codSelectors[0]!.includes('_s20241621800*.nc'));
    assert.ok(codSelectors.at(-1)!.includes('_s20241630600*.nc'));
    assert.ok(!codSelectors.some((selector) => selector.includes('_s20241630610')));
    assert.equal(
      target.source.acquisitionCommand,
      `node tools/cloud-reference/acquire.mjs ${target.id} reference/${target.id}`,
    );
  });

  test('cloud reference metrics: scalar, distribution, and direction distances retain their distinct definitions', () => {
    assert.equal(cloudReferenceScalarDistance(12, 10, 4, 3), 0.5);
    assert.equal(cloudReferenceScalarDistance(12, 10, 1, 3), 2 / 3);
    assert.equal(cloudReferenceFixedBinWassersteinDistance([1, 0], [0, 1], [0, 2, 4]), 2);
    assert.equal(cloudReferenceFixedBinWassersteinDistance([1, 0, 0, 0], [0, 0, 0, 1], [0, 2, 4, 6, 8]), 6);
    assert.ok(Math.abs(cloudReferenceCircularDistance(0, Math.PI * 2 - 0.1) - 0.1) < 1e-12);
  });

  test('cloud reference metrics: masked and missing samples cannot become zero-error samples', () => {
    assert.equal(cloudReferenceMetricSampleDisposition({ generated: 0, reference: 0, validMask: false }), 'masked');
    assert.equal(cloudReferenceMetricSampleDisposition({ generated: null, reference: 0, validMask: true }), 'missing-generated');
    assert.equal(cloudReferenceMetricSampleDisposition({ generated: 0, reference: null, validMask: true }), 'missing-reference');
    assert.equal(cloudReferenceMetricSampleDisposition({ generated: Number.NaN, reference: 0, validMask: true }), 'missing-generated');
    assert.equal(cloudReferenceMetricSampleDisposition({ generated: 0, reference: Number.POSITIVE_INFINITY, validMask: true }), 'missing-reference');
    assert.equal(cloudReferenceMetricSampleDisposition({ generated: 0, reference: 0, validMask: true }), 'included');
  });

  test('cloud reference metrics: radiance uses a linear sensor-band operator and RGB stays morphology-only', () => {
    const reference = manifest();
    const radiance = reference.metrics.find((metric) => metric.id === 'visible-toa-reflectance');
    assert.ok(radiance);
    assert.match(radiance.operator, /linear generated spectral radiance/);
    assert.match(radiance.operator, /spectral response/);
    assert.match(radiance.operator, /solar zenith/);
    assert.equal(radiance.missingPolicy, 'fail');
    assert.ok((radiance.uncertaintyFloor ?? 0) > 0);

    const morphology = reference.metrics.find((metric) => metric.id === 'structure-size-distribution');
    assert.ok(morphology);
    assert.match(morphology.operator, /tone-mapped RGB is used only to derive the common morphology mask/);
    assert.equal(morphology.distance, 'fixed-bin-wasserstein');
  });

  test('cloud reference metrics: schema rejects an omitted mask or an undeclared metric', () => {
    const raw = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as {
      metrics: Record<string, unknown>[];
      cases: Record<string, unknown>[];
    };
    delete raw.metrics[0]!.mask;
    raw.cases[0]!.metricIds = ['not-declared'];
    const errors = validateCloudReferenceManifest(raw);
    assert.ok(errors.some((error) => error.includes('must declare quantity, unit, operator, mask')));
    assert.ok(errors.some((error) => error.includes('must reference unique declared metrics')));
  });

  test('cloud reference metrics: schema rejects incomplete receipts and geometry while allowing pending checksums', () => {
    const raw = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as {
      metrics: Record<string, unknown>[];
      cases: Record<string, unknown>[];
    };
    const first = raw.cases[0]!;
    const source = first.source as Record<string, unknown>;
    const checksum = source.checksum as Record<string, unknown>;
    checksum.value = null;
    assert.deepEqual(validateCloudReferenceManifest(raw), []);

    checksum.requiredBeforeEvaluation = false;
    const observation = first.observation as Record<string, unknown>;
    delete (observation.projection as Record<string, unknown>).epsg;
    assert.ok(validateCloudReferenceManifest(raw).some((error) => error.includes('required SHA-256 receipt')));
    assert.ok(validateCloudReferenceManifest(raw).some((error) => error.includes('projection, GSD')));
  });

  test('cloud reference metrics: schema rejects a missing required family or either split', () => {
    const withoutFamily = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as {
      cases: Record<string, unknown>[];
    };
    withoutFamily.cases = withoutFamily.cases.filter(
      (entry) => entry.family !== 'marine-open-and-closed-cell',
    );
    assert.ok(validateCloudReferenceManifest(withoutFamily).some(
      (error) => error.includes('family marine-open-and-closed-cell'),
    ));

    const withoutHeldOut = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as {
      cases: Record<string, unknown>[];
    };
    const heldOut = withoutHeldOut.cases.find(
      (entry) => entry.family === 'deep-convection-and-anvil' && entry.split === 'held-out',
    );
    assert.ok(heldOut);
    heldOut.split = 'tuning';
    assert.ok(validateCloudReferenceManifest(withoutHeldOut).some(
      (error) => error.includes('family deep-convection-and-anvil'),
    ));
  });

  test('cloud reference metrics: histogram distance rejects malformed or empty mass', () => {
    assert.throws(() => cloudReferenceFixedBinWassersteinDistance([1, 0], [0, 1], [0, 4]));
    assert.throws(() => cloudReferenceFixedBinWassersteinDistance([0, 0], [1, 0], [0, 1, 2]));
    assert.throws(() => cloudReferenceFixedBinWassersteinDistance([1, -1], [0, 1], [0, 1, 2]));
  });
}

/** NOAA GML の分数年・均時差・太陽赤緯式を独立に計算する。 */
function noaaGmlSolarReference(
  timestamp: string,
  latitudeRadians: number,
  longitudeRadians: number,
): { readonly east: number; readonly north: number; readonly up: number; readonly zenithRadians: number; readonly azimuthRadians: number } {
  const instant = new Date(timestamp);
  const year = instant.getUTCFullYear();
  const dayOfYear = (Date.UTC(year, instant.getUTCMonth(), instant.getUTCDate()) - Date.UTC(year, 0, 1)) / 86_400_000 + 1;
  const yearLength = new Date(Date.UTC(year + 1, 0, 1)).getTime() - Date.UTC(year, 0, 1) === 366 * 86_400_000 ? 366 : 365;
  const utcHours = instant.getUTCHours() + instant.getUTCMinutes() / 60 + instant.getUTCSeconds() / 3600;
  const gamma = 2 * Math.PI / yearLength * (dayOfYear - 1 + (utcHours - 12) / 24);
  const equationOfTimeMinutes = 229.18 * (0.000075 + 0.001868 * Math.cos(gamma) - 0.032077 * Math.sin(gamma)
    - 0.014615 * Math.cos(2 * gamma) - 0.040849 * Math.sin(2 * gamma));
  const declination = 0.006918 - 0.399912 * Math.cos(gamma) + 0.070257 * Math.sin(gamma)
    - 0.006758 * Math.cos(2 * gamma) + 0.000907 * Math.sin(2 * gamma)
    - 0.002697 * Math.cos(3 * gamma) + 0.00148 * Math.sin(3 * gamma);
  const longitudeDegreesEast = longitudeRadians * 180 / Math.PI;
  const utcMinutes = utcHours * 60;
  const trueSolarMinutes = utcMinutes + equationOfTimeMinutes + 4 * longitudeDegreesEast;
  const hourAngle = (trueSolarMinutes / 4 - 180) * Math.PI / 180;
  const east = -Math.cos(declination) * Math.sin(hourAngle);
  const north = Math.cos(latitudeRadians) * Math.sin(declination)
    - Math.sin(latitudeRadians) * Math.cos(declination) * Math.cos(hourAngle);
  const up = Math.sin(latitudeRadians) * Math.sin(declination)
    + Math.cos(latitudeRadians) * Math.cos(declination) * Math.cos(hourAngle);
  return {
    east,
    north,
    up,
    zenithRadians: Math.acos(Math.max(-1, Math.min(1, up))),
    azimuthRadians: normalizeTestAngle(Math.atan2(east, north)),
  };
}

/** 実装値と参照値の単位太陽方向ベクトル間の角度。 */
function solarDirectionSeparation(
  actual: NonNullable<ReturnType<typeof abiPixelAngles>>,
  expected: ReturnType<typeof noaaGmlSolarReference>,
): number {
  const horizontal = Math.sin(actual.solarZenithRadians);
  const east = horizontal * Math.sin(actual.solarAzimuthRadians);
  const north = horizontal * Math.cos(actual.solarAzimuthRadians);
  const up = Math.cos(actual.solarZenithRadians);
  const dot = east * expected.east + north * expected.north + up * expected.up;
  return Math.acos(Math.max(-1, Math.min(1, dot)));
}

/** 衛星観測角の独立検査用 ECEF 視線・測地法線計算。 */
function independentSatelliteZenith(
  latitude: number,
  longitude: number,
  projection: typeof GOES_WEST_ANGLES,
): number {
  const a = projection.semiMajorAxisMeters;
  const b = projection.semiMinorAxisMeters;
  const eccentricitySquared = (a * a - b * b) / (a * a);
  const denominator = Math.sqrt(1 - eccentricitySquared * Math.sin(latitude) ** 2);
  const surfaceX = a / denominator * Math.cos(latitude) * Math.cos(longitude);
  const surfaceY = a / denominator * Math.cos(latitude) * Math.sin(longitude);
  const surfaceZ = a * (1 - eccentricitySquared) / denominator * Math.sin(latitude);
  const orbitRadius = a + projection.perspectivePointHeightMeters;
  const satelliteX = orbitRadius * Math.cos(projection.longitudeOfProjectionOriginRadians);
  const satelliteY = orbitRadius * Math.sin(projection.longitudeOfProjectionOriginRadians);
  const dx = satelliteX - surfaceX;
  const dy = satelliteY - surfaceY;
  const dz = -surfaceZ;
  const distance = Math.hypot(dx, dy, dz);
  const normalProjection = dx * Math.cos(latitude) * Math.cos(longitude)
    + dy * Math.cos(latitude) * Math.sin(longitude) + dz * Math.sin(latitude);
  return Math.acos(Math.max(-1, Math.min(1, normalProjection / distance)));
}

function normalizeTestAngle(angle: number): number {
  return ((angle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
}

function circularRadiansDistance(a: number, b: number): number {
  const difference = Math.abs(normalizeTestAngle(a) - normalizeTestAngle(b));
  return Math.min(difference, 2 * Math.PI - difference);
}

function circularDegreesDistance(a: number, b: number): number {
  const difference = Math.abs(((a - b) % 360 + 360) % 360);
  return Math.min(difference, 360 - difference);
}
