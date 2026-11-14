#!/usr/bin/env node
// Stage A の配信契約を、小さく固定した決定的な実体で検査する。
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { packageEarthSurface } from './package.mjs';
import { checkEarthSurface } from './check.mjs';
import {
  canonicalSha256,
  checkBaseTerrainGzip,
  checkTerrainTileGzip,
  validateManifest,
} from './contract.mjs';
import { fixtureClimatePng } from './fixture-climate.mjs';
import {
  baseTerrainPayload, fixtureManifest, fixtureSourceManifest, jpegFixture, terrainPayload,
} from './fixture-builders.mjs';

const execFileAsync = promisify(execFile);

async function createBundle() {
  const root = await mkdtemp(join(tmpdir(), 'earth-surface-contract-'));
  const source = fixtureSourceManifest('earth-fixture-a');
  const sourceHash = canonicalSha256(source);
  const color = jpegFixture({ width: 260, height: 260 });
  const baseColor = jpegFixture();
  const terrain = terrainPayload({ z: 5 });
  const compressedTerrain = gzipSync(terrain, { mtime: 0 });
  const manifestValue = fixtureManifest({
    sourceManifestSha256: sourceHash,
    datasetId: 'earth-fixture-a',
    generator: 'fixture/1',
    attribution: ['deterministic Stage A fixture'],
  });
  await writeFile(join(root, 'sources.json'), `${JSON.stringify(source)}\n`);
  await writeFile(join(root, 'earth-surface.json'), `${JSON.stringify(manifestValue, null, 2)}\n`);
  await mkdir(join(root, 'base'), { recursive: true });
  await writeFile(join(root, 'base/earth.jpg'), baseColor); await writeFile(join(root, 'base/earth.bin.gz'), gzipSync(baseTerrainPayload(), { mtime: 0 }));
  await mkdir(join(root, 'climate'), { recursive: true });
  for (const [index, path] of manifestValue.climateMaps.entries()) {
    await writeFile(join(root, path), fixtureClimatePng(index));
  }
  await mkdir(join(root, 'tiles/5/0'), { recursive: true });
  await writeFile(join(root, 'tiles/5/0/0.jpg'), color);
  await writeFile(join(root, 'tiles/5/0/0.bin.gz'), compressedTerrain);
  return { root, source, manifest: manifestValue, color, baseColor, terrain };
}

async function expectFailure(action, pattern) {
  await assert.rejects(action, (error) => error instanceof Error && pattern.test(error.message));
}

