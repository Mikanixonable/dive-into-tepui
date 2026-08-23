import { mkdir, writeFile } from 'node:fs/promises';

const PDB_ID = '5I4R';
const sourceUrl = `https://files.rcsb.org/download/${PDB_ID}.pdb`;
const text = await (await fetch(sourceUrl)).text();
if (!text.startsWith('HEADER')) throw new Error(`could not download ${sourceUrl}`);

const vdwRadius = {
  H: 1.20, C: 1.70, N: 1.55, O: 1.52, F: 1.47, P: 1.80, S: 1.80, SE: 1.90,
};
const atoms = [];
const helices = [];
const sheets = [];
const entityByChain = new Map();
let currentEntity = 0;
for (const line of text.split('\n')) {
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
  if (line.slice(17, 20).trim() === 'HOH') continue;
  const x = Number(line.slice(30, 38));
  const y = Number(line.slice(38, 46));
  const z = Number(line.slice(46, 54));
  if (![x, y, z].every(Number.isFinite)) continue;
  const element = line.slice(76, 78).trim().toUpperCase() || line.slice(12, 16).trim()[0].toUpperCase();
  atoms.push({ x, y, z, radius: vdwRadius[element] ?? 1.70 });
}
if (atoms.length === 0) throw new Error('no atoms found');

const backbone = [];
for (const line of text.split('\n')) {
  if (!line.startsWith('ATOM') || line.slice(12, 16).trim() !== 'CA') continue;
  const x = Number(line.slice(30, 38));
  const y = Number(line.slice(38, 46));
  const z = Number(line.slice(46, 54));
  if (![x, y, z].every(Number.isFinite)) continue;
  const chain = line.slice(21, 22).trim();
  backbone.push({
    chain, entity: entityByChain.get(chain) ?? 0, bFactor: Number(line.slice(60, 66)),
    residue: Number(line.slice(22, 26)), x, y, z,
  });
}

const center = atoms.reduce((sum, atom) => ({
  x: sum.x + atom.x, y: sum.y + atom.y, z: sum.z + atom.z,
}), { x: 0, y: 0, z: 0 });
center.x /= atoms.length;
center.y /= atoms.length;
center.z /= atoms.length;

const backboneCoordinates = [];
const backboneSecondary = [];
const backboneChains = [];
const backboneEntities = [];
const backboneBFactors = [];
for (const atom of backbone) {
  backboneCoordinates.push(
    Number((atom.x - center.x).toFixed(3)),
    Number((atom.y - center.y).toFixed(3)),
    Number((atom.z - center.z).toFixed(3)),
  );
  backboneChains.push(atom.chain);
  backboneEntities.push(atom.entity);
  backboneBFactors.push(Number(atom.bFactor.toFixed(2)));
  const inRange = (entry) => entry.chain === atom.chain && entry.endChain === atom.chain
    && atom.residue >= entry.start && atom.residue <= entry.end;
  backboneSecondary.push(helices.some(inRange) ? 'helix' : sheets.some(inRange) ? 'sheet' : 'coil');
}

await mkdir('src/assets/models', { recursive: true });
await writeFile('src/assets/models/pdb5i4rBackbone.json', JSON.stringify({
  pdbId: PDB_ID,
  source: sourceUrl,
  model: 'C-alpha backbone coordinates with deposited HELIX/SHEET annotations, centered at the all-atom centroid',
  atomCount: atoms.length,
  backboneCount: backbone.length,
  backboneCoordinates,
  backboneSecondary,
  backboneChains,
  backboneEntities,
  backboneBFactors,
}) + '\n');
console.log(`Wrote ${backbone.length} backbone points from PDB ${PDB_ID}`);
