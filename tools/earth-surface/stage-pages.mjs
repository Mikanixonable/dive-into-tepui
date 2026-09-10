#!/usr/bin/env node
// GitHub Pages同居用のfixture/生成済みbundleをdocsへ版付きで配置する。
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile, rename } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { canonicalSha256, inspectEarthSurfaceBundle } from './contract.mjs';
import { fixtureClimatePng } from './fixture-climate.mjs';
import { packageEarthSurface } from './package.mjs';

const DEFAULT_DATASET = 'earth-pages-fixture';
const DEFAULT_MAX_BYTES = 128 * 1024 * 1024;

function terrainPayload(z, x, y) {
  const bytes = 260 * 260 * 4 * 2;
  const payload = Buffer.alloc(32 + bytes);
  payload.write('ESTN', 0, 'ascii'); payload.writeUInt16LE(1, 4); payload.writeUInt16LE(32, 6);
  payload.writeUInt16LE(260, 8); payload.writeUInt16LE(260, 10); payload.writeUInt8(z, 12);
  payload.writeUInt32LE(x, 14); payload.writeUInt32LE(y, 18); payload.writeUInt8(4, 22);
  payload.writeUInt8(1, 23); payload.writeUInt32LE(bytes, 24);
  return payload;
}

function baseTerrain() {
  const body = Buffer.concat([terrainPayload(0, 0, 0), terrainPayload(0, 1, 0)]);
  const payload = Buffer.alloc(32 + body.length);
  payload.write('ESTB', 0, 'ascii'); payload.writeUInt16LE(1, 4); payload.writeUInt16LE(32, 6);
  payload.writeUInt16LE(260, 8); payload.writeUInt16LE(260, 10); payload.writeUInt32LE(2, 14);
  payload.writeUInt32LE(1, 18); payload.writeUInt8(4, 22); payload.writeUInt8(1, 23);
  payload.writeUInt32LE(body.length, 24); body.copy(payload, 32);
  return payload;
}

function fixtureSource() {
  return { schemaVersion: 1, datasetId: DEFAULT_DATASET, sources: [{ id: 'fixture', inputSha256: [] }] };
}

function fixtureManifest(sourceManifestSha256) {
  return {
    schemaVersion: 1, datasetId: DEFAULT_DATASET, sourceManifestSha256,
    sourceManifest: 'sources.json', provenance: { generator: 'pages-fixture/1' },
    climateMap: { width: 1024, height: 512, channels: 4, scalar: 'UInt8' },
    controlRegions: Array.from({ length: 16 }, (_, index) => ({ id: `region-${index}`, west: -180, south: -80, east: 180, north: 80 })),
    coverage: { kind: 'sparse', maxZoom: 7 }, baseColor: 'base/earth.jpg',
    baseTerrain: 'base/earth.bin.gz', tileIndexUrl: 'tile-index.json',
    climateMaps: Array.from({ length: 12 }, (_, index) => `climate/${String(index + 1).padStart(2, '0')}.png`),
    climateEncoding: {
      temperatureK: { min: 180, max: 330 }, cloudFraction: { min: 0, max: 1 },
      orthometricElevation: { min: -1000, max: 9000 }, landFraction: { min: 0, max: 1 },
      waterOrthometricElevationM: 0,
    },
    attribution: ['deterministic Pages fixture'],
  };
}

async function createFixtureBundle(root) {
  const source = fixtureSource();
  const sourceHash = canonicalSha256(source);
  const manifest = fixtureManifest(sourceHash);
  const terrain = terrainPayload(0, 0, 0);
  const color = Buffer.from('fixture-jpeg');
  const entry = { key: '0/0/0', z: 0, x: 0, y: 0,
    color: { url: 'tiles/0/0/0.jpg', sha256: createHash('sha256').update(color).digest('hex'), encodedBytes: color.length, payloadBytes: color.length },
    terrain: { url: 'tiles/0/0/0.bin.gz', sha256: createHash('sha256').update(terrain).digest('hex'), encodedBytes: gzipSync(terrain, { mtime: 0 }).length, payloadBytes: terrain.length } };
  await mkdir(join(root, 'base'), { recursive: true });
  await mkdir(join(root, 'climate'), { recursive: true });
  await mkdir(join(root, 'tiles/0/0'), { recursive: true });
  await writeFile(join(root, 'sources.json'), `${JSON.stringify(source)}\n`);
  await writeFile(join(root, 'earth-surface.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(root, 'tile-index.json'), `${JSON.stringify({ schemaVersion: 1, datasetId: DEFAULT_DATASET, entries: [entry] }, null, 2)}\n`);
  await writeFile(join(root, 'base/earth.jpg'), color);
  await writeFile(join(root, 'base/earth.bin.gz'), gzipSync(baseTerrain(), { mtime: 0 }));
  await writeFile(join(root, 'tiles/0/0/0.jpg'), color);
  await writeFile(join(root, 'tiles/0/0/0.bin.gz'), gzipSync(terrain, { mtime: 0 }));
  for (const [index, path] of manifest.climateMaps.entries()) {
    await writeFile(join(root, path), fixtureClimatePng(index));
  }
  return manifest;
}

export function cacheControlForPages(path) {
  return path === 'earth-surface.json' || path === 'tile-index.json' || path === 'receipt.json'
    ? 'public, max-age=60, must-revalidate' : 'public, max-age=31536000, immutable';
}

export function pagesManifestUrl(repositorySubpath, datasetId) {
  if (typeof repositorySubpath !== 'string' || typeof datasetId !== 'string' || !/^[a-z0-9-]+$/.test(datasetId)) {
    throw new Error('repositorySubpath/datasetId is invalid');
  }
  const prefix = repositorySubpath.length === 0 ? './' : `${repositorySubpath.replace(/^\/+|\/+$/g, '')}/`;
  return `${prefix}earth-surface/${datasetId}/earth-surface.json`;
}

async function filesUnder(root) {
  const result = [];
  async function walk(directory) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, item.name);
      if (item.isDirectory()) await walk(path);
      else result.push(path);
    }
  }
  await walk(root); return result.sort();
}

