#!/usr/bin/env node
// 地表の配信ディレクトリを検査し、datasetId付きの索引と帰属情報を生成する。
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

const DATASET = /^[a-z0-9-]+$/;

function assetPath(root, value) {
  if (typeof value !== 'string' || value.length === 0 || value.startsWith('/') || value.split('/').includes('..')) {
    throw new Error(`invalid asset path: ${value}`);
  }
  const result = resolve(root, value);
  if (result !== resolve(root) && !result.startsWith(`${resolve(root)}${sep}`)) throw new Error(`asset escapes root: ${value}`);
  return result;
}

async function sha256(path) {
  const bytes = await readFile(path);
  return createHash('sha256').update(bytes).digest('hex');
}

async function requiredAsset(root, value) {
  const path = assetPath(root, value);
  const info = await stat(path);
  if (!info.isFile() || info.size === 0) throw new Error(`asset is empty or not a file: ${value}`);
  return { path: value, absolutePath: path, bytes: info.size, sha256: await sha256(path) };
}

function readAttribution(value) {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new Error('attribution must be a non-empty string array');
  }
  return value;
}

// バンドル索引を検査し、ファイルhashを含む公開用索引へ正規化する。
export async function packageEarthSurface({ inputRoot, outputRoot, manifestName = 'earth-surface.json' }) {
  const root = resolve(inputRoot);
  const manifestPath = assetPath(root, manifestName);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (!DATASET.test(manifest.datasetId ?? '')) throw new Error('invalid earth surface datasetId');
  if (manifest.schemaVersion !== 1) throw new Error('unsupported earth surface manifest schema');
  const climateMaps = manifest.climateMaps;
  if (!Array.isArray(climateMaps) || climateMaps.length !== 12) throw new Error('exactly 12 climate maps are required');
  const assets = [
    await requiredAsset(root, manifest.baseColor),
    await requiredAsset(root, manifest.baseTerrain),
    ...await Promise.all(climateMaps.map((path) => requiredAsset(root, path))),
  ];
  const attribution = readAttribution(manifest.attribution);
  const output = resolve(outputRoot);
  await mkdir(output, { recursive: true });
  // 索引だけでなく、検査済みの本文も同じ相対パスで配信ディレクトリへ写す。
  // これを省くと生成した索引が存在しても静的サーバーから実体を返せない。
  await Promise.all(assets.map(async (asset) => {
    const destination = assetPath(output, asset.path);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(asset.absolutePath, destination);
  }));
  const index = {
    schemaVersion: 1,
    datasetId: manifest.datasetId,
    baseColor: manifest.baseColor,
    baseTerrain: manifest.baseTerrain,
    climateMaps,
    assets: assets.map(({ absolutePath, ...asset }) => asset),
  };
  await writeFile(join(output, 'earth-surface.json'), `${JSON.stringify(index, null, 2)}\n`);
  await writeFile(join(output, 'attribution.json'), `${JSON.stringify({ datasetId: manifest.datasetId, attribution }, null, 2)}\n`);
  return index;
}

async function listFiles(root, directory = root) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(root, path));
    else files.push(relative(root, path).split(sep).join('/'));
  }
  return files;
}

async function main() {
  const args = new Map();
  for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
  const inputRoot = args.get('--input') ?? '.earth-surface/bundle';
  const outputRoot = args.get('--output') ?? '.earth-surface/distribution';
  const index = await packageEarthSurface({ inputRoot, outputRoot, manifestName: args.get('--manifest') ?? 'earth-surface.json' });
  const files = await listFiles(resolve(outputRoot));
  console.log(`earth-surface:package: ${index.datasetId} (${files.length} files)`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main().catch((error) => { console.error(`earth-surface:package: ${error.message}`); process.exitCode = 1; });
}
