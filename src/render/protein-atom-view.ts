import * as THREE from 'three/webgpu';
import type { ProteinDisplayAsset } from '../game/protein/protein-display-asset';
import {
  attachProteinInstancedResidueBinding,
  attachProteinResidueBinding,
  proteinLineMaterial,
  proteinStandardMaterial,
  type ProteinMotionBinding,
} from './protein-motion-material';
import type { ProteinRenderSource } from './protein-ribbon';

const ELEMENT_COLORS: Readonly<Record<string, number>> = {
  H: 0xffffff, C: 0x909090, N: 0x3050f8, O: 0xff0d0d, F: 0x90e050,
  P: 0xff8000, S: 0xffff30, CL: 0x1ff01f, SE: 0xffa100, MG: 0x8aff00,
  ZN: 0x7d80b0, NA: 0xab5cf2, CA: 0x3dff00, FE: 0xe06633, K: 0x8f40d4,
};
const residueBindingLookups = new WeakMap<object, ProteinResidueBindingLookup>();

interface ProteinResidueBindingLookup {
  readonly atomResidues: readonly number[];
  readonly surfaceResidues: readonly number[];
}

function atomElement(structure: ProteinDisplayAsset, atom: number): string {
  return structure.atoms.elementTable[structure.atoms.elements[atom] ?? 1] ?? 'C';
}

function atomResidue(structure: ProteinDisplayAsset, atom: number): string {
  return structure.atoms.residueTable[structure.atoms.residues[atom] ?? 0] ?? '';
}

function atomChain(structure: ProteinDisplayAsset, atom: number): string {
  return structure.atoms.chainTable[structure.atoms.chains[atom] ?? 0] ?? 'A';
}

function atomPosition(structure: ProteinDisplayAsset, atom: number): THREE.Vector3 {
  const offset = atom * 3;
  return new THREE.Vector3(
    structure.atoms.coordinates[offset] ?? 0,
    structure.atoms.coordinates[offset + 1] ?? 0,
    structure.atoms.coordinates[offset + 2] ?? 0,
  );
}

