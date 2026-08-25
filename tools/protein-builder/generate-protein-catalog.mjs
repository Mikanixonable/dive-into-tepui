#!/usr/bin/env node
// Generate the static TypeScript import catalog consumed by the protein runtime.
import { access, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const builderDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(builderDirectory, '../..');
const proteinRoot = join(repositoryRoot, 'assets-src/proteins');
const outputFile = join(repositoryRoot, 'src/game/protein/protein-asset-catalog.generated.ts');
const checkOnly = process.argv.includes('--check');

function asPosixPath(value) {
  return value.split(sep).join('/');
}

function relativeImport(fromDirectory, target) {
  const path = asPosixPath(relative(fromDirectory, target));
  return path.startsWith('.') ? path : './' + path;
}

function pascalCase(value) {
  const result = value.split(/[^a-zA-Z0-9]+/u).filter(Boolean).map((part) => part[0].toUpperCase() + part.slice(1)).join('');
  return /^[0-9]/u.test(result) ? 'Asset' + result : result;
}

async function readConfigs() {
  const entries = await readdir(proteinRoot, { withFileTypes: true });
  const configs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const configPath = join(proteinRoot, entry.name, 'protein.config.json');
    try {
      await access(configPath);
    } catch {
      continue;
    }
    try {
      const config = JSON.parse(await readFile(configPath, 'utf8'));
      for (const key of ['assetId', 'pdbId', 'source', 'semanticAsset', 'structureAsset', 'motionAsset', 'definitionAsset']) {
        if (typeof config[key] !== 'string' || config[key].length === 0) throw new Error('missing ' + key);
      }
      for (const key of ['definitionAsset', 'source', 'semanticAsset', 'structureAsset', 'motionAsset']) {
        await access(join(repositoryRoot, config[key]));
      }
      configs.push({ config, configPath });
    } catch (error) {
      throw new Error(relative(repositoryRoot, configPath) + ': ' + error.message);
    }
  }
  configs.sort((left, right) => right.configPath.localeCompare(left.configPath));
  if (configs.length === 0) throw new Error('no protein.config.json files found below ' + relative(repositoryRoot, proteinRoot));
  const seenIds = new Set();
  for (const { config, configPath } of configs) {
    if (seenIds.has(config.assetId)) throw new Error(relative(repositoryRoot, configPath) + ': duplicate assetId ' + config.assetId);
    seenIds.add(config.assetId);
  }
  return configs;
}

function render(configs) {
  const generatedDirectory = join(repositoryRoot, 'src/game/protein');
  const entries = configs.map(({ config }) => {
    const variable = 'raw' + pascalCase(config.assetId);
    return {
      config,
      semanticVariable: variable + 'Semantic',
      backboneVariable: variable + 'Backbone',
      structureUrlVariable: variable + 'StructureUrl',
      motionUrlVariable: variable + 'MotionUrl',
      semanticImport: relativeImport(generatedDirectory, join(repositoryRoot, config.semanticAsset)),
      backboneImport: relativeImport(generatedDirectory, join(repositoryRoot, config.source)),
      structureImport: relativeImport(generatedDirectory, join(repositoryRoot, config.structureAsset)),
      motionImport: relativeImport(generatedDirectory, join(repositoryRoot, config.motionAsset)),
    };
  });
  // 構造・モーションは数十MBあるため webpack.config.js の asset/resource ルールでバンドルから
  // 切り離す。import 自体は他の資産と同じ `.json` 参照だが、そのルールにより解決値は
  // 実データではなく URL 文字列になる(tsc の resolveJsonModule 型とは食い違うため cast する)。
  // 実データは protein-asset-loader.ts が実行時に fetch する。semantic・backbone は小さいので
  // これまで通りバンドルへインライン化する。
  const imports = entries.flatMap((entry) => [
    "import " + entry.semanticVariable + " from '" + entry.semanticImport + "';",
    "import " + entry.backboneVariable + " from '" + entry.backboneImport + "';",
    "import " + entry.structureUrlVariable + " from '" + entry.structureImport + "';",
    "import " + entry.motionUrlVariable + " from '" + entry.motionImport + "';",
  ]);
  const sources = entries.map(({ config, semanticVariable, backboneVariable, structureUrlVariable, motionUrlVariable }) => [
    "  '" + config.assetId + "': {",
    '    semantic: ' + semanticVariable + ' as unknown as ProteinAssetDefinition,',
    '    backbone: ' + backboneVariable + ' as unknown as ProteinBackboneAsset,',
    '    structureUrl: ' + structureUrlVariable + ' as unknown as string,',
    '    motionUrl: ' + motionUrlVariable + ' as unknown as string,',
    "    expectedId: '" + config.assetId + "',",
    "    expectedPdbId: '" + config.pdbId + "',",
    '  },',
  ].join('\n'));
  return [
    '// Generated from assets-src/proteins/*/protein.config.json.',
    '// Run npm run protein:catalog after adding or renaming a protein asset.',
    ...imports,
    "import type { ProteinBackboneAsset } from '../../render/protein-enemy-ship';",
    "import type { ProteinAssetDefinition } from './protein-schema';",
    "import type { ProteinAssetSource } from './protein-asset-loader';",
    '',
    'export const PROTEIN_ASSET_SOURCES = {',
    ...sources,
    '} as const satisfies Readonly<Record<string, ProteinAssetSource>>;',
    '',
  ].join('\n');
}

try {
  const output = render(await readConfigs());
  if (checkOnly) {
    const existing = await readFile(outputFile, 'utf8');
    if (existing !== output) {
      console.error('protein catalog differs from ' + relative(repositoryRoot, outputFile));
      process.exitCode = 1;
    } else {
      console.log('protein catalog is up to date: ' + relative(repositoryRoot, outputFile));
    }
  } else {
    await writeFile(outputFile, output);
    console.log('generated ' + relative(repositoryRoot, outputFile));
  }
} catch (error) {
  console.error('protein catalog generation failed: ' + error.message);
  process.exitCode = 1;
}
