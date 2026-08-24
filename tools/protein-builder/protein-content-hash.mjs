import { createHash } from 'node:crypto';

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function digest(value) {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

export function structureContentPayload(asset) {
  return {
    pdbId: asset.pdbId,
    coordinateFrame: asset.coordinateFrame,
    atoms: asset.atoms,
    bonds: asset.bonds,
    surface: { mesh: asset.surface?.mesh },
  };
}

export function backboneContentPayload(asset) {
  return {
    pdbId: asset.pdbId,
    model: asset.model,
    atomCount: asset.atomCount,
    backboneCount: asset.backboneCount,
    backboneCoordinates: asset.backboneCoordinates,
    backboneChains: asset.backboneChains,
    backboneResidueNumbers: asset.backboneResidueNumbers,
    backboneEntities: asset.backboneEntities,
    backboneBFactors: asset.backboneBFactors,
    backboneOCoordinates: asset.backboneOCoordinates,
  };
}

export function structureContentHash(asset) {
  return digest(structureContentPayload(asset));
}

export function backboneContentHash(asset) {
  return digest(backboneContentPayload(asset));
}
