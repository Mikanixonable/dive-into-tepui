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
const actionIds = new Set();
for (const action of asset.actions ?? []) {
  if (!action.id) errors.push('action id is required');
  if (actionIds.has(action.id)) errors.push(`duplicate action id: ${action.id}`);
  actionIds.add(action.id);
}
for (const site of asset.sites ?? []) {
  if (siteIds.has(site.id)) errors.push(`duplicate site id: ${site.id}`);
  siteIds.add(site.id);
  if (!Array.isArray(site.position) || site.position.length !== 3) errors.push(`invalid position: ${site.id}`);
  if (!Number.isFinite(site.radius) || site.radius <= 0) errors.push(`invalid radius: ${site.id}`);
  if (!Number.isFinite(site.maxHp) || site.maxHp <= 0) errors.push(`invalid maxHp: ${site.id}`);
  for (const action of site.actions ?? []) {
    if (!actionIds.has(action)) errors.push(`unknown action ${action} on site ${site.id}`);
  }
}
for (const bond of asset.bonds ?? []) {
  if (!siteIds.has(bond.from)) errors.push(`bond references unknown site: ${bond.from}`);
  if (!siteIds.has(bond.to)) errors.push(`bond references unknown site: ${bond.to}`);
}
for (const component of asset.components ?? []) {
  if (!component.id) errors.push('component id is required');
  if (!Array.isArray(component.chains) || component.chains.length === 0) errors.push(`component ${component.id} has no chains`);
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