async function run() {
  const fixture = await createBundle();
  const output = await mkdtemp(join(tmpdir(), 'earth-surface-distribution-'));
  const before = await readFile(join(fixture.root, 'earth-surface.json'));
  try {
    assert.throws(() => validateManifest({ ...fixture.manifest, schemaVersion: 2 }), /unsupported earth surface manifest schema/);
    assert.throws(() => validateManifest({ ...fixture.manifest, colorCalibration: null }), /colorCalibration must be an object/);

    await packageEarthSurface({ inputRoot: fixture.root, outputRoot: output, sourceManifestPath: 'sources.json' });
    const packaged = join(output, 'earth', fixture.manifest.datasetId);
    const result = await checkEarthSurface({ inputRoot: packaged });
    assert.deepEqual(result, { datasetId: fixture.manifest.datasetId, tiles: 1, climateMaps: 12 });
    const cli = await execFileAsync('npm', ['run', 'earth-surface:check', '--', '--input', packaged], { cwd: process.cwd() });
    assert.match(cli.stdout, /earth-surface:check: earth-fixture-a/);
    for (const path of [
      'earth-surface.json', 'attribution.json', fixture.manifest.baseColor, fixture.manifest.baseTerrain,
      'sources.json',
      ...fixture.manifest.climateMaps, 'tiles/5/0/0.jpg', 'tiles/5/0/0.bin.gz',
      'receipt.json',
    ]) await readFile(join(packaged, path));
    assert.deepEqual(await readFile(join(fixture.root, 'earth-surface.json')), before);

    const baseColorPath = join(packaged, fixture.manifest.baseColor);
    for (const [replacement, pattern] of [
      [jpegFixture({ width: 260, height: 260 }), /baseColor JPEG must be 8192x4096 with 3 components/],
      [jpegFixture({ components: 1 }), /baseColor JPEG must be 8192x4096 with 3 components/],
      [Buffer.from('not-a-jpeg'), /baseColor JPEG must start with SOI/],
      [jpegFixture().subarray(0, -2), /baseColor JPEG scan is truncated/],
      [(() => { const malformed = jpegFixture(); malformed[4] = 0; malformed[5] = 1; return malformed; })(), /baseColor JPEG marker length is invalid/],
    ]) {
      await writeFile(baseColorPath, replacement);
      await expectFailure(() => checkEarthSurface({ inputRoot: packaged }), pattern);
    }
    await writeFile(baseColorPath, fixture.baseColor);

    const changedColor = await readFile(join(packaged, 'tiles/5/0/0.jpg'));
    changedColor[0] ^= 1; await writeFile(join(packaged, 'tiles/5/0/0.jpg'), changedColor);
    await expectFailure(() => checkEarthSurface({ inputRoot: packaged }), /baseColor JPEG/);
    await writeFile(join(packaged, 'tiles/5/0/0.jpg'), fixture.color);

    const sourcePath = join(fixture.root, 'sources.json');
    const sourceChanged = { ...fixture.source, datasetId: 'earth-other' };
    await writeFile(sourcePath, JSON.stringify(sourceChanged));
    await expectFailure(() => packageEarthSurface({ inputRoot: fixture.root, outputRoot: output }), /sourceManifestSha256 mismatch/);
    await writeFile(sourcePath, `${JSON.stringify(fixture.source)}\n`);

    const terrainPath = join(fixture.root, 'tiles/5/0/0.bin.gz');
    const mismatch = terrainPayload({ x: 1 });
    const mismatchCompressed = gzipSync(mismatch, { mtime: 0 });
    await writeFile(terrainPath, mismatchCompressed);
    await expectFailure(() => packageEarthSurface({ inputRoot: fixture.root, outputRoot: output, sourceManifestPath: 'sources.json' }), /ESTN header key or format mismatch/);
    await writeFile(terrainPath, gzipSync(fixture.terrain, { mtime: 0 }));

    const oldFormat = Buffer.from(fixture.terrain);
    oldFormat.writeUInt16LE(2, 4);
    await writeFile(terrainPath, gzipSync(oldFormat, { mtime: 0 }));
    await expectFailure(() => checkEarthSurface({ inputRoot: fixture.root }), /ESTN header key or format mismatch/);

    // Bへroughness・Aへ255を書いた本文は、法線が単位長へ戻らないので弾かれる。
    const swapped = Buffer.from(fixture.terrain);
    for (let texel = 32; texel < swapped.length; texel += 4) {
      swapped[texel + 2] = 204; swapped[texel + 3] = 255;
    }
    await writeFile(terrainPath, gzipSync(swapped, { mtime: 0 }));
    await expectFailure(() => checkEarthSurface({ inputRoot: fixture.root }), /ESTN normal is not unit length|ESTN roughness channel has no data/);

    const opaqueAlpha = Buffer.from(fixture.terrain);
    for (let texel = 32; texel < opaqueAlpha.length; texel += 4) opaqueAlpha[texel + 3] = 255;
    await writeFile(terrainPath, gzipSync(opaqueAlpha, { mtime: 0 }));
    await expectFailure(() => checkEarthSurface({ inputRoot: fixture.root }), /ESTN roughness channel has no data/);
    await writeFile(terrainPath, gzipSync(fixture.terrain, { mtime: 0 }));

    // base 地形も同じ旧配置を弾く。本番 R2 の障害はこの経路(base)で起きていた。
    const basePath = join(fixture.root, fixture.manifest.baseTerrain);
    const originalBase = await readFile(basePath);
    const swappedBaseTile = (x) => {
      const tile = terrainPayload({ x });
      for (let texel = 32; texel < tile.length; texel += 4) { tile[texel + 2] = 204; tile[texel + 3] = 255; }
      return tile;
    };
    const swappedBase = Buffer.concat([baseTerrainPayload().subarray(0, 32), swappedBaseTile(0), swappedBaseTile(1)]);
    await writeFile(basePath, gzipSync(swappedBase, { mtime: 0 }));
    await expectFailure(() => checkEarthSurface({ inputRoot: fixture.root }), /ESTN normal is not unit length|ESTN roughness channel has no data/);
    await writeFile(basePath, originalBase);

    // 配信側の実体を直接検査する入口(release 検査が使う)も、同じ判定をする。
    checkBaseTerrainGzip(gzipSync(baseTerrainPayload(), { mtime: 0 }));
    checkTerrainTileGzip(gzipSync(fixture.terrain, { mtime: 0 }), { id: '5/0/0', z: 5, x: 0, y: 0 });
    assert.throws(() => checkBaseTerrainGzip(gzipSync(swappedBase, { mtime: 0 })), /ESTN normal is not unit length|ESTN roughness channel has no data/);
    assert.throws(() => checkTerrainTileGzip(gzipSync(swapped, { mtime: 0 }), { id: '5/0/0', z: 5, x: 0, y: 0 }), /ESTN normal is not unit length|ESTN roughness channel has no data/);
    assert.throws(() => checkBaseTerrainGzip(Buffer.from('not-gzip')), /baseTerrain gzip is invalid/);
    console.log('earth-surface contract fixtures: ok');
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
    await rm(output, { recursive: true, force: true });
  }
}

if (process.argv[1] && new URL(`file://${process.argv[1]}`).href === import.meta.url) {
  run().catch((error) => { console.error(error); process.exitCode = 1; });
}
