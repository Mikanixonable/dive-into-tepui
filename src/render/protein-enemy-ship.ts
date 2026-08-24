import * as THREE from 'three/webgpu';
import type { ProteinAssetDefinition } from '../game/protein/protein-schema';
import type { ProteinDisplayAsset } from '../game/protein/protein-display-asset';
import type { ProteinDisplaySettings, ProteinRibbonColorMode } from '../game/protein/protein-display';
import { markLitOpaque, markProteinShadowLayers } from './pipeline/lit-layer';

export interface ProteinBackboneAsset {
  readonly backboneCount: number;
  readonly backboneCoordinates: readonly number[];
  readonly backboneSecondary: readonly string[];
  readonly backboneChains: readonly string[];
  readonly backboneEntities: readonly number[];
  readonly backboneBFactors: readonly number[];
}

export interface ProteinRenderSource {
  readonly semantic: ProteinAssetDefinition;
  readonly backbone: ProteinBackboneAsset;
  readonly structure: ProteinDisplayAsset;
}

const ELEMENT_COLORS: Readonly<Record<string, number>> = {
  H: 0xffffff, C: 0x909090, N: 0x3050f8, O: 0xff0d0d, F: 0x90e050,
  P: 0xff8000, S: 0xffff30, CL: 0x1ff01f, SE: 0xffa100, MG: 0x8aff00,
  ZN: 0x7d80b0, NA: 0xab5cf2, CA: 0x3dff00, FE: 0xe06633, K: 0x8f40d4,
};
const CHAIN_COLORS = [0x48c9ff, 0x9b7cff, 0x56df9b, 0xffc857, 0xff6b91, 0xb7e06b];

function rainbowColor(t: number): THREE.Color {
  return new THREE.Color().setHSL((0.72 - Math.max(0, Math.min(1, t)) * 0.72 + 1) % 1, 0.72, 0.55);
}

function ribbonColor(source: ProteinRenderSource, index: number, mode: ProteinRibbonColorMode): THREE.Color {
  const backbone = source.backbone;
  if (mode === 'rainbow') return rainbowColor(index / Math.max(1, backbone.backboneCount - 1));
  if (mode === 'secondary-structure') {
    const kind = backbone.backboneSecondary[index] ?? 'coil';
    return new THREE.Color(kind === 'helix' ? 0xe95f5f : kind === 'sheet' ? 0xffd75f : 0x78b9e8);
  }
  if (mode === 'b-factor') {
    const min = Math.min(...backbone.backboneBFactors);
    const max = Math.max(...backbone.backboneBFactors);
    return rainbowColor(((backbone.backboneBFactors[index] ?? min) - min) / Math.max(1e-6, max - min));
  }
  const key = mode === 'entity' || mode === 'component-role'
    ? backbone.backboneEntities[index] ?? 0
    : (backbone.backboneChains[index] ?? 'A').charCodeAt(0);
  return new THREE.Color(CHAIN_COLORS[Math.abs(key) % CHAIN_COLORS.length]!);
}

function backboneRuns(backbone: ProteinBackboneAsset): { points: THREE.Vector3[]; startIndex: number }[] {
  const runs: { points: THREE.Vector3[]; startIndex: number }[] = [];
  let current: { points: THREE.Vector3[]; startIndex: number } | null = null;
  for (let index = 0; index < backbone.backboneCount; index++) {
    const offset = index * 3;
    const point = new THREE.Vector3(
      backbone.backboneCoordinates[offset]!, backbone.backboneCoordinates[offset + 1]!, backbone.backboneCoordinates[offset + 2]!,
    );
    const previous = current?.points[current.points.length - 1];
    if (!current || !previous || point.distanceTo(previous) > 8
      || backbone.backboneChains[index] !== backbone.backboneChains[index - 1]) {
      current = { points: [], startIndex: index };
      runs.push(current);
    }
    current.points.push(point);
  }
  return runs;
}