async function receiptFor(root, manifest) {
  const files = (await filesUnder(root)).filter((path) => !path.endsWith('/receipt.json'));
  let totalBytes = 0; const hashes = [];
  for (const path of files) {
    const bytes = await readFile(path); totalBytes += bytes.length;
    hashes.push({ path: relative(root, path).replaceAll('\\', '/'), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  const treeSha256 = createHash('sha256').update(JSON.stringify(hashes)).digest('hex');
  return { schemaVersion: 1, datasetId: manifest.datasetId, pagesPath: `earth-surface/${manifest.datasetId}`,
    manifestSha256: hashes.find((item) => item.path === 'earth-surface.json').sha256,
    sourceManifestSha256: manifest.sourceManifestSha256, files: hashes.length, totalBytes, treeSha256,
    cachePolicy: { manifest: cacheControlForPages('earth-surface.json'), assets: cacheControlForPages('tiles/0/0/0.bin.gz') } };
}

export async function checkPagesLayout(root, datasetId) {
  const bundle = resolve(root, 'earth-surface', datasetId);
  const checked = await inspectEarthSurfaceBundle({ inputRoot: bundle });
  const receipt = JSON.parse(await readFile(join(bundle, 'receipt.json'), 'utf8'));
  const expected = await receiptFor(bundle, checked.manifest);
  if (JSON.stringify(receipt) !== JSON.stringify(expected)) throw new Error('Pages receipt does not match bundle');
  if ([checked.manifest.baseColor, checked.manifest.baseTerrain, checked.manifest.tileIndexUrl, ...checked.manifest.climateMaps]
    .some((path) => path.startsWith('/') || path.includes('..'))) throw new Error('Pages asset URL is not relative');
  return { datasetId, files: receipt.files, bytes: receipt.totalBytes, cache: cacheControlForPages('earth-surface.json') };
}

export async function stagePages({ inputRoot, outputRoot = 'docs', maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const stagingInput = inputRoot === undefined ? await mkdtemp(join(tmpdir(), 'earth-pages-fixture-')) : null;
  const input = resolve(inputRoot ?? stagingInput);
  if (stagingInput !== null) await createFixtureBundle(input);
  const packageRoot = await mkdtemp(join(tmpdir(), 'earth-pages-package-'));
  try {
    const manifest = await packageEarthSurface({ inputRoot: input, outputRoot: packageRoot });
    const source = resolve(packageRoot, 'earth', manifest.datasetId);
    const sourceManifest = manifest.sourceManifest ?? 'sources.json';
    await copyFile(resolve(input, sourceManifest), join(source, 'sources.json'));
    const target = resolve(outputRoot, 'earth-surface', manifest.datasetId);
    const receipt = await receiptFor(source, manifest);
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('EARTH_SURFACE_PAGES_MAX_BYTES must be positive');
    if (receipt.totalBytes > maxBytes) throw new Error(`Pages bundle exceeds byte budget: ${receipt.totalBytes} > ${maxBytes}`);
    await mkdir(dirname(target), { recursive: true });
    await rm(target, { recursive: true, force: true });
    await writeFile(join(source, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
    await rename(source, target);
    return { ...receipt, target };
  } finally {
    await rm(packageRoot, { recursive: true, force: true });
    if (stagingInput !== null) await rm(stagingInput, { recursive: true, force: true });
  }
}

async function main() {
  const args = new Map();
  for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
  const maxBytes = Number(args.get('--max-bytes') ?? process.env.EARTH_SURFACE_PAGES_MAX_BYTES ?? DEFAULT_MAX_BYTES);
  if (args.has('--check')) {
    const result = await checkPagesLayout(args.get('--root') ?? 'docs', args.get('--dataset-id') ?? DEFAULT_DATASET);
    console.log(`earth-surface:pages-check: ${result.datasetId} (${result.files} files, ${result.bytes} bytes)`);
    return;
  }
  const input = args.get('--input') || process.env.EARTH_SURFACE_PAGES_INPUT || undefined;
  const result = await stagePages({ inputRoot: input, outputRoot: args.get('--output') ?? 'docs', maxBytes });
  console.log(`earth-surface:pages-stage: ${result.datasetId} (${result.files} files, ${result.totalBytes} bytes)`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main().catch((error) => { console.error(`earth-surface:pages: ${error.message}`); process.exitCode = 1; });
}
