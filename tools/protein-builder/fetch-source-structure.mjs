#!/usr/bin/env node
// 寄託された原構造を取得し、リポジトリへ取り込む。取り込んだ内容が変わったときだけ書き換え、
// --check では書かずに差分の有無だけを終了コードで報告する。
import { readFile, writeFile } from 'node:fs/promises';

const configFile = process.argv[2];
const checkOnly = process.argv.includes('--check');
if (!configFile) throw new Error('usage: fetch-source-structure.mjs <protein.config.json> [--check]');
const config = JSON.parse(await readFile(configFile, 'utf8'));
if (!config.sourceStructureUrl) throw new Error(`${configFile}: missing sourceStructureUrl`);
if (!config.sourceStructureFile) throw new Error(`${configFile}: missing sourceStructureFile`);

const sourceUrl = config.sourceStructureUrl;
const response = await fetch(sourceUrl);
if (!response.ok) throw new Error(`could not download ${sourceUrl}: HTTP ${response.status}`);
const text = await response.text();
const isMmcif = sourceUrl.toLowerCase().endsWith('.cif');
if (isMmcif) {
  if (!text.startsWith('data_')) throw new Error(`invalid mmCIF response from ${sourceUrl}`);
} else if (!text.startsWith('HEADER')) {
  throw new Error(`invalid PDB response from ${sourceUrl}`);
}

let existing = null;
try {
  existing = await readFile(config.sourceStructureFile, 'utf8');
} catch {
  // 原本が未取得なのは初回取得として正常。
}

if (existing === text) {
  console.log(`up to date: ${config.sourceStructureFile}`);
} else if (checkOnly) {
  console.log(`out of date: ${config.sourceStructureFile}`);
  process.exitCode = 1;
} else {
  await writeFile(config.sourceStructureFile, text);
  console.log(`${existing === null ? 'fetched' : 'updated'} ${config.sourceStructureFile} from ${sourceUrl}`);
}