export function proteinResidueBindingLookup(source: ProteinRenderSource): ProteinResidueBindingLookup {
  let lookup = residueBindingLookups.get(source);
  if (lookup) return lookup;

  const structure = source.structure;
  const backbone = source.backbone;
  const residueByKey = new Map<string, number>();
  const backboneByChain = new Map<string, number[]>();
  const atomPositions = Array.from({ length: structure.atoms.count }, (_, atom) => atomPosition(structure, atom));

  // Backbone assets predate residue numbers, so recover the exact residue key
  // by matching each C-alpha coordinate to the structure asset once at build
  // time. The generated coordinates share the same centered Å frame.
  for (let residue = 0; residue < backbone.backboneCount; residue += 1) {
    const offset = residue * 3;
    const chain = backbone.backboneChains[residue] ?? 'A';
    const point = new THREE.Vector3(
      backbone.backboneCoordinates[offset] ?? 0,
      backbone.backboneCoordinates[offset + 1] ?? 0,
      backbone.backboneCoordinates[offset + 2] ?? 0,
    );
    let bestAtom = -1;
    let bestDistance = Infinity;
    for (let atom = 0; atom < structure.atoms.count; atom += 1) {
      if (atomChain(structure, atom) !== chain) continue;
      const distance = point.distanceToSquared(atomPositions[atom]!);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestAtom = atom;
      }
    }
    const residueNumber = bestAtom >= 0 ? structure.atoms.residueNumbers[bestAtom] : residue;
    residueByKey.set(`${chain}:${residueNumber ?? residue}`, residue);
    const chainResidues = backboneByChain.get(chain) ?? [];
    chainResidues.push(residue);
    backboneByChain.set(chain, chainResidues);
  }

  const nearestBackbone = (point: THREE.Vector3, chain: string): number => {
    const candidates = backboneByChain.get(chain) ?? [];
    let best = candidates[0] ?? 0;
    let bestDistance = Infinity;
    for (const residue of candidates) {
      const offset = residue * 3;
      const dx = point.x - (backbone.backboneCoordinates[offset] ?? 0);
      const dy = point.y - (backbone.backboneCoordinates[offset + 1] ?? 0);
      const dz = point.z - (backbone.backboneCoordinates[offset + 2] ?? 0);
      const distance = dx * dx + dy * dy + dz * dz;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = residue;
      }
    }
    return best;
  };

  const atomResidues = new Array<number>(structure.atoms.count);
  for (let atom = 0; atom < structure.atoms.count; atom += 1) {
    const chain = atomChain(structure, atom);
    const residueNumber = structure.atoms.residueNumbers[atom] ?? atom;
    atomResidues[atom] = residueByKey.get(`${chain}:${residueNumber}`)
      ?? nearestBackbone(atomPositions[atom]!, chain);
  }

  // Surface vertices are generated from an atom-neighborhood contour. A small
  // spatial hash preserves that provenance without an O(surface × atom) scan.
  const cellSize = 4;
  const buckets = new Map<string, number[]>();
  const bucketKey = (x: number, y: number, z: number): string => `${x}:${y}:${z}`;
  for (let atom = 0; atom < atomPositions.length; atom += 1) {
    const point = atomPositions[atom]!;
    const key = bucketKey(Math.floor(point.x / cellSize), Math.floor(point.y / cellSize), Math.floor(point.z / cellSize));
    const bucket = buckets.get(key) ?? [];
    bucket.push(atom);
    buckets.set(key, bucket);
  }
  const nearestSurfaceResidue = (point: THREE.Vector3, component: string): number => {
    const x = Math.floor(point.x / cellSize);
    const y = Math.floor(point.y / cellSize);
    const z = Math.floor(point.z / cellSize);
    let best = nearestBackbone(point, component);
    let bestDistance = Infinity;
    for (let dz = -1; dz <= 1; dz += 1) for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
      for (const atom of buckets.get(bucketKey(x + dx, y + dy, z + dz)) ?? []) {
        if (atomChain(structure, atom) !== component) continue;
        const distance = point.distanceToSquared(atomPositions[atom]!);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = atomResidues[atom]!;
        }
      }
    }
    return best;
  };

  const surface = structure.surface.mesh;
  const center = structure.coordinateFrame.centeredAt;
  const surfaceResidues = new Array<number>(surface.position.length / 3);
  for (let vertex = 0; vertex < surfaceResidues.length; vertex += 1) {
    const offset = vertex * 3;
    const point = new THREE.Vector3(
      (surface.position[offset] ?? 0) - (center[0] ?? 0),
      (surface.position[offset + 1] ?? 0) - (center[1] ?? 0),
      (surface.position[offset + 2] ?? 0) - (center[2] ?? 0),
    );
    surfaceResidues[vertex] = nearestSurfaceResidue(point, surface.component[vertex] ?? 'A');
  }

  const backboneResidues = source.motion.bindings.backboneResidues;
  const mappedAtomResidues = source.motion.bindings.atomResidues.length === structure.atoms.count
    ? source.motion.bindings.atomResidues
    : atomResidues.map((residue) => backboneResidues[residue] ?? residue);
  const mappedSurfaceResidues = source.motion.bindings.surfaceResidues.length === surfaceResidues.length
    ? source.motion.bindings.surfaceResidues
    : surfaceResidues.map((residue) => backboneResidues[residue] ?? residue);
  lookup = { atomResidues: mappedAtomResidues, surfaceResidues: mappedSurfaceResidues };
  residueBindingLookups.set(source, lookup);
  return lookup;
}

function atomMaterial(element: string, ligand = false, motion?: ProteinMotionBinding): THREE.MeshStandardNodeMaterial {
  return proteinStandardMaterial({
    color: ELEMENT_COLORS[element.toUpperCase()] ?? 0xc0c0c0,
    emissive: ligand && element.toUpperCase() === 'FE' ? 0x7a1f00 : 0x000000,
    emissiveIntensity: ligand && element.toUpperCase() === 'FE' ? 0.9 : 0,
    roughness: 0.25,
    metalness: element.toUpperCase() === 'FE' ? 0.72 : 0.18,
  }, motion);
}

