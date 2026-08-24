#!/usr/bin/env node
// Generate a compact, runtime-independent structure asset. Network mode parses the
// deposited RCSB PDB; without it the existing C-alpha/O backbone becomes an explicitly
// marked proxy so offline builds remain reproducible without claiming full atom coverage.
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const configFile = process.argv[2] ?? 'assets-src/proteins/5i4r/protein.config.json';
const useNetwork = process.argv.includes('--network');
const config = JSON.parse(await readFile(configFile, 'utf8'));
const backbone = JSON.parse(await readFile(config.source, 'utf8'));

const ELEMENTS = ['H', 'C', 'N', 'O', 'F', 'P', 'S', 'CL', 'SE', 'MG', 'ZN', 'NA', 'CA', 'FE', 'K'];
const VDW_RADII = { H: 1.20, C: 1.70, N: 1.55, O: 1.52, F: 1.47, P: 1.80, S: 1.80, CL: 1.75, SE: 1.90, MG: 1.73, ZN: 1.39, NA: 2.27, CA: 2.31, FE: 1.56, K: 2.75 };
const COVALENT_RADII = { H: 0.31, C: 0.76, N: 0.71, O: 0.66, F: 0.57, P: 1.07, S: 1.05, CL: 1.02, SE: 1.20, MG: 1.30, ZN: 1.22, NA: 1.66, CA: 1.76, FE: 1.24, K: 2.03 };
const HYDROPHOBICITY = { ALA: 1.8, ARG: -4.5, ASN: -3.5, ASP: -3.5, CYS: 2.5, GLN: -3.5, GLU: -3.5, GLY: -0.4, HIS: -3.2, ILE: 4.5, LEU: 3.8, LYS: -3.9, MET: 1.9, PHE: 2.8, PRO: -1.6, SER: -0.8, THR: -0.7, TRP: -0.9, TYR: -1.3, VAL: 4.2 };
const RESIDUE_CHARGE = { ASP: -1, GLU: -1, LYS: 1, ARG: 1, HIS: 0.1 };
const WATER = new Set(['HOH', 'WAT', 'DOD']);

function round(value, digits = 3) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function elementOf(raw) {
  const normalized = raw.trim().toUpperCase();
  if (ELEMENTS.includes(normalized)) return normalized;
  return ELEMENTS.find((element) => normalized.startsWith(element)) ?? 'C';
}

function parseNumber(line, start, end, fallback = 0) {
  const value = Number(line.slice(start, end));
  return Number.isFinite(value) ? value : fallback;
}

function parsePdb(text) {
  const entityByChain = new Map();
  let currentEntity = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('COMPND')) continue;
    const molecule = line.match(/MOL_ID:\s*(\d+)/);
    if (molecule) currentEntity = Number(molecule[1]);
    const chains = line.match(/CHAIN:\s*([^;]+)/);
    if (chains) for (const chain of chains[1].split(',')) entityByChain.set(chain.trim(), currentEntity);
  }

  const selected = new Map();
  const conect = [];
  let sawModel = false;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('MODEL')) {
      if (sawModel) break;
      sawModel = true;
      continue;
    }
    if (line.startsWith('ENDMDL')) break;
    if (line.startsWith('CONECT')) {
      const serials = [];
      for (let offset = 6; offset < line.length; offset += 5) {
        const serial = Number(line.slice(offset, offset + 5));
        if (Number.isFinite(serial)) serials.push(serial);
      }
      if (serials.length > 1) for (const serial of serials.slice(1)) conect.push([serials[0], serial]);
      continue;
    }
    if (!line.startsWith('ATOM') && !line.startsWith('HETATM')) continue;
    const altLoc = line[16] ?? ' ';
    if (altLoc !== ' ' && altLoc !== 'A' && altLoc !== '1') continue;
    const residueName = line.slice(17, 20).trim().toUpperCase();
    if (WATER.has(residueName)) continue;
    const chain = (line[21] ?? ' ').trim() || '-';
    const residueNumber = parseNumber(line, 22, 26);
    const insertion = (line[26] ?? ' ').trim();
    const atomName = line.slice(12, 16).trim();
    const key = `${chain}:${residueNumber}:${insertion}:${atomName}`;
    const atom = {
      serial: parseNumber(line, 6, 11), atomName, residueName, chain, entity: entityByChain.get(chain) ?? 0,
      residueNumber, insertion, x: parseNumber(line, 30, 38), y: parseNumber(line, 38, 46), z: parseNumber(line, 46, 54),
      bFactor: round(parseNumber(line, 60, 66), 2), element: elementOf(line.slice(76, 78) || atomName[0] || 'C'),
    };
    const previous = selected.get(key);
    if (!previous || altLoc === ' ') selected.set(key, atom);
  }
  return { atoms: [...selected.values()], conect };
}