function buildRibbon(source: ProteinRenderSource, mode: ProteinRibbonColorMode): THREE.Group {
  const group = new THREE.Group();
  for (const run of backboneRuns(source.backbone)) {
    if (run.points.length < 2) continue;
    const curve = new THREE.CatmullRomCurve3(run.points, false, 'centripetal', 0.35);
    const tubularSegments = Math.max(2, (run.points.length - 1) * 10);
    const radialSegments = 10;
    const geometry = new THREE.TubeGeometry(curve, tubularSegments, 0.44, radialSegments, false);
    const colors: number[] = [];
    const count = geometry.getAttribute('position').count;
    for (let vertex = 0; vertex < count; vertex++) {
      const longitudinal = Math.floor(vertex / (radialSegments + 1));
      const sourceIndex = Math.min(
        source.backbone.backboneCount - 1,
        Math.round(run.startIndex + (run.points.length - 1) * longitudinal / tubularSegments),
      );
      const color = ribbonColor(source, sourceIndex, mode);
      colors.push(color.r, color.g, color.b);
    }
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    const material = new THREE.MeshStandardMaterial({
      color: 0xffffff, vertexColors: true, roughness: 0.42, metalness: 0.24,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.userData.proteinComponent = source.backbone.backboneChains[run.startIndex] ?? 'A';
    mesh.userData.proteinRibbon = true;
    mesh.userData.proteinShadowReceiver = true;
    mesh.userData.ownsGeometry = true;
    mesh.userData.ownsMaterial = true;
    group.add(mesh);
  }
  return group;
}

function atomElement(structure: ProteinDisplayAsset, atom: number): string {
  return structure.atoms.elementTable[structure.atoms.elements[atom] ?? 1] ?? 'C';
}

function atomResidue(structure: ProteinDisplayAsset, atom: number): string {
  return structure.atoms.residueTable[structure.atoms.residues[atom] ?? 0] ?? '';
}

function atomMaterial(element: string, ligand = false): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: ELEMENT_COLORS[element.toUpperCase()] ?? 0xc0c0c0,
    emissive: ligand && element.toUpperCase() === 'FE' ? 0x7a1f00 : 0x000000,
    emissiveIntensity: ligand && element.toUpperCase() === 'FE' ? 0.9 : 0,
    roughness: 0.25,
    metalness: element.toUpperCase() === 'FE' ? 0.72 : 0.18,
  });
}