export function buildProteinAtoms(
  source: ProteinRenderSource,
  selected: ReadonlySet<number> | null,
  ligand = false,
  motion?: ProteinMotionBinding,
): THREE.Group {
  const structure = source.structure;
  const bindings = proteinResidueBindingLookup(source);
  const group = new THREE.Group();
  // 色は元素と ligand の別だけで決まり、chain には依存しないので、
  // 同じ呼び出し内で chain をまたいでマテリアルを共有する。
  const atomMaterialsByElement = new Map<string, THREE.MeshStandardNodeMaterial>();
  const byChain = new Map<string, Map<string, number[]>>();
  for (let atom = 0; atom < structure.atoms.count; atom++) {
    if (selected && !selected.has(atom)) continue;
    const chain = atomChain(structure, atom);
    const element = atomElement(structure, atom);
    const byElement = byChain.get(chain) ?? new Map<string, number[]>();
    const list = byElement.get(element) ?? [];
    list.push(atom);
    byElement.set(element, list);
    byChain.set(chain, byElement);
  }
  for (const [chain, byElement] of byChain) {
    const chainGroup = new THREE.Group();
    chainGroup.userData.proteinComponent = chain;
    chainGroup.userData.proteinLigand = ligand;
    for (const [element, atoms] of byElement) {
      const radiusCode = structure.atoms.radiusCodes[atoms[0]!] ?? 1;
      const baseRadius = structure.atoms.radiusTable[radiusCode] ?? 1.7;
      const radius = ligand && element === 'FE' ? baseRadius * 1.35 : baseRadius * (ligand ? 0.72 : 1);
      let material = atomMaterialsByElement.get(element);
      const ownsMaterial = !material;
      if (!material) {
        material = atomMaterial(element, ligand, motion);
        atomMaterialsByElement.set(element, material);
      }
      const mesh = new THREE.InstancedMesh(new THREE.SphereGeometry(radius, 10, 8), material, atoms.length);
      const matrix = new THREE.Matrix4();
      atoms.forEach((atom, instance) => {
        const offset = atom * 3;
        matrix.makeTranslation(
          structure.atoms.coordinates[offset]!, structure.atoms.coordinates[offset + 1]!, structure.atoms.coordinates[offset + 2]!,
        );
        mesh.setMatrixAt(instance, matrix);
      });
      mesh.instanceMatrix.needsUpdate = true;
      const residues = atoms.map((atom) => bindings.atomResidues[atom] ?? 0);
      attachProteinInstancedResidueBinding(mesh, residues);
      mesh.userData.proteinElement = element;
      mesh.userData.proteinLigand = ligand;
      mesh.userData.ownsGeometry = true;
      mesh.userData.ownsMaterial = ownsMaterial;
      chainGroup.add(mesh);
    }
    group.add(chainGroup);
  }

  const bondPositionsByChain = new Map<string, number[]>();
  const bondResiduesByChain = new Map<string, number[]>();
  for (let offset = 0; offset + 1 < structure.bonds.pairs.length; offset += 2) {
    const first = structure.bonds.pairs[offset]!;
    const second = structure.bonds.pairs[offset + 1]!;
    if (selected && (!selected.has(first) || !selected.has(second))) continue;
    const chain = atomChain(structure, first);
    const a = first * 3;
    const b = second * 3;
    const bondPositions = bondPositionsByChain.get(chain) ?? [];
    bondPositions.push(
      structure.atoms.coordinates[a]!, structure.atoms.coordinates[a + 1]!, structure.atoms.coordinates[a + 2]!,
      structure.atoms.coordinates[b]!, structure.atoms.coordinates[b + 1]!, structure.atoms.coordinates[b + 2]!,
    );
    bondPositionsByChain.set(chain, bondPositions);
    const bondResidues = bondResiduesByChain.get(chain) ?? [];
    bondResidues.push(bindings.atomResidues[first] ?? 0, bindings.atomResidues[second] ?? 0);
    bondResiduesByChain.set(chain, bondResidues);
  }
  // 結合線の色は ligand の別だけで決まるので、chain をまたいで1つのマテリアルを共有する。
  let bondMaterial: THREE.LineBasicNodeMaterial | null = null;
  for (const [chain, bondPositions] of bondPositionsByChain) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(bondPositions, 3));
    const bondResidues = bondResiduesByChain.get(chain) ?? [];
    attachProteinResidueBinding(geometry, bondResidues);
    const ownsBondMaterial = !bondMaterial;
    if (!bondMaterial) {
      bondMaterial = proteinLineMaterial({
        color: ligand ? 0xffb45e : 0x778899, transparent: true, opacity: ligand ? 0.9 : 0.65,
      }, motion);
    }
    const bonds = new THREE.LineSegments(geometry, bondMaterial);
    bonds.userData.proteinComponent = chain;
    bonds.userData.proteinLigand = ligand;
    bonds.userData.ownsGeometry = true;
    bonds.userData.ownsMaterial = ownsBondMaterial;
    group.add(bonds);
  }
  return group;
}

export function buildProteinLigands(source: ProteinRenderSource, motion?: ProteinMotionBinding): THREE.Group {
  const residues = new Set(source.semantic.ligands.map((ligand) => ligand.residue.toUpperCase()));
  const selected = new Set<number>();
  for (let atom = 0; atom < source.structure.atoms.count; atom++) {
    if (residues.has(atomResidue(source.structure, atom).toUpperCase())) selected.add(atom);
  }
  const group = buildProteinAtoms(source, selected, true, motion);
  group.userData.proteinLigand = true;
  group.userData.proteinLigandIds = source.semantic.ligands.map((ligand) => ligand.id);
  return group;
}