function fallbackAtoms() {
  const atoms = [];
  const conect = [];
  let previousCa = null;
  for (let index = 0; index < backbone.backboneCount; index++) {
    const offset = index * 3;
    const chain = backbone.backboneChains[index] ?? '-';
    const entity = backbone.backboneEntities[index] ?? 0;
    const bFactor = backbone.backboneBFactors[index] ?? 0;
    const residueNumber = index + 1;
    const caSerial = atoms.length + 1;
    atoms.push({ serial: caSerial, atomName: 'CA', residueName: 'UNK', chain, entity, residueNumber, insertion: '', x: backbone.backboneCoordinates[offset], y: backbone.backboneCoordinates[offset + 1], z: backbone.backboneCoordinates[offset + 2], bFactor, element: 'C' });
    if (previousCa !== null && chain === previousCa.chain) conect.push([previousCa.serial, caSerial]);
    previousCa = { serial: caSerial, chain };
    const oxygenOffset = index * 3;
    if (backbone.backboneOCoordinates?.length >= oxygenOffset + 3) {
      const oxygenSerial = atoms.length + 1;
      atoms.push({ serial: oxygenSerial, atomName: 'O', residueName: 'UNK', chain, entity, residueNumber, insertion: '', x: backbone.backboneOCoordinates[oxygenOffset], y: backbone.backboneOCoordinates[oxygenOffset + 1], z: backbone.backboneOCoordinates[oxygenOffset + 2], bFactor, element: 'O' });
      conect.push([caSerial, oxygenSerial]);
    }
  }
  return { atoms, conect };
}

function addBond(bonds, seen, first, second, order = 1) {
  if (first === second || first < 0 || second < 0) return;
  const a = Math.min(first, second);
  const b = Math.max(first, second);
  const key = `${a}:${b}`;
  if (seen.has(key)) return;
  seen.add(key);
  bonds.push([a, b, order]);
}

function inferBonds(atoms, conect) {
  const bySerial = new Map(atoms.map((atom, index) => [atom.serial, index]));
  const bonds = [];
  const seen = new Set();
  for (const [a, b] of conect) addBond(bonds, seen, bySerial.get(a) ?? -1, bySerial.get(b) ?? -1);
  const residues = new Map();
  atoms.forEach((atom, index) => {
    const key = `${atom.chain}:${atom.residueNumber}:${atom.insertion}`;
    const residue = residues.get(key) ?? { key, chain: atom.chain, number: atom.residueNumber, atoms: [] };
    residue.atoms.push(index);
    residues.set(key, residue);
  });
  const residueList = [...residues.values()];
  const residueByChain = new Map();
  for (const residue of residueList) {
    const list = residueByChain.get(residue.chain) ?? [];
    list.push(residue);
    residueByChain.set(residue.chain, list);
    for (let left = 0; left < residue.atoms.length; left++) for (let right = left + 1; right < residue.atoms.length; right++) {
      const a = atoms[residue.atoms[left]];
      const b = atoms[residue.atoms[right]];
      const distance = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
      const limit = (COVALENT_RADII[a.element] ?? 0.76) + (COVALENT_RADII[b.element] ?? 0.76);
      if (distance > 0.2 && distance <= limit * 1.25) addBond(bonds, seen, residue.atoms[left], residue.atoms[right]);
    }
  }
  for (const list of residueByChain.values()) {
    list.sort((a, b) => a.number - b.number);
    for (let index = 1; index < list.length; index++) {
      const previous = list[index - 1];
      const current = list[index];
      if (current.number - previous.number > 1) continue;
      for (const first of previous.atoms) for (const second of current.atoms) {
        const a = atoms[first];
        const b = atoms[second];
        const distance = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
        if (distance <= 1.9) addBond(bonds, seen, first, second);
      }
    }
  }
  bonds.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return bonds;
}

