#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';

const configFile = process.argv[2];
if (!configFile) throw new Error('usage: fetch-pdb-backbone.mjs <protein.config.json>');
const config = JSON.parse(await readFile(configFile, 'utf8'));
const sourceUrl = config.sourceStructureUrl ?? `https://files.rcsb.org/download/${config.pdbId}.pdb`;
const response = await fetch(sourceUrl);
if (!response.ok) throw new Error(`could not download ${sourceUrl}: HTTP ${response.status}`);
const text = await response.text();
if (!text.startsWith('HEADER')) throw new Error(`invalid PDB response from ${sourceUrl}`);

const atoms = [];
const backboneAtomCoordinates = new Map();
const helices = [];
const sheets = [];
const entityByChain = new Map();
let currentEntity = 0;
for (const line of text.split(/\r?\n/)) {
  if (line.startsWith('COMPND')) {
    const molId = line.match(/MOL_ID:\s*(\d+)/);
    if (molId) currentEntity = Number(molId[1]);
    const chains = line.match(/CHAIN:\s*([^;]+)/);
    if (chains) for (const chain of chains[1].split(',')) entityByChain.set(chain.trim(), currentEntity);
  }
  if (line.startsWith('HELIX')) helices.push({
    chain: line.slice(19, 20).trim(), start: Number(line.slice(21, 25)),
    endChain: line.slice(31, 32).trim(), end: Number(line.slice(33, 37)),
  });
  if (line.startsWith('SHEET')) sheets.push({
    chain: line.slice(21, 22).trim(), start: Number(line.slice(22, 26)),
    endChain: line.slice(32, 33).trim(), end: Number(line.slice(33, 37)),
  });
  if (!line.startsWith('ATOM') && !line.startsWith('HETATM')) continue;
  if (['HOH', 'WAT', 'DOD'].includes(line.slice(17, 20).trim())) continue;
  const altLoc = line[16] ?? ' ';
  if (altLoc !== ' ' && altLoc !== 'A' && altLoc !== '1') continue;
  const x = Number(line.slice(30, 38));
  const y = Number(line.slice(38, 46));
  const z = Number(line.slice(46, 54));
  if (![x, y, z].every(Number.isFinite)) continue;
  atoms.push({ x, y, z });
  if (!line.startsWith('ATOM')) continue;
  const atomName = line.slice(12, 16).trim();
  if (atomName !== 'CA' && atomName !== 'O') continue;
  const chain = line.slice(21, 22).trim();
  const residue = Number(line.slice(22, 26));
  const key = `${chain}:${residue}`;
  const record = backboneAtomCoordinates.get(key) ?? {};
  record[atomName] = { x, y, z };
  backboneAtomCoordinates.set(key, record);
}
if (atoms.length === 0) throw new Error('no atoms found');

const backbone = [];
const seenResidues = new Set();
for (const line of text.split(/\r?\n/)) {
  if (!line.startsWith('ATOM') || line.slice(12, 16).trim() !== 'CA') continue;
  const altLoc = line[16] ?? ' ';
  if (altLoc !== ' ' && altLoc !== 'A' && altLoc !== '1') continue;
  const chain = line.slice(21, 22).trim();
  const residue = Number(line.slice(22, 26));
  const residueKey = `${chain}:${residue}`;
  if (seenResidues.has(residueKey)) continue;
  seenResidues.add(residueKey);
  const x = Number(line.slice(30, 38));
  const y = Number(line.slice(38, 46));
  const z = Number(line.slice(46, 54));
  if (![x, y, z].every(Number.isFinite)) continue;
  backbone.push({
    chain, entity: entityByChain.get(chain) ?? 0, bFactor: Number(line.slice(60, 66)), residue, x, y, z,
    o: backboneAtomCoordinates.get(residueKey)?.O ?? null,
  });
}

const center = atoms.reduce((sum, atom) => ({
  x: sum.x + atom.x, y: sum.y + atom.y, z: sum.z + atom.z,
}), { x: 0, y: 0, z: 0 });
center.x /= atoms.length;
center.y /= atoms.length;
center.z /= atoms.length;
const rounded = (value) => Number(value.toFixed(3));
const backboneCoordinates = [];
const backboneSecondary = [];
const backboneChains = [];
const backboneEntities = [];
const backboneBFactors = [];
const backboneOCoordinates = [];
for (const atom of backbone) {
  backboneCoordinates.push(rounded(atom.x - center.x), rounded(atom.y - center.y), rounded(atom.z - center.z));
  const oxygen = atom.o ?? atom;
  backboneOCoordinates.push(rounded(oxygen.x - center.x), rounded(oxygen.y - center.y), rounded(oxygen.z - center.z));
  backboneChains.push(atom.chain);
  backboneEntities.push(atom.entity);
  backboneBFactors.push(Number(atom.bFactor.toFixed(2)));
  const inRange = (entry) => entry.chain === atom.chain && entry.endChain === atom.chain
    && atom.residue >= entry.start && atom.residue <= entry.end;
  backboneSecondary.push(helices.some(inRange) ? 'helix' : sheets.some(inRange) ? 'sheet' : 'coil');
}

await writeFile(config.source, `${JSON.stringify({
  pdbId: config.pdbId,
  source: sourceUrl,
  model: 'C-alpha backbone coordinates with deposited HELIX/SHEET annotations, centered at the all-atom centroid',
  atomCount: atoms.length,
  backboneCount: backbone.length,
  backboneCoordinates,
  backboneSecondary,
  backboneChains,
  backboneEntities,
  backboneBFactors,
  backboneOCoordinates,
}, null, 2)}\n`);
console.log(`generated ${config.source}: ${backbone.length} backbone points from PDB ${config.pdbId}`);
