#!/usr/bin/env node
// 検査済みの地表マニフェスト・索引・実体を、stagingを経由して一つの版付き配信先へ配備する。
import { copyFile, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { inspectEarthSurfaceBundle, assetPath } from './contract.mjs';

async function copyAsset(outputRoot, asset) {
  const destination = assetPath(outputRoot, asset.path);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(asset.absolutePath, destination);
}

async function copyTile(root, outputRoot, file) {
  await copyAsset(outputRoot, { absolutePath: assetPath(root, file.url), path: file.url });
}

// 入力全体を先に読み取り検査してから staging へコピーし、途中状態を配信先へ公開しない。
export async function packageEarthSurface({
  inputRoot, outputRoot, manifestName = 'earth-surface.json', sourceManifestPath,
} = {}) {
  const checked = await inspectEarthSurfaceBundle({ inputRoot, manifestName, sourceManifestPath });
  const output = resolve(outputRoot);
  const staging = `${output}.staging-${process.pid}-${Date.now()}`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  try {
    await copyAsset(staging, checked.baseColor);
    await copyAsset(staging, checked.baseTerrain);
    for (const climateMap of checked.climateMaps) await copyAsset(staging, climateMap);
    await mkdir(dirname(assetPath(staging, manifestName)), { recursive: true });
    await copyFile(checked.manifestPath, assetPath(staging, manifestName));
    await mkdir(dirname(assetPath(staging, checked.manifest.tileIndexUrl)), { recursive: true });
    await copyFile(checked.tileIndexPath, assetPath(staging, checked.manifest.tileIndexUrl));
    await writeFile(assetPath(staging, 'attribution.json'), `${JSON.stringify({
      datasetId: checked.manifest.datasetId, attribution: checked.manifest.attribution,
    }, null, 2)}\n`);
    for (const entry of checked.tileIndex.entries) {
      await copyTile(checked.root, staging, entry.color);
      await copyTile(checked.root, staging, entry.terrain);
    }
    await rm(output, { recursive: true, force: true });
    await mkdir(dirname(output), { recursive: true });
    await rename(staging, output);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  return checked.manifest;
}

async function main() {
  const args = new Map();
  for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
  const manifest = await packageEarthSurface({
    inputRoot: args.get('--input') ?? '.earth-surface/bundle',
    outputRoot: args.get('--output') ?? '.earth-surface/distribution',
    manifestName: args.get('--manifest') ?? 'earth-surface.json',
    sourceManifestPath: args.get('--source-manifest'),
  });
  console.log(`earth-surface:package: ${manifest.datasetId}`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main().catch((error) => { console.error(`earth-surface:package: ${error.message}`); process.exitCode = 1; });
}
