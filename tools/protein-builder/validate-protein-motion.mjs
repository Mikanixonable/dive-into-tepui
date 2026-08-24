#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { backboneContentHash, structureContentHash } from './protein-content-hash.mjs';

const filename = process.argv[2] ?? 'src/assets/models/pdb5i4rMotion.json';
const motion = JSON.parse(await readFile(filename, 'utf8'));
const errors = [];
const root = resolve(new URL('../..', import.meta.url).pathname);
const configPath = resolve(root, process.argv[3] ?? 'assets-src/proteins/5i4r/protein.config.json');
const config = JSON.parse(await readFile(configPath, 'utf8'));
const structure = JSON.parse(await readFile(resolve(root, config.structureAsset), 'utf8'));
const backbone = JSON.parse(await readFile(resolve(root, config.source), 'utf8'));
const semantic = JSON.parse(await readFile(resolve(root, config.definitionAsset), 'utf8'));
const residueCount = motion.residueCount;
if (motion.schemaVersion !== 1) errors.push('schemaVersion must be 1');
if (motion.model !== 'c-alpha-anm-overdamped') errors.push('model must be c-alpha-anm-overdamped');
if (motion.source?.pdbId !== config.pdbId) errors.push(`source.pdbId must be ${config.pdbId}`);
if (motion.source?.structureHash !== structure.generator?.contentHash || motion.source?.structureHash !== structureContentHash(structure)) errors.push('structure hash mismatch');
if (motion.source?.backboneHash !== backbone.contentHash || motion.source?.backboneHash !== backboneContentHash(backbone)) errors.push('backbone hash mismatch');
if (!Number.isInteger(residueCount) || residueCount <= 0) errors.push('residueCount must be positive');
for (const [name, expected] of [['chains', residueCount], ['residueNumbers', residueCount], ['bFactors', residueCount], ['centers', residueCount * 3]]) {
  if (!Array.isArray(motion.residues?.[name]) || motion.residues[name].length !== expected) errors.push(`residues.${name} length mismatch`);
}
for (const name of ['atomResidues', 'backboneResidues', 'surfaceResidues', 'siteResidues', 'modificationResidues']) {
  const values = motion.bindings?.[name];
  if (!Array.isArray(values)) errors.push(`bindings.${name} must be an array`);
  else for (const index of values) if (!Number.isInteger(index) || index < 0 || index >= residueCount) errors.push(`bindings.${name} index out of range: ${index}`);
}
for (const name of ['centers', 'bFactors']) {
  if (motion.residues?.[name]?.some((value) => !Number.isFinite(value))) errors.push(`residues.${name} must be finite`);
}
const expectedBindingLengths = {
  atomResidues: structure.atoms.count,
  backboneResidues: backbone.backboneCount,
  surfaceResidues: structure.surface.mesh.position.length / 3,
  siteResidues: semantic.sites.length,
  modificationResidues: semantic.modificationSlots.length,
};
for (const [name, expected] of Object.entries(expectedBindingLengths)) {
  if (motion.bindings?.[name]?.length !== expected) errors.push(`bindings.${name} length must be ${expected}`);
}
if (!Array.isArray(motion.modes) || motion.modes.length !== 24) errors.push('modes must contain exactly 24 entries');
for (const [index, mode] of (motion.modes ?? []).entries()) {
  if (mode.band !== (index < 4 ? 'collective' : 'local')) errors.push(`mode ${index} band mismatch`);
  if (!Number.isFinite(mode.eigenvalue) || mode.eigenvalue <= 0) errors.push(`mode ${index} eigenvalue invalid`);
  if (!Number.isFinite(mode.displayRelaxationRate) || mode.displayRelaxationRate <= 0) errors.push(`mode ${index} relaxation invalid`);
  const amplitude = motion.amplitudeCalibration === 'b-factor-relative' ? mode.physicalRmsAngstrom : mode.displayRmsAngstrom;
  if (!Number.isFinite(amplitude) || amplitude <= 0 || amplitude > 50) errors.push(`mode ${index} amplitude must be in (0, 50] Å`);
  if (motion.amplitudeCalibration === 'b-factor-relative' && mode.displayRmsAngstrom !== undefined) errors.push(`mode ${index} has display amplitude despite physical calibration`);
  if (motion.amplitudeCalibration === 'uncalibrated-display' && mode.physicalRmsAngstrom !== undefined) errors.push(`mode ${index} falsely claims physical calibration`);
  if (!Array.isArray(mode.displacements) || mode.displacements.length !== residueCount * 3) errors.push(`mode ${index} displacement length mismatch`);
  else {
    const norm = Math.hypot(...mode.displacements);
    if (!Number.isFinite(norm) || Math.abs(norm - 1) > 2e-3) errors.push(`mode ${index} displacement norm is ${norm}`);
    for (let offset = 0; offset < mode.displacements.length; offset += 3) {
      if (![mode.displacements[offset], mode.displacements[offset + 1], mode.displacements[offset + 2]].every(Number.isFinite)) errors.push(`mode ${index} contains a non-finite displacement`);
    }
  }
  if (index > 0 && mode.eigenvalue < motion.modes[index - 1].eigenvalue) errors.push(`mode ${index} eigenvalues are not sorted`);
}
if (!['b-factor-relative', 'uncalibrated-display'].includes(motion.amplitudeCalibration)) errors.push('amplitudeCalibration invalid');
if (motion.amplitudeCalibration === 'b-factor-relative' && !motion.residues.bFactors.some((value) => value > 0)) errors.push('physical calibration requires positive B-factors');
if (!(motion.display?.collectiveGain > 0 && motion.display.collectiveGain <= 1) || !(motion.display?.localGain > 0 && motion.display.localGain <= 1)) errors.push('display gains must be in (0, 1]');

const chainAtAtom = structure.atoms.chains.map((index) => structure.atoms.chainTable[index]);
const residueChains = motion.residues.chains;
let chainBindingErrors = 0;
for (let index = 0; index < chainAtAtom.length; index++) if (chainAtAtom[index] !== residueChains[motion.bindings.atomResidues[index]]) chainBindingErrors++;
for (let index = 0; index < backbone.backboneCount; index++) if (backbone.backboneChains[index] !== residueChains[motion.bindings.backboneResidues[index]]) chainBindingErrors++;
for (let index = 0; index < structure.surface.mesh.component.length; index++) if (structure.surface.mesh.component[index] !== residueChains[motion.bindings.surfaceResidues[index]]) chainBindingErrors++;
const componentChains = new Map(semantic.components.map((component) => [component.id, new Set(component.chains)]));
for (const [index, site] of semantic.sites.entries()) if (!componentChains.get(site.componentId)?.has(residueChains[motion.bindings.siteResidues[index]])) chainBindingErrors++;
for (const [index, slot] of semantic.modificationSlots.entries()) if (!componentChains.get(slot.componentId)?.has(residueChains[motion.bindings.modificationResidues[index]])) chainBindingErrors++;
if (chainBindingErrors !== 0) errors.push(`chain-aware binding errors: ${chainBindingErrors}`);
if (errors.length > 0) {
  console.error(`${filename}: invalid: ${errors.join('; ')}`);
  process.exitCode = 1;
} else {
  console.log(`${filename}: valid (${residueCount} residues, ${motion.modes.length} modes, hashes verified)`);
}
