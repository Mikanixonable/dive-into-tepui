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
if (Number.isInteger(meshVertexCount) && Array.isArray(mesh.index) && mesh.index.length % 3 === 0) {
  const edges = new Map();
  let degenerateTriangles = 0;
  let invalidIndices = 0;
  const positions = mesh.position ?? [];
  for (let offset = 0; offset < mesh.index.length; offset += 3) {
    const a = mesh.index[offset];
    const b = mesh.index[offset + 1];
    const c = mesh.index[offset + 2];
    if (![a, b, c].every((index) => Number.isInteger(index) && index >= 0 && index < meshVertexCount)) {
      invalidIndices++;
      continue;
    }
    if (a === b || b === c || c === a) {
      degenerateTriangles++;
      continue;
    }
    const ax = positions[a * 3]; const ay = positions[a * 3 + 1]; const az = positions[a * 3 + 2];
    const bx = positions[b * 3]; const by = positions[b * 3 + 1]; const bz = positions[b * 3 + 2];
    const cx = positions[c * 3]; const cy = positions[c * 3 + 1]; const cz = positions[c * 3 + 2];
    const ab = [bx - ax, by - ay, bz - az];
    const ac = [cx - ax, cy - ay, cz - az];
    const areaTwice = Math.hypot(ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]);
    if (!Number.isFinite(areaTwice) || areaTwice <= 1e-12) degenerateTriangles++;
    for (const [first, second] of [[a, b], [b, c], [c, a]]) {
      const low = Math.min(first, second);
      const high = Math.max(first, second);
      const key = `${low}:${high}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  const boundaryEdges = [...edges.values()].filter((count) => count === 1).length;
  const nonManifoldEdges = [...edges.values()].filter((count) => count > 2).length;
  if (invalidIndices) errors.push(`surface mesh has ${invalidIndices} invalid triangle(s)`);
  if (degenerateTriangles) errors.push(`surface mesh has ${degenerateTriangles} degenerate triangle(s)`);
  if (boundaryEdges) errors.push(`surface mesh has ${boundaryEdges} boundary edge(s)`);
  if (nonManifoldEdges) errors.push(`surface mesh has ${nonManifoldEdges} non-manifold edge(s)`);
}
if (asset.coverage === 'all-atom' && asset.approximate) errors.push('all-atom asset cannot be marked approximate');
if (errors.length) {
  console.error(`${filename}: invalid: ${errors.join('; ')}`);
  process.exitCode = 1;
} else {
  console.log(`${filename}: valid (${count} atoms, ${bonds.count} bonds, ${surfaceCount} surface samples, coverage=${asset.coverage})`);
}
