#!/usr/bin/env node
// GitHub Pages同居用のfixture/生成済みbundleをdocsへ版付きで配置する。
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile, rename } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  canonicalSha256, inspectEarthSurfaceBundle, EARTH_TILE_MAX_Z, EARTH_TILE_MIN_Z,
} from './contract.mjs';
import { fixtureClimatePng } from './fixture-climate.mjs';
import {
  baseTerrainPayload, fixtureManifest, fixtureSourceManifest, jpegFixture, terrainPayload,
} from './fixture-builders.mjs';
import { packageEarthSurface } from './package.mjs';

const DEFAULT_DATASET = 'earth-pages-fixture';
// GitHub documents the published-site limit as 1 GB; use decimal bytes so the
// release gate never publishes a bundle above the stated limit.
const DEFAULT_MAX_BYTES = 1_000_000_000;

async function createFixtureBundle(root) {
  const source = fixtureSourceManifest(DEFAULT_DATASET);
  const sourceHash = canonicalSha256(source);
  const manifest = fixtureManifest({
    sourceManifestSha256: sourceHash,
    datasetId: DEFAULT_DATASET,
    generator: 'pages-fixture/1',
    attribution: ['deterministic Pages fixture'],
  });
  const terrain = terrainPayload({ z: 5, x: 0, y: 0 });
  const color = jpegFixture({ width: 260, height: 260 });
  const baseColor = jpegFixture();
  await mkdir(join(root, 'base'), { recursive: true });
  await mkdir(join(root, 'climate'), { recursive: true });
  await mkdir(join(root, 'tiles/5/0'), { recursive: true });
  await writeFile(join(root, 'sources.json'), `${JSON.stringify(source)}\n`);
  await writeFile(join(root, 'earth-surface.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(root, 'base/earth.jpg'), baseColor);
  await writeFile(join(root, 'base/earth.bin.gz'), gzipSync(baseTerrainPayload(), { mtime: 0 }));
  await writeFile(join(root, 'tiles/5/0/0.jpg'), color);
  await writeFile(join(root, 'tiles/5/0/0.bin.gz'), gzipSync(terrain, { mtime: 0 }));
  for (const [index, path] of manifest.climateMaps.entries()) {
    await writeFile(join(root, path), fixtureClimatePng(index));
  }
  return manifest;
}

// manifest/receiptは短期再検証、hashを含む実体はimmutable。serve.mjsも同じ規則を使う。
export function cacheControlForPages(path) {
  return path.endsWith('earth-surface.json') || path.endsWith('receipt.json')
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

function validateMaxBytes(maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error('EARTH_SURFACE_PAGES_MAX_BYTES must be a positive integer');
  }
  return maxBytes;
}

function pagesFixture(manifest) {
  return manifest?.datasetId === DEFAULT_DATASET && manifest?.provenance?.generator === 'pages-fixture/1';
}

async function pagesShape(root) {
  const missingManifest = [];
  const manifestPath = resolve(root, 'earth-surface.json');
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') missingManifest.push('earth-surface.json');
    else throw error;
  }
  if (manifest === undefined) return { manifest: null, entries: [], maxLod: null, missingManifest };

  const sourceManifest = manifest.sourceManifest ?? 'sources.json';
  try { await readFile(resolve(root, sourceManifest)); } catch (error) {
    if (error.code === 'ENOENT') missingManifest.push(sourceManifest);
    else throw error;
  }

  let entries = [];
  try {
    const files = await filesUnder(resolve(root, 'tiles'));
    entries = files.filter((path) => path.endsWith('.jpg')).map((path) => ({
      z: Number(relative(root, path).split('/')[1]),
    }));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const lods = entries.map((entry) => entry?.z).filter((z) => Number.isSafeInteger(z));
  return { manifest, entries, maxLod: lods.length === 0 ? null : Math.max(...lods), missingManifest };
}

function pagesReport(shape, measuredBytes, maxBytes) {
  const missingManifest = [...new Set(shape.missingManifest)];
  return {
    maxLod: shape.maxLod,
    declaredMaxLod: shape.manifest?.coverage?.maxZoom ?? null,
    tileCount: shape.entries.length,
    missingManifest,
    capacity: {
      measuredBytes,
      maxBytes,
      withinBudget: measuredBytes <= maxBytes,
    },
  };
}

function rejectPartialProduction(shape, report, allowFixture) {
  if (report.missingManifest.length > 0) {
    throw new Error(`Pages package is missing manifest: ${report.missingManifest.join(', ')} (max LOD ${report.maxLod ?? 'none'}, ${report.tileCount} tiles)`);
  }
  if (allowFixture) return;
  const coverage = shape.manifest?.coverage;
  if (coverage?.kind !== 'complete') {
    throw new Error(`Pages package is partial production coverage: max LOD ${report.maxLod ?? 'none'}, ${report.tileCount} tiles, expected complete z${EARTH_TILE_MIN_Z}-z${coverage?.maxZoom ?? EARTH_TILE_MAX_Z} coverage`);
  }
  if (report.tileCount !== coverage.expectedTiles) {
    throw new Error(`Pages package is partial production coverage: max LOD ${report.maxLod ?? 'none'}, ${report.tileCount} tiles, expected ${coverage.expectedTiles}`);
  }
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
    cachePolicy: { manifest: cacheControlForPages('earth-surface.json'), assets: cacheControlForPages('tiles/4/0/0.bin.gz') } };
}

export async function checkPagesLayout(root, datasetId, options = {}) {
  const maxBytes = validateMaxBytes(typeof options === 'number' ? options : options?.maxBytes ?? DEFAULT_MAX_BYTES);
  const bundle = resolve(root, 'earth-surface', datasetId);
  const shape = await pagesShape(bundle);
  const shapeReport = pagesReport(shape, 0, maxBytes);
  rejectPartialProduction(shape, shapeReport, pagesFixture(shape.manifest));
  const checked = await inspectEarthSurfaceBundle({ inputRoot: bundle });
  const receipt = JSON.parse(await readFile(join(bundle, 'receipt.json'), 'utf8'));
  const expected = await receiptFor(bundle, checked.manifest);
  if (JSON.stringify(receipt) !== JSON.stringify(expected)) throw new Error('Pages receipt does not match bundle');
  if ([checked.manifest.baseColor, checked.manifest.baseTerrain,
    checked.manifest.tileTemplates.color, checked.manifest.tileTemplates.terrain,
    ...checked.manifest.climateMaps]
    .some((path) => path.startsWith('/') || path.includes('..'))) throw new Error('Pages asset URL is not relative');
  const report = pagesReport({
    manifest: checked.manifest,
    entries: checked.tiles,
    maxLod: checked.tiles.length === 0 ? null : Math.max(...checked.tiles.map((entry) => entry.z)),
    missingManifest: [],
  }, receipt.totalBytes + (await readFile(join(bundle, 'receipt.json'))).byteLength, maxBytes);
  if (!report.capacity.withinBudget) {
    throw new Error(`Pages bundle exceeds byte budget: ${report.capacity.measuredBytes} > ${report.capacity.maxBytes} (max LOD ${report.maxLod ?? 'none'}, ${report.tileCount} tiles)`);
  }
  return {
    datasetId, files: receipt.files, bytes: receipt.totalBytes, cache: cacheControlForPages('earth-surface.json'), ...report,
  };
}

export async function stagePages({ inputRoot, outputRoot = 'docs', maxBytes = DEFAULT_MAX_BYTES } = {}) {
  validateMaxBytes(maxBytes);
  const stagingInput = inputRoot === undefined ? await mkdtemp(join(tmpdir(), 'earth-pages-fixture-')) : null;
  const input = resolve(inputRoot ?? stagingInput);
  if (stagingInput !== null) await createFixtureBundle(input);
  const packageRoot = await mkdtemp(join(tmpdir(), 'earth-pages-package-'));
  try {
    const shape = await pagesShape(input);
    const shapeReport = pagesReport(shape, 0, maxBytes);
    rejectPartialProduction(shape, shapeReport, stagingInput !== null);
    const manifest = await packageEarthSurface({ inputRoot: input, outputRoot: packageRoot });
    const source = resolve(packageRoot, 'earth', manifest.datasetId);
    const sourceManifest = manifest.sourceManifest ?? 'sources.json';
    await copyFile(resolve(input, sourceManifest), join(source, 'sources.json'));
    const target = resolve(outputRoot, 'earth-surface', manifest.datasetId);
    const receipt = await receiptFor(source, manifest);
    const receiptText = `${JSON.stringify(receipt, null, 2)}\n`;
    const report = pagesReport(shape, receipt.totalBytes + Buffer.byteLength(receiptText), maxBytes);
    if (!report.capacity.withinBudget) {
      throw new Error(`Pages bundle exceeds byte budget: ${report.capacity.measuredBytes} > ${report.capacity.maxBytes} (max LOD ${report.maxLod ?? 'none'}, ${report.tileCount} tiles)`);
    }
    await mkdir(dirname(target), { recursive: true });
    await rm(target, { recursive: true, force: true });
    await writeFile(join(source, 'receipt.json'), receiptText);
    await rename(source, target);
    return { ...receipt, target, ...report };
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
    const result = await checkPagesLayout(args.get('--root') ?? 'docs', args.get('--dataset-id') ?? DEFAULT_DATASET, { maxBytes });
    const missing = result.missingManifest.length === 0 ? 'none' : result.missingManifest.join(',');
    console.log(`earth-surface:pages-check: ${result.datasetId} (${result.files} files, ${result.bytes}/${result.capacity.maxBytes} bytes; max LOD ${result.maxLod ?? 'none'}, ${result.tileCount} tiles, missing manifest ${missing})`);
    return;
  }
  const input = args.get('--input') || process.env.EARTH_SURFACE_PAGES_INPUT || undefined;
  const result = await stagePages({ inputRoot: input, outputRoot: args.get('--output') ?? 'docs', maxBytes });
  const missing = result.missingManifest.length === 0 ? 'none' : result.missingManifest.join(',');
  console.log(`earth-surface:pages-stage: ${result.datasetId} (${result.files} files, ${result.totalBytes}/${result.capacity.maxBytes} bytes; max LOD ${result.maxLod ?? 'none'}, ${result.tileCount} tiles, missing manifest ${missing})`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main().catch((error) => { console.error(`earth-surface:pages: ${error.message}`); process.exitCode = 1; });
}