function residueFields(residueName) {
  return {
    hydrophobicity: Math.round(Math.max(-1, Math.min(1, (HYDROPHOBICITY[residueName] ?? 0) / 4.5)) * 127),
    charge: Math.round((RESIDUE_CHARGE[residueName] ?? 0) * 127),
  };
}

function surfaceField(atoms) {
  // The surface is the solvent-excluded approximation of the union of atom
  // spheres.  A tetrahedral contour avoids the block-shaped faces produced by
  // the old occupied-voxel shell while keeping the asset renderer-independent.
  const spacing = 1.25;
  const probeRadius = 1.4;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  atoms.forEach((atom) => {
    const radius = VDW_RADII[atom.element] ?? 1.7;
    min[0] = Math.min(min[0], atom.x - radius - probeRadius);
    min[1] = Math.min(min[1], atom.y - radius - probeRadius);
    min[2] = Math.min(min[2], atom.z - radius - probeRadius);
    max[0] = Math.max(max[0], atom.x + radius + probeRadius);
    max[1] = Math.max(max[1], atom.y + radius + probeRadius);
    max[2] = Math.max(max[2], atom.z + radius + probeRadius);
  });
  const origin = min.map((value) => round(value, 2));
  const dims = max.map((value, index) => Math.ceil((value - origin[index]) / spacing) + 1);
  const buckets = new Map();
  const bucketSize = Math.max(...ELEMENTS.map((element) => VDW_RADII[element])) + probeRadius;
  const bucketKey = (x, y, z) => `${x}:${y}:${z}`;
  const bucketCoordinates = (px, py, pz) => [
    Math.floor((px - origin[0]) / bucketSize),
    Math.floor((py - origin[1]) / bucketSize),
    Math.floor((pz - origin[2]) / bucketSize),
  ];
  atoms.forEach((atom, index) => {
    const [x, y, z] = bucketCoordinates(atom.x, atom.y, atom.z);
    const key = bucketKey(x, y, z);
    const list = buckets.get(key) ?? [];
    list.push(index);
    buckets.set(key, list);
  });
  function nearbyAtoms(px, py, pz) {
    const [cellX, cellY, cellZ] = bucketCoordinates(px, py, pz);
    const result = [];
    for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      result.push(...(buckets.get(bucketKey(cellX + dx, cellY + dy, cellZ + dz)) ?? []));
    }
    return result;
  }
  function fieldAt(px, py, pz) {
    let value = Infinity;
    for (const index of nearbyAtoms(px, py, pz)) {
      const atom = atoms[index];
      const radius = VDW_RADII[atom.element] ?? 1.7;
      value = Math.min(value, Math.hypot(px - atom.x, py - atom.y, pz - atom.z) - radius - probeRadius);
    }
    return value;
  }
  function nearestAtom(px, py, pz) {
    let nearest = 0;
    let distance = Infinity;
    for (const index of nearbyAtoms(px, py, pz)) {
      const atom = atoms[index];
      const nextDistance = Math.hypot(px - atom.x, py - atom.y, pz - atom.z);
      if (nextDistance < distance) { distance = nextDistance; nearest = index; }
    }
    return nearest;
  }
  const residueNames = atoms.map((atom) => atom.residueName);
  const sampleIndices = [];
  const hydrophobicity = [];
  const surfaceCharge = [];
  const surfaceComponents = [];
  const field = new Float32Array(dims[0] * dims[1] * dims[2]);
  for (let z = 0; z < dims[2]; z++) for (let y = 0; y < dims[1]; y++) for (let x = 0; x < dims[0]; x++) {
    const px = origin[0] + x * spacing;
    const py = origin[1] + y * spacing;
    const pz = origin[2] + z * spacing;
    const voxel = x + dims[0] * (y + dims[1] * z);
    field[voxel] = fieldAt(px, py, pz);
    if (field[voxel] <= 0) {
      const nearest = nearestAtom(px, py, pz);
      const fields = residueFields(residueNames[nearest]);
      sampleIndices.push(voxel);
      hydrophobicity.push(fields.hydrophobicity);
      surfaceCharge.push(fields.charge);
      surfaceComponents.push(atoms[nearest].chain);
    }
  }
  const meshPosition = [];
  const meshIndex = [];
  const meshCharge = [];
  const meshHydrophobicity = [];
  const meshComponent = [];
  const cornerOffsets = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];
  const tetrahedra = [[0, 5, 1, 6], [0, 1, 2, 6], [0, 2, 3, 6], [0, 3, 7, 6], [0, 7, 4, 6], [0, 4, 5, 6]];
  const tetraEdges = [[0, 1], [1, 2], [2, 0], [0, 3], [1, 3], [2, 3]];
  const edgeVertices = new Map();
  const gridIndex = (x, y, z) => x + dims[0] * (y + dims[1] * z);
  function contourVertex(first, second) {
    const key = first < second ? `${first}:${second}` : `${second}:${first}`;
    const existing = edgeVertices.get(key);
    if (existing !== undefined) return existing;
    const firstValue = field[first];
    const secondValue = field[second];
    const t = Math.max(0, Math.min(1, firstValue / (firstValue - secondValue)));
    const firstX = first % dims[0];
    const firstY = Math.floor(first / dims[0]) % dims[1];
    const firstZ = Math.floor(first / (dims[0] * dims[1]));
    const secondX = second % dims[0];
    const secondY = Math.floor(second / dims[0]) % dims[1];
    const secondZ = Math.floor(second / (dims[0] * dims[1]));
    const px = origin[0] + (firstX + (secondX - firstX) * t) * spacing;
    const py = origin[1] + (firstY + (secondY - firstY) * t) * spacing;
    const pz = origin[2] + (firstZ + (secondZ - firstZ) * t) * spacing;
    const atom = nearestAtom(px, py, pz);
    const fields = residueFields(residueNames[atom]);
    const index = meshPosition.length / 3;
    meshPosition.push(round(px), round(py), round(pz));
    meshCharge.push(fields.charge);
    meshHydrophobicity.push(fields.hydrophobicity);
    meshComponent.push(atoms[atom].chain);
    edgeVertices.set(key, index);
    return index;
  }
  function pushTriangle(a, b, c) {
    if (a === b || b === c || c === a) return;
    const ax = meshPosition[a * 3]; const ay = meshPosition[a * 3 + 1]; const az = meshPosition[a * 3 + 2];
    const bx = meshPosition[b * 3]; const by = meshPosition[b * 3 + 1]; const bz = meshPosition[b * 3 + 2];
    const cx = meshPosition[c * 3]; const cy = meshPosition[c * 3 + 1]; const cz = meshPosition[c * 3 + 2];
    const abx = bx - ax; const aby = by - ay; const abz = bz - az;
    const acx = cx - ax; const acy = cy - ay; const acz = cz - az;
    const areaTwice = Math.hypot(aby * acz - abz * acy, abz * acx - abx * acz, abx * acy - aby * acx);
    if (areaTwice < 1e-6) return;
    meshIndex.push(a, b, c);
  }
  for (let z = 0; z < dims[2] - 1; z++) for (let y = 0; y < dims[1] - 1; y++) for (let x = 0; x < dims[0] - 1; x++) {
    const corners = cornerOffsets.map(([dx, dy, dz]) => gridIndex(x + dx, y + dy, z + dz));
    for (const tetra of tetrahedra) {
      const crossings = [];
      for (const [a, b] of tetraEdges) {
        const first = corners[tetra[a]];
        const second = corners[tetra[b]];
        if ((field[first] <= 0) !== (field[second] <= 0)) crossings.push(contourVertex(first, second));
      }
      if (crossings.length === 3) pushTriangle(crossings[0], crossings[1], crossings[2]);
      else if (crossings.length === 4) {
        pushTriangle(crossings[0], crossings[1], crossings[2]);
        pushTriangle(crossings[0], crossings[2], crossings[3]);
      }
    }
  }
  return {
    grid: { origin, spacing, dims, probeRadius },
    sampleIndices, hydrophobicity, surfaceCharge,
    mesh: {
      position: meshPosition,
      index: meshIndex,
      charge: meshCharge,
      hydrophobicity: meshHydrophobicity,
      component: meshComponent,
    },
    metadata: {
      approximate: true,
      method: 'marching tetrahedra over the union of atom VDW spheres plus a 1.4 angstrom probe, with residue Kyte-Doolittle hydrophobicity and formal-charge approximation',
      hydrophobicityRange: [-127, 127], surfaceChargeRange: [-127, 127],
    },
  };
}

