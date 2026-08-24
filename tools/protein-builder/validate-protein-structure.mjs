#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

const filename = process.argv[2] ?? 'src/assets/models/pdb5i4rStructure.json';
const asset = JSON.parse(await readFile(filename, 'utf8'));
const errors = [];
const atoms = asset.atoms ?? {};
const count = atoms.count;
if (asset.schemaVersion !== 1) errors.push('schemaVersion must be 1');
if (!Number.isInteger(count) || count <= 0) errors.push('atoms.count must be positive');
for (const [name, size] of [['elements', count], ['radiusCodes', count], ['chains', count], ['entities', count], ['bFactors', count], ['residues', count], ['residueNumbers', count], ['coordinates', count * 3]]) {
  if (!Array.isArray(atoms[name]) || atoms[name].length !== size) errors.push(`atoms.${name} must have length ${size}`);
}
if (!Array.isArray(atoms.elementTable) || !Array.isArray(atoms.radiusTable)) errors.push('element/radius tables are required');
const bonds = asset.bonds ?? {};
if (!Number.isInteger(bonds.count) || !Array.isArray(bonds.pairs) || bonds.pairs.length !== bonds.count * 2) errors.push('bond pairs/count mismatch');
if (!Array.isArray(bonds.orders) || bonds.orders.length !== bonds.count) errors.push('bond orders/count mismatch');
for (const index of bonds.pairs ?? []) if (!Number.isInteger(index) || index < 0 || index >= count) errors.push(`bond atom index out of range: ${index}`);
const surface = asset.surface ?? {};
const surfaceCount = surface.sampleIndices?.length ?? -1;
if (!surface.grid || !Array.isArray(surface.grid.dims) || surface.grid.dims.length !== 3) errors.push('surface grid dims are required');
if (surfaceCount < 0 || surface.hydrophobicity?.length !== surfaceCount || surface.surfaceCharge?.length !== surfaceCount) errors.push('surface field lengths mismatch');
const mesh = surface.mesh ?? {};
const meshVertexCount = mesh.position?.length / 3;
if (!Number.isInteger(meshVertexCount) || meshVertexCount <= 0) errors.push('surface mesh positions are required');
if (!Array.isArray(mesh.index) || mesh.index.length % 3 !== 0) errors.push('surface mesh indices must be triangles');
if (mesh.charge?.length !== meshVertexCount || mesh.hydrophobicity?.length !== meshVertexCount || mesh.component?.length !== meshVertexCount) errors.push('surface mesh field lengths mismatch');
if (asset.coverage === 'all-atom' && asset.approximate) errors.push('all-atom asset cannot be marked approximate');
if (errors.length) {
  console.error(`${filename}: invalid: ${errors.join('; ')}`);
  process.exitCode = 1;
} else {
  console.log(`${filename}: valid (${count} atoms, ${bonds.count} bonds, ${surfaceCount} surface samples, coverage=${asset.coverage})`);
}
