#!/usr/bin/env node
// Blender/Molecular Nodes is an optional authoring backend. The fallback backend keeps the
// existing reproducible backbone and copies the semantic configuration into the runtime asset.
import { readFile, writeFile } from 'node:fs/promises';

const configFile = process.argv[2] ?? 'assets-src/proteins/5i4r/protein.config.json';
const config = JSON.parse(await readFile(configFile, 'utf8'));
const semantic = JSON.parse(await readFile(config.semanticAsset, 'utf8'));
const backbone = JSON.parse(await readFile(config.source, 'utf8'));
const output = {
  ...semantic,
  source: { ...semantic.source, structureFile: config.source },
  generated: {
    backend: 'existing-backbone',
    backboneCount: backbone.backboneCount,
    secondaryKinds: [...new Set(backbone.backboneSecondary)],
    chains: [...new Set(backbone.backboneChains)],
    entities: [...new Set(backbone.backboneEntities)],
  },
};
const outputFile = process.argv[3] ?? config.semanticAsset;
await writeFile(outputFile, `${JSON.stringify(output, null, 2)}\n`);
console.log(`generated ${outputFile} from ${config.source}`);
