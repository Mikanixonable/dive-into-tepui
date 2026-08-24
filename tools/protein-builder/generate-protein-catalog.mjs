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
  return path.startsWith('.') ? path : `./${path}`;
}

function pascalCase(value) {
  const result = value.split(/[^a-zA-Z0-9]+/u).filter(Boolean).map((part) => part[0].toUpperCase() + part.slice(1)).join('');
  return /^[0-9]/u.test(result) ? `Asset${result}` : result;
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
      for (const key of ['assetId', 'pdbId', 'source', 'semanticAsset', 'structureAsset', 'definitionAsset']) {
        if (typeof config[key] !== 'string' || config[key].length === 0) throw new Error(`missing ${key}`);
      }
      for (const key of ['definitionAsset', 'source', 'semanticAsset', 'structureAsset']) {
        await access(join(repositoryRoot, config[key]));
      }
      configs.push({ config, configPath });
    } catch (error) {
      throw new Error(`${relative(repositoryRoot, configPath)}: ${error.message}`);
    }
  }
  // Descending path order preserves the existing catalog order while remaining deterministic
  // for future additions (and avoids depending on filesystem directory ordering).
  configs.sort((left, right) => right.configPath.localeCompare(left.configPath));
  if (configs.length === 0) throw new Error(`no protein.config.json files found below ${relative(repositoryRoot, proteinRoot)}`);
  const seenIds = new Set();
  for (const { config, configPath } of configs) {
    if (seenIds.has(config.assetId)) throw new Error(`${relative(repositoryRoot, configPath)}: duplicate assetId ${config.assetId}`);
    seenIds.add(config.assetId);
  }
  return configs;
}

function render(configs) {
  const generatedDirectory = join(repositoryRoot, 'src/game/protein');
  const entries = configs.map(({ config }) => {
    const variable = `raw${pascalCase(config.assetId)}`;
    return {
      config,
      variable,
      semanticVariable: `${variable}Semantic`,
      backboneVariable: `${variable}Backbone`,
      structureVariable: `${variable}Structure`,
      semanticImport: relativeImport(generatedDirectory, join(repositoryRoot, config.semanticAsset)),
      backboneImport: relativeImport(generatedDirectory, join(repositoryRoot, config.source)),
      structureImport: relativeImport(generatedDirectory, join(repositoryRoot, config.structureAsset)),
    };
  });
  const imports = entries.flatMap((entry) => [
    `import ${entry.semanticVariable} from '${entry.semanticImport}';`,
    `import ${entry.backboneVariable} from '${entry.backboneImport}';`,
    `import ${entry.structureVariable} from '${entry.structureImport}';`,
  ]);
  const bundles = entries.map((entry) => {
    const { config } = entry;
    return [
      `  '${config.assetId}': bundle(`,
      `    ${entry.semanticVariable}, ${entry.backboneVariable}, ${entry.structureVariable}, '${config.assetId}', '${config.pdbId}',`,
      '  ),',
    ].join('\n');
  });
  return `// Generated from assets-src/proteins/*/protein.config.json.\n// Run \`npm run protein:catalog\` after adding or renaming a protein asset.\n${imports.join('\n')}\nimport type { ProteinBackboneAsset } from '../../render/protein-enemy-ship';\nimport { assertProteinDisplayAsset, type ProteinDisplayAsset } from './protein-display-asset';\nimport { validateProteinAsset, type ProteinAssetDefinition } from './protein-schema';\n\nexport interface ProteinAssetBundle {\n  readonly semantic: ProteinAssetDefinition;\n  readonly backbone: ProteinBackboneAsset;\n  readonly structure: ProteinDisplayAsset;\n}\n\nfunction bundle(\n  semanticValue: unknown,\n  backboneValue: unknown,\n  structureValue: unknown,\n  expectedId: string,\n  expectedPdbId: string,\n): ProteinAssetBundle {\n  const semantic = semanticValue as ProteinAssetDefinition;\n  const issues = validateProteinAsset(semantic);\n  if (semantic.id !== expectedId) issues.unshift(\`id must be \${expectedId}\`);\n  if (issues.length > 0) throw new Error(\`Invalid protein asset \${expectedId}: \${issues.join('; ')}\`);\n  const structure = structureValue as ProteinDisplayAsset;\n  assertProteinDisplayAsset(structure, expectedPdbId);\n  return { semantic, backbone: backboneValue as ProteinBackboneAsset, structure };\n}\n\nexport const PROTEIN_ASSET_BUNDLES = {\n${bundles.join('\n')}\n} as const satisfies Readonly<Record<string, ProteinAssetBundle>>;\n`;
}

try {
  const output = render(await readConfigs());
  if (checkOnly) {
    const existing = await readFile(outputFile, 'utf8');
    if (existing !== output) {
      console.error(`protein catalog differs from ${relative(repositoryRoot, outputFile)}`);
      process.exitCode = 1;
    } else {
      console.log(`protein catalog is up to date: ${relative(repositoryRoot, outputFile)}`);
    }
  } else {
    await writeFile(outputFile, output);
    console.log(`generated ${relative(repositoryRoot, outputFile)}`);
  }
} catch (error) {
  console.error(`protein catalog generation failed: ${error.message}`);
  process.exitCode = 1;
}
