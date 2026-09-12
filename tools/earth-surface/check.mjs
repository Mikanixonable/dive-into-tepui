#!/usr/bin/env node
// 地表配信物を読み取り専用で検査する。入力ディレクトリへ書き込まない。
import { resolve } from 'node:path';
import { inspectEarthSurfaceBundle } from './contract.mjs';

export async function checkEarthSurface({ inputRoot, manifestName = 'earth-surface.json', sourceManifestPath } = {}) {
  const checked = await inspectEarthSurfaceBundle({ inputRoot, manifestName, sourceManifestPath });
  return {
    datasetId: checked.manifest.datasetId,
    tiles: checked.tiles.length,
    climateMaps: checked.climateMaps.length,
  };
}

async function main() {
  const args = new Map();
  for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
  const result = await checkEarthSurface({
    inputRoot: args.get('--input') ?? '.earth-surface/bundle',
    manifestName: args.get('--manifest') ?? 'earth-surface.json',
    sourceManifestPath: args.get('--source-manifest'),
  });
  console.log(`earth-surface:check: ${result.datasetId} (${result.tiles} tiles, ${result.climateMaps} climate maps)`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main().catch((error) => { console.error(`earth-surface:check: ${error.message}`); process.exitCode = 1; });
}
