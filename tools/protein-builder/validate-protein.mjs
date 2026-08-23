#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

const filename = process.argv[2] ?? 'src/assets/models/pdb5i4rProtein.json';
const asset = JSON.parse(await readFile(filename, 'utf8'));
const errors = [];
if (asset.schemaVersion !== 1) errors.push('schemaVersion must be 1');
if (!asset.id) errors.push('id is required');
if (!Number.isFinite(asset.coordinateScale) || asset.coordinateScale <= 0) errors.push('coordinateScale must be positive');
if (!Number.isFinite(asset.integrity?.maxHp) || asset.integrity.maxHp <= 0) errors.push('integrity.maxHp must be positive');
const siteIds = new Set();
for (const site of asset.sites ?? []) {
  if (siteIds.has(site.id)) errors.push(`duplicate site id: ${site.id}`);
  siteIds.add(site.id);
  if (!Array.isArray(site.position) || site.position.length !== 3) errors.push(`invalid position: ${site.id}`);
  if (!Number.isFinite(site.radius) || site.radius <= 0) errors.push(`invalid radius: ${site.id}`);
  if (!Number.isFinite(site.maxHp) || site.maxHp <= 0) errors.push(`invalid maxHp: ${site.id}`);
}
const expectedEntityChains = new Map([
  [1, ['A', 'E']], // CdiA
  [2, ['C', 'G']], // EF-Tu
  [3, ['D', 'H']], // EF-Tu
  [4, ['B', 'F']], // CdiI
]);
for (const component of asset.components ?? []) {
  for (const entity of component.entities ?? []) {
    const expected = expectedEntityChains.get(entity);
    if (expected && JSON.stringify(component.chains) !== JSON.stringify(expected)) {
      errors.push(`entity ${entity} chains must be ${expected.join('/')} (got ${(component.chains ?? []).join('/')})`);
    }
  }
}
for (const slot of asset.modificationSlots ?? []) {
  if (!(slot.states ?? []).includes(slot.defaultState)) errors.push(`invalid defaultState: ${slot.id}`);
}
if (errors.length > 0) {
  console.error(`${filename}: ${errors.join('; ')}`);
  process.exitCode = 1;
} else {
  console.log(`${filename}: valid (${asset.sites.length} sites, ${asset.components.length} components)`);
}
