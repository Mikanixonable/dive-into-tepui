import * as assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from '../harness';

const CASE_ID = 'tropical-cyclone-mawar-2023-05-25';
const SOURCE_URL = 'https://wvs.earthdata.nasa.gov/api/v1/snapshot?REQUEST=GetSnapshot&TIME=2023-05-25T00:00:00Z&BBOX=-5,120,35,160&CRS=EPSG:4326&LAYERS=VIIRS_NOAA20_CorrectedReflectance_TrueColor&WRAP=day&FORMAT=image/png&WIDTH=1024&HEIGHT=1024';
const IMAGE = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  Buffer.from('synthetic png payload'),
]);
const ACQUIRE_SCRIPT = resolve(process.cwd(), 'tools/cloud-reference/acquire-aux.mjs');

interface AcquisitionReceipt {
  readonly sourceUrl: string;
  readonly finalUrl: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly algorithm: string;
  readonly sha256: string;
}

type FetchImplementation = (input: string, init: { readonly redirect: string }) => Promise<Response>;
type AcquireMawarReference = (repositoryRoot: string, fetchImplementation: FetchImplementation) => Promise<AcquisitionReceipt>;
type VerifyMawarReference = (repositoryRoot: string) => {
  readonly status: string;
  readonly sizeBytes: number;
  readonly sha256: string;
};

async function acquireMawarReference(): Promise<AcquireMawarReference> {
  const modulePath = ACQUIRE_SCRIPT;
  const acquisitionModule = await import(modulePath) as { acquireMawarReference: AcquireMawarReference };
  return acquisitionModule.acquireMawarReference;
}

async function verifyMawarReference(): Promise<VerifyMawarReference> {
  const verificationModule = await import(ACQUIRE_SCRIPT) as { verifyMawarReference: VerifyMawarReference };
  return verificationModule.verifyMawarReference;
}

function withRepository<T>(action: (repositoryRoot: string) => Promise<T> | T): Promise<T> {
  const repositoryRoot = mkdtempSync(join(tmpdir(), 'cloud-reference-aux-'));
  mkdirSync(join(repositoryRoot, 'tools/cloud-reference'), { recursive: true });
  writeFileSync(join(repositoryRoot, 'tools/cloud-reference/manifest.json'), JSON.stringify({ cases: [
    { id: CASE_ID, source: { provider: 'NASA', catalogUrl: SOURCE_URL,
      checksum: { value: createHash('sha256').update(IMAGE).digest('hex') } } },
  ] }));
  return Promise.resolve(action(repositoryRoot)).finally(() => rmSync(repositoryRoot, { recursive: true, force: true }));
}

function response({
  status = 200,
  contentType = 'image/png',
  body = IMAGE,
  contentLength = String(body.length),
  url = SOURCE_URL,
}: {
  status?: number;
  contentType?: string;
  body?: Buffer;
  contentLength?: string | null;
  url?: string;
} = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: new Headers({
      ...(contentType === '' ? {} : { 'content-type': contentType }),
      ...(contentLength === null ? {} : { 'content-length': contentLength }),
    }),
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  } as Response;
}

export function register(): void {
  test('cloud auxiliary acquisition: saves exact NASA PNG bytes and a SHA-256 source receipt', async () => {
    await withRepository(async (repositoryRoot) => {
      const acquire = await acquireMawarReference();
      let requestedUrl = '';
      const receipt = await acquire(repositoryRoot, async (input) => {
        requestedUrl = String(input);
        return response();
      });
      const caseDirectory = join(repositoryRoot, 'reference', CASE_ID);
      const image = readFileSync(join(caseDirectory, 'mawar.png'));
      const writtenReceipt = JSON.parse(readFileSync(join(caseDirectory, 'receipt.json'), 'utf8')) as typeof receipt;
      assert.equal(requestedUrl, SOURCE_URL);
      assert.deepEqual(image, IMAGE);
      assert.equal(receipt.sourceUrl, SOURCE_URL);
      assert.equal(receipt.sizeBytes, IMAGE.length);
      assert.equal(receipt.sha256, createHash('sha256').update(IMAGE).digest('hex'));
      assert.deepEqual(writtenReceipt, receipt);
      assert.equal(lstatSync(join(caseDirectory, 'mawar.png')).isFile(), true);
      const verify = await verifyMawarReference();
      assert.deepEqual(verify(repositoryRoot), {
        status: 'verified', sizeBytes: IMAGE.length, sha256: receipt.sha256,
      });
      writeFileSync(join(caseDirectory, 'mawar.png'), Buffer.from('corrupted'));
      assert.throws(() => verify(repositoryRoot), /receipt does not match/);
    });
  });

  test('cloud auxiliary acquisition: rejects HTTP errors, redirects, MIME mismatches, truncation, and non-PNG bytes', async () => {
    await withRepository(async (repositoryRoot) => {
      const acquire = await acquireMawarReference();
      const invalidResponses = [
        [response({ status: 503 }), /HTTP 503/],
        [response({ url: 'https://example.invalid/image.png' }), /unexpected URL/],
        [response({ contentType: 'text/html' }), /content type/],
        [response({ contentLength: String(IMAGE.length + 1) }), /Content-Length/],
        [response({ body: Buffer.from('not png'), contentLength: '7' }), /PNG signature/],
      ] as const;
      for (const [invalidResponse, expectedError] of invalidResponses) {
        await assert.rejects(acquire(repositoryRoot, async () => invalidResponse), expectedError);
      }
      assert.equal(lstatSync(join(repositoryRoot, 'reference', CASE_ID)).isDirectory(), true);
    });
  });

  test('cloud auxiliary acquisition: refuses symlinked paths and existing artifacts without overwriting them', async () => {
    await withRepository(async (repositoryRoot) => {
      const acquire = await acquireMawarReference();
      const referenceDirectory = join(repositoryRoot, 'reference');
      symlinkSync(tmpdir(), referenceDirectory, 'dir');
      await assert.rejects(acquire(repositoryRoot, async () => response()), /symbolic link/);
      rmSync(referenceDirectory);
      mkdirSync(referenceDirectory);
      const caseDirectory = join(referenceDirectory, CASE_ID);
      mkdirSync(caseDirectory);
      const imagePath = join(caseDirectory, 'mawar.png');
      writeFileSync(imagePath, 'keep');
      await assert.rejects(acquire(repositoryRoot, async () => response()), /already exists/);
      assert.equal(readFileSync(imagePath, 'utf8'), 'keep');
    });
  });
}