function encodeStructure(parsed, source) {
  const atoms = parsed.atoms;
  const center = atoms.reduce((sum, atom) => ({ x: sum.x + atom.x, y: sum.y + atom.y, z: sum.z + atom.z }), { x: 0, y: 0, z: 0 });
  center.x /= atoms.length; center.y /= atoms.length; center.z /= atoms.length;
  const chainTable = [...new Set(atoms.map((atom) => atom.chain))];
  const residueTable = [...new Set(atoms.map((atom) => atom.residueName))];
  const chainCode = new Map(chainTable.map((value, index) => [value, index]));
  const residueCode = new Map(residueTable.map((value, index) => [value, index]));
  const elementCode = new Map(ELEMENTS.map((value, index) => [value, index]));
  const coordinates = [];
  const elements = [];
  const radiusCodes = [];
  const chains = [];
  const entities = [];
  const bFactors = [];
  const residues = [];
  const residueNumbers = [];
  for (const atom of atoms) {
    coordinates.push(round(atom.x - center.x), round(atom.y - center.y), round(atom.z - center.z));
    elements.push(elementCode.get(atom.element) ?? elementCode.get('C'));
    radiusCodes.push(elementCode.get(atom.element) ?? elementCode.get('C'));
    chains.push(chainCode.get(atom.chain));
    entities.push(atom.entity);
    bFactors.push(atom.bFactor);
    residues.push(residueCode.get(atom.residueName));
    residueNumbers.push(atom.residueNumber);
  }
  const bonds = inferBonds(atoms, parsed.conect);
  const surface = surfaceField(atoms);
  return {
    schemaVersion: 1,
    id: 'pdb-5i4r-structure',
    pdbId: config.pdbId,
    source,
    coordinateFrame: { units: 'angstrom', centeredAt: [round(center.x), round(center.y), round(center.z)] },
    coverage: source.kind === 'rcsb-pdb' ? 'all-atom' : 'backbone-proxy',
    approximate: source.kind !== 'rcsb-pdb',
    atoms: {
      count: atoms.length, elementTable: ELEMENTS, elements, coordinates,
      radiusTable: ELEMENTS.map((element) => VDW_RADII[element] ?? 1.7), radiusCodes,
      chainTable, chains, entities, bFactors, residueTable, residues, residueNumbers,
    },
    bonds: { count: bonds.length, pairs: bonds.flatMap(([a, b]) => [a, b]), orders: bonds.map((bond) => bond[2]), inference: parsed.conect.length ? 'PDB CONECT plus covalent-distance inference' : 'covalent-distance inference' },
    surface,
    generator: { name: 'generate-protein-structure.mjs', version: 2, sourceFallback: 'existing-backbone' },
  };
}

let parsed;
let source;
if (useNetwork) {
  try {
    const response = await fetch(config.sourceStructureUrl);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    parsed = parsePdb(await response.text());
    source = { kind: 'rcsb-pdb', url: config.sourceStructureUrl, format: 'PDB', model: 1 };
  } catch (error) {
    console.warn(`network source unavailable (${error.message}); generating explicit backbone proxy`);
  }
}
if (!parsed) {
  parsed = fallbackAtoms();
  source = { kind: 'existing-backbone-fallback', file: config.source, format: 'JSON', model: 'backbone-proxy' };
}
if (!parsed.atoms.length) throw new Error('structure contains no atoms');
const outputFile = process.argv.find((argument) => argument.startsWith('--output='))?.slice('--output='.length)
  ?? config.structureAsset
  ?? 'src/assets/models/pdb5i4rStructure.json';
await writeFile(outputFile, `${JSON.stringify(encodeStructure(parsed, source), null, 2)}\n`);
console.log(`generated ${outputFile}: ${parsed.atoms.length} atoms, ${encodeStructure(parsed, source).bonds.count} bonds, ${source.kind}`);
