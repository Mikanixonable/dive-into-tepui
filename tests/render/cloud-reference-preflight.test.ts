// NOAA S3 の一覧を模した応答で取得前の欠測・重複・容量判定を検査する。
import * as assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { test } from '../harness';
import type * as Preflight from '../../tools/cloud-reference/preflight.mjs';
import type * as Selection from '../../tools/cloud-reference/selection.mjs';
const nodeRequire = createRequire(__filename);
const { parseListObjectsV2Xml, preflightReferenceCases } = nodeRequire(
  resolve(process.cwd(), 'tools/cloud-reference/preflight.mjs'),
) as typeof Preflight;
const { plannedNetcdfSelectors } = nodeRequire(
  resolve(process.cwd(), 'tools/cloud-reference/selection.mjs'),
) as typeof Selection;

const referenceCase = {
  id: 'synthetic-noaa',
  source: { provider: 'NOAA', product: 'GOES-18 ABI L1b Radiances Full Disk' },
  series: {
    start: '2024-06-10T18:00:00Z',
    end: '2024-06-10T18:10:00Z',
    intervalMinutes: 10,
  },
};

/** 継続 token 付きの S3 一覧応答を構築する。 */
function xmlPage(objects: readonly { readonly key: string; readonly sizeBytes: number }[], token: string | null): string {
  const contents = objects.map(({ key, sizeBytes }) => (
    `<Contents><Key>${key}</Key><Size>${sizeBytes}</Size></Contents>`
  )).join('');
  const continuation = token === null ? '' : `<NextContinuationToken>${token}</NextContinuationToken>`;
  return `<ListBucketResult><IsTruncated>${token !== null}</IsTruncated>${continuation}${contents}</ListBucketResult>`;
}

/** ケースの全予定スロットに対応する模擬 NetCDF 一覧を返す。 */
function plannedObjects() {
  return plannedNetcdfSelectors(referenceCase).map((selector) => {
    const hourPrefix = `${selector.productPrefix}/2024/162/18/`;
    return {
      key: `${hourPrefix}${selector.filenamePrefix}000_e${selector.scanMinute}001_c${selector.scanMinute}002.nc`,
      sizeBytes: 10,
    };
  });
}

/** 一覧を１件ずつ返し、ページングを必ず通す。 */
function fakeFetch(objects: readonly { readonly key: string; readonly sizeBytes: number }[]) {
  return async (url: URL) => {
    const prefix = url.searchParams.get('prefix') ?? '';
    const offset = Number(url.searchParams.get('continuation-token') ?? 0);
    const matching = objects.filter((object) => object.key.startsWith(prefix));
    const page = matching.slice(offset, offset + 1);
    const next = offset + 1 < matching.length ? String(offset + 1) : null;
    return { ok: true, text: async () => xmlPage(page, next) };
  };
}

/** S3 metadata の照合が全予定系列を厳密に数えることを検査する。 */
export function register(): void {
  test('cloud reference preflight: pagination yields exact NOAA selector coverage and byte total', async () => {
    const result = await preflightReferenceCases([referenceCase], {
      fetchImplementation: fakeFetch(plannedObjects()),
      maxKeys: 1,
    });
    assert.equal(result.complete, true);
    assert.equal(result.total.expectedFileCount, 12);
    assert.equal(result.total.exactSelectorCount, 12);
    assert.equal(result.total.bytes, 120);
    assert.equal(result.total.missingCount, 0);
    assert.equal(result.total.duplicateCount, 0);
  });

  test('cloud reference preflight: missing and duplicate source files fail complete coverage', async () => {
    const objects = plannedObjects();
    const missing = await preflightReferenceCases([referenceCase], {
      fetchImplementation: fakeFetch(objects.slice(1)),
    });
    assert.equal(missing.complete, false);
    assert.equal(missing.total.missingCount, 1);
    const first = objects[0]!;
    const duplicate = { ...first, key: first.key.replace('_c20241621800002', '_c20241621800003') };
    const duplicated = await preflightReferenceCases([referenceCase], {
      fetchImplementation: fakeFetch([...objects, duplicate]),
    });
    assert.equal(duplicated.complete, false);
    assert.equal(duplicated.total.duplicateCount, 1);
  });

  test('cloud reference preflight: malformed S3 XML cannot be accepted as empty coverage', () => {
    assert.throws(() => parseListObjectsV2Xml('<Error><Code>AccessDenied</Code></Error>'));
    assert.throws(() => parseListObjectsV2Xml(xmlPage([], 'repeated').replace(
      '</ListBucketResult>', '<NextContinuationToken>again</NextContinuationToken></ListBucketResult>',
    )));
    assert.throws(() => parseListObjectsV2Xml('<!DOCTYPE unsafe><ListBucketResult></ListBucketResult>'));
  });
}
