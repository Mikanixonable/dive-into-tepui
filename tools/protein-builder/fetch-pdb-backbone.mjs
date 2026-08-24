#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { backboneContentHash } from './protein-content-hash.mjs';
import { parseMmcifLoop } from './mmcif-format.mjs';

const configFile = process.argv[2];
if (!configFile) throw new Error('usage: fetch-pdb-backbone.mjs <protein.config.json>');
const config = JSON.parse(await readFile(configFile, 'utf8'));
const sourceUrl = config.sourceStructureUrl ?? `https://files.rcsb.org/download/${config.pdbId}.pdb`;
const response = await fetch(sourceUrl);
if (!response.ok) throw new Error(`could not download ${sourceUrl}: HTTP ${response.status}`);
const text = await response.text();
const isMmcif = sourceUrl.toLowerCase().endsWith('.cif');
if (isMmcif) {
  if (!text.startsWith('data_')) throw new Error(`invalid mmCIF response from ${sourceUrl}`);
} else if (!text.startsWith('HEADER')) {
  throw new Error(`invalid PDB response from ${sourceUrl}`);
}

const atoms = [];
const backboneAtomCoordinates = new Map();
const helices = [];
const sheets = [];
const entityByChain = new Map();

if (isMmcif) {
  // label_asym_id/label_entity_id を chain/entity の基準にする(単一分子ごとに1文字を
  // 割り当てる legacy PDB の CHAIN ID に相当するのは auth_asym_id ではなく label_asym_id)。
  for (const row of parseMmcifLoop(text, '_struct_conf.')) {
    if (row.conf_type_id !== 'HELX_P') continue;
    helices.push({ chain: row.beg_label_asym_id, start: Number(row.beg_label_seq_id), endChain: row.end_label_asym_id, end: Number(row.end_label_seq_id) });
  }
  for (const row of parseMmcifLoop(text, '_struct_sheet_range.')) {
    sheets.push({ chain: row.beg_label_asym_id, start: Number(row.beg_label_seq_id), endChain: row.end_label_asym_id, end: Number(row.end_label_seq_id) });
  }
  for (const row of parseMmcifLoop(text, '_atom_site.')) {
    if (row.pdbx_PDB_model_num !== '1') continue;
    if (['HOH', 'WAT', 'DOD'].includes(row.label_comp_id)) continue;
    if (row.label_alt_id !== '.' && row.label_alt_id !== 'A' && row.label_alt_id !== '1') continue;
    const x = Number(row.Cartn_x);
    const y = Number(row.Cartn_y);
    const z = Number(row.Cartn_z);
    if (![x, y, z].every(Number.isFinite)) continue;
    atoms.push({ x, y, z });
    entityByChain.set(row.label_asym_id, Number(row.label_entity_id));
    if (row.group_PDB !== 'ATOM') continue;
    if (row.label_atom_id !== 'CA' && row.label_atom_id !== 'O') continue;
    const chain = row.label_asym_id;
    const residue = Number(row.label_seq_id);
    const key = `${chain}:${residue}`;
    const record = backboneAtomCoordinates.get(key) ?? {};
    record[row.label_atom_id] = { x, y, z };
    backboneAtomCoordinates.set(key, record);
  }
} else {
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
}
if (atoms.length === 0) throw new Error('no atoms found');

const backbone = [];
const seenResidues = new Set();
if (isMmcif) {
  for (const row of parseMmcifLoop(text, '_atom_site.')) {
    if (row.pdbx_PDB_model_num !== '1' || row.group_PDB !== 'ATOM' || row.label_atom_id !== 'CA') continue;
    if (row.label_alt_id !== '.' && row.label_alt_id !== 'A' && row.label_alt_id !== '1') continue;
    const chain = row.label_asym_id;
    const residue = Number(row.label_seq_id);
    const residueKey = `${chain}:${residue}`;
    if (seenResidues.has(residueKey)) continue;
    seenResidues.add(residueKey);
    const x = Number(row.Cartn_x);
    const y = Number(row.Cartn_y);
    const z = Number(row.Cartn_z);
    if (![x, y, z].every(Number.isFinite)) continue;
    backbone.push({
      chain, entity: entityByChain.get(chain) ?? 0, bFactor: Number(row.B_iso_or_equiv), residue, x, y, z,
      o: backboneAtomCoordinates.get(residueKey)?.O ?? null,
    });
  }
} else {
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
const backboneResidueNumbers = [];
const backboneEntities = [];
const backboneBFactors = [];
const backboneOCoordinates = [];
for (const atom of backbone) {
  backboneCoordinates.push(rounded(atom.x - center.x), rounded(atom.y - center.y), rounded(atom.z - center.z));
  const oxygen = atom.o ?? atom;
  backboneOCoordinates.push(rounded(oxygen.x - center.x), rounded(oxygen.y - center.y), rounded(oxygen.z - center.z));
  backboneChains.push(atom.chain);
  backboneResidueNumbers.push(atom.residue);
  backboneEntities.push(atom.entity);
  backboneBFactors.push(Number(atom.bFactor.toFixed(2)));
  const inRange = (entry) => entry.chain === atom.chain && entry.endChain === atom.chain
    && atom.residue >= entry.start && atom.residue <= entry.end;
  backboneSecondary.push(helices.some(inRange) ? 'helix' : sheets.some(inRange) ? 'sheet' : 'coil');
}

const output = {
  pdbId: config.pdbId,
  source: sourceUrl,
  model: 'C-alpha backbone coordinates with deposited HELIX/SHEET annotations, centered at the all-atom centroid',
  atomCount: atoms.length,
  backboneCount: backbone.length,
  backboneCoordinates,
  backboneSecondary,
  backboneChains,
  backboneResidueNumbers,
  backboneEntities,
  backboneBFactors,
  backboneOCoordinates,
};
output.contentHash = backboneContentHash(output);
await writeFile(config.source, `${JSON.stringify(output, null, 2)}\n`);
console.log(`generated ${config.source}: ${backbone.length} backbone points from PDB ${config.pdbId}`);
