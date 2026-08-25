#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { structureContentHash } from './protein-content-hash.mjs';
import { extract, writeAsset } from './protein-extractor.mjs';

const configFile = process.argv[2];
if (!configFile) throw new Error('usage: generate-protein-structure.mjs <protein.config.json> [--check]');
const checkOnly = process.argv.includes('--check');
const config = JSON.parse(await readFile(configFile, 'utf8'));
const outputFile = process.argv.find((argument) => argument.startsWith('--output='))?.slice('--output='.length)
  ?? config.structureAsset;

const asset = await extract('extract-structure.py', configFile);
asset.generator.contentHash = structureContentHash(asset);
if (await writeAsset(outputFile, asset, checkOnly)) {
  console.log(`${outputFile}: ${asset.atoms.count} atoms, ${asset.bonds.count} bonds, ${asset.surface.mesh.index.length / 3} surface triangles (${checkOnly ? 'up to date' : 'written'})`);
}
