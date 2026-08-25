#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { backboneContentHash } from './protein-content-hash.mjs';
import { extract, writeAsset } from './protein-extractor.mjs';

const configFile = process.argv[2];
if (!configFile) throw new Error('usage: generate-protein-backbone.mjs <protein.config.json> [--check]');
const checkOnly = process.argv.includes('--check');
const config = JSON.parse(await readFile(configFile, 'utf8'));

const asset = await extract('extract-backbone.py', configFile);
asset.contentHash = backboneContentHash(asset);
if (await writeAsset(config.source, asset, checkOnly)) {
  console.log(`${config.source}: ${asset.backboneCount} backbone residues (${checkOnly ? 'up to date' : 'written'})`);
}
