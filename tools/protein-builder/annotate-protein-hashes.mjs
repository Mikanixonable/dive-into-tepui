#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { backboneContentHash, structureContentHash } from './protein-content-hash.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const proteinRoot = join(root, 'assets-src/proteins');

function nearestResidues(backbone, structure) {
  const centers = [];
  for (let offset = 0; offset < backbone.backboneCoordinates.length; offset += 3) centers.push([
    backbone.backboneCoordinates[offset], backbone.backboneCoordinates[offset + 1], backbone.backboneCoordinates[offset + 2],
  ]);
  const atoms = [];
  for (let offset = 0; offset < structure.atoms.coordinates.length; offset += 3) atoms.push([
    structure.atoms.coordinates[offset], structure.atoms.coordinates[offset + 1], structure.atoms.coordinates[offset + 2],
  ]);
  return centers.map((center) => {
    let best = 0;
    let bestDistance = Infinity;
    for (let index = 0; index < atoms.length; index += 1) {
      const atom = atoms[index];
      const dx = center[0] - atom[0]; const dy = center[1] - atom[1]; const dz = center[2] - atom[2];
      const distance = dx * dx + dy * dy + dz * dz;
      if (distance < bestDistance) { best = index; bestDistance = distance; }
    }
    if (bestDistance > 0.25 * 0.25) throw new Error(`could not map backbone coordinate to structure atom (${Math.sqrt(bestDistance).toFixed(3)} Å)`);
    return structure.atoms.residueNumbers[best];
  });
}

const entries = await readdir(proteinRoot, { withFileTypes: true });
for (const entry of entries.filter((candidate) => candidate.isDirectory()).sort((left, right) => left.name.localeCompare(right.name))) {
  const configPath = join(proteinRoot, entry.name, 'protein.config.json');
  let config;
  try { config = JSON.parse(await readFile(configPath, 'utf8')); } catch { continue; }
  const structurePath = join(root, config.structureAsset);
  const backbonePath = join(root, config.source);
  const structure = JSON.parse(await readFile(structurePath, 'utf8'));
  const backbone = JSON.parse(await readFile(backbonePath, 'utf8'));
  if (!backbone.backboneResidueNumbers) backbone.backboneResidueNumbers = nearestResidues(backbone, structure);
  structure.generator = { ...structure.generator, contentHash: structureContentHash(structure) };
  backbone.contentHash = backboneContentHash(backbone);
  await writeFile(structurePath, `${JSON.stringify(structure, null, 2)}\n`);
  await writeFile(backbonePath, `${JSON.stringify(backbone, null, 2)}\n`);
  console.log(`annotated ${config.pdbId}: structure=${structure.generator.contentHash}, backbone=${backbone.contentHash}`);
}