function buildAtoms(source: ProteinRenderSource, selected: ReadonlySet<number> | null, ligand = false): THREE.Group {
  const structure = source.structure;
  const group = new THREE.Group();
  const byElement = new Map<string, number[]>();
  for (let atom = 0; atom < structure.atoms.count; atom++) {
    if (selected && !selected.has(atom)) continue;
    const element = atomElement(structure, atom);
    const list = byElement.get(element) ?? [];
    list.push(atom);
    byElement.set(element, list);
  }
  for (const [element, atoms] of byElement) {
    const radiusCode = structure.atoms.radiusCodes[atoms[0]!] ?? 1;
    const baseRadius = structure.atoms.radiusTable[radiusCode] ?? 1.7;
    const radius = ligand && element === 'FE' ? baseRadius * 1.35 : baseRadius * (ligand ? 0.72 : 1);
    const mesh = new THREE.InstancedMesh(new THREE.SphereGeometry(radius, 10, 8), atomMaterial(element, ligand), atoms.length);
    const matrix = new THREE.Matrix4();
    atoms.forEach((atom, instance) => {
      const offset = atom * 3;
      matrix.makeTranslation(
        structure.atoms.coordinates[offset]!, structure.atoms.coordinates[offset + 1]!, structure.atoms.coordinates[offset + 2]!,
      );
      mesh.setMatrixAt(instance, matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.userData.proteinElement = element;
    mesh.userData.proteinLigand = ligand;
    mesh.userData.ownsGeometry = true;
    mesh.userData.ownsMaterial = true;
    group.add(mesh);
  }
  const bondPositions: number[] = [];
  for (let offset = 0; offset + 1 < structure.bonds.pairs.length; offset += 2) {
    const first = structure.bonds.pairs[offset]!;
    const second = structure.bonds.pairs[offset + 1]!;
    if (selected && (!selected.has(first) || !selected.has(second))) continue;
    const a = first * 3;
    const b = second * 3;
    bondPositions.push(
      structure.atoms.coordinates[a]!, structure.atoms.coordinates[a + 1]!, structure.atoms.coordinates[a + 2]!,
      structure.atoms.coordinates[b]!, structure.atoms.coordinates[b + 1]!, structure.atoms.coordinates[b + 2]!,
    );
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(bondPositions, 3));
  const bonds = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({
    color: ligand ? 0xffb45e : 0x778899, transparent: true, opacity: ligand ? 0.9 : 0.65,
  }));
  bonds.userData.ownsGeometry = true;
  bonds.userData.ownsMaterial = true;
  group.add(bonds);
  group.userData.proteinComponent = 'A';
  return group;
}

function buildLigands(source: ProteinRenderSource): THREE.Group {
  const residues = new Set(source.semantic.ligands.map((ligand) => ligand.residue.toUpperCase()));
  const selected = new Set<number>();
  for (let atom = 0; atom < source.structure.atoms.count; atom++) {
    if (residues.has(atomResidue(source.structure, atom).toUpperCase())) selected.add(atom);
  }
  const group = buildAtoms(source, selected, true);
  group.userData.proteinLigand = true;
  group.userData.proteinLigandIds = source.semantic.ligands.map((ligand) => ligand.id);
  return group;
}

function surfaceColor(value: number, mode: 'surface-charge' | 'hydrophobicity'): THREE.Color {
  const t = Math.max(0, Math.min(1, (value + 127) / 254));
  if (mode === 'surface-charge') {
    if (t < 0.5) return new THREE.Color(0xd84a4a).lerp(new THREE.Color(0xf4f0e8), t * 2);
    return new THREE.Color(0xf4f0e8).lerp(new THREE.Color(0x477fd1), (t - 0.5) * 2);
  }
  return new THREE.Color(0x4575b4).lerp(new THREE.Color(0xf7f7f7), Math.min(1, t * 2))
    .lerp(new THREE.Color(0xd95f02), Math.max(0, (t - 0.5) * 2));
}

function buildSilhouette(source: ProteinRenderSource, mode: 'surface-charge' | 'hydrophobicity'): THREE.Group {
  const group = new THREE.Group();
  group.add(buildRibbon(source, 'chain'));
  if (source.semantic.ligands.length) group.add(buildLigands(source));
  const surface = source.structure.surface.mesh;
  const values = mode === 'surface-charge' ? surface.charge : surface.hydrophobicity;
  const center = source.structure.coordinateFrame.centeredAt;
  const positions: number[] = [];
  const colors: number[] = [];
  for (let vertex = 0; vertex < surface.position.length / 3; vertex++) {
    positions.push(
      surface.position[vertex * 3]! - (center[0] ?? 0),
      surface.position[vertex * 3 + 1]! - (center[1] ?? 0),
      surface.position[vertex * 3 + 2]! - (center[2] ?? 0),
    );
    const color = surfaceColor(values[vertex] ?? 0, mode);
    colors.push(color.r, color.g, color.b);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(Array.from(surface.index));
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
    color: 0xffffff, vertexColors: true, roughness: 0.32, metalness: 0.08,
    side: THREE.DoubleSide, transparent: true, opacity: 0.28, depthWrite: false,
  }));
  mesh.renderOrder = 2;
  mesh.userData.proteinComponent = 'A';
  mesh.userData.proteinShadowOccluder = true;
  mesh.userData.ownsGeometry = true;
  mesh.userData.ownsMaterial = true;
  group.add(mesh);
  return group;
}

export function buildProteinRibbonShip(source: ProteinRenderSource, mode: ProteinRibbonColorMode): THREE.Group {
  const group = buildRibbon(source, mode);
  if (source.semantic.ligands.length) group.add(buildLigands(source));
  group.scale.setScalar(source.semantic.coordinateScale);
  markLitOpaque(group);
  markProteinShadowLayers(group);
  return group;
}

export function buildProteinEnemyShip(source: ProteinRenderSource, display: ProteinDisplaySettings): THREE.Group {
  let group: THREE.Group;
  if (display.representation === 'molecular') group = buildAtoms(source, null);
  else if (display.representation === 'silhouette') group = buildSilhouette(source, display.colorMode);
  else return buildProteinRibbonShip(source, display.colorMode);
  group.scale.setScalar(source.semantic.coordinateScale);
  markLitOpaque(group);
  markProteinShadowLayers(group);
  return group;
}

export function replaceProteinEnemyShip(target: THREE.Object3D, replacement: THREE.Object3D): void {
  for (const child of [...target.children]) {
    child.traverse((nested) => {
      const mesh = nested as THREE.Mesh;
      if (!mesh.isMesh && !(nested as THREE.Line).isLine) return;
      if (nested.userData.ownsGeometry) mesh.geometry.dispose();
      if (nested.userData.ownsMaterial) {
        if (Array.isArray(mesh.material)) mesh.material.forEach((material) => material.dispose());
        else mesh.material.dispose();
      }
    });
    target.remove(child);
  }
  for (const child of [...replacement.children]) target.add(child);
  replacement.clear();
}
