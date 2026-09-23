// 雲参照 manifest が、比較値の取り違えと欠測による見かけの合格を防ぐことを検査する。
import * as assert from 'node:assert/strict';
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

  test('cloud reference metrics: histogram distance rejects malformed or empty mass', () => {
    assert.throws(() => cloudReferenceFixedBinWassersteinDistance([1, 0], [0, 1], [0, 4]));
    assert.throws(() => cloudReferenceFixedBinWassersteinDistance([0, 0], [1, 0], [0, 1, 2]));
    assert.throws(() => cloudReferenceFixedBinWassersteinDistance([1, -1], [0, 1], [0, 1, 2]));
  });
}
