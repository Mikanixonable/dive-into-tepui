import * as THREE from 'three/webgpu';
import type { ProteinAssetDefinition, ProteinMotionAsset } from '../game/protein/protein-schema';
import type { ProteinDisplayAsset } from '../game/protein/protein-display-asset';
import type { ProteinDisplaySettings, ProteinRibbonColorMode } from '../game/protein/protein-display';
import {
  attachProteinInstancedResidueBinding,
  attachProteinResidueBinding,
  proteinLineMaterial,
  proteinStandardMaterial,
  type ProteinMotionBinding,
} from './protein-motion-material';
import { markLitOpaque, markProteinShadowLayers } from './pipeline/lit-layer';

export interface ProteinBackboneAsset {
  readonly backboneCount: number;
  readonly backboneCoordinates: readonly number[];
  /** Carbonyl oxygen coordinates, used as a stable ribbon-width reference. */
  readonly backboneOCoordinates?: readonly number[];
  readonly backboneSecondary: readonly string[];
  readonly backboneChains: readonly string[];
  readonly backboneEntities: readonly number[];
  readonly backboneBFactors: readonly number[];
}

export interface ProteinRenderSource {
  readonly semantic: ProteinAssetDefinition;
  readonly motion: ProteinMotionAsset;
  readonly backbone: ProteinBackboneAsset;
  readonly structure: ProteinDisplayAsset;
}

function validateMotionBinding(source: ProteinRenderSource, motion?: ProteinMotionBinding): void {
  if (motion && motion.residueCount !== source.motion.residueCount) {
    throw new Error(`Protein motion binding residueCount ${motion.residueCount} does not match asset ${source.motion.residueCount}`);
  }
}

/** Keep the Å-to-object conversion below the enemy root, whose scale is game-owned. */
function proteinCoordinateRoot(structure: THREE.Group, coordinateScale: number): THREE.Group {
  const root = new THREE.Group();
  structure.scale.setScalar(coordinateScale);
  structure.userData.proteinStructureRoot = true;
  root.add(structure);
  return root;
}

const ELEMENT_COLORS: Readonly<Record<string, number>> = {
  H: 0xffffff, C: 0x909090, N: 0x3050f8, O: 0xff0d0d, F: 0x90e050,
  P: 0xff8000, S: 0xffff30, CL: 0x1ff01f, SE: 0xffa100, MG: 0x8aff00,
  ZN: 0x7d80b0, NA: 0xab5cf2, CA: 0x3dff00, FE: 0xe06633, K: 0x8f40d4,
};
const COMPONENT_ROLE_COLORS = [0x4fc3f7, 0xa78bfa, 0xffc857, 0x56df9b, 0xff6b91, 0xb7e06b];
const RIBBON_SUBDIVISIONS = 12;
const RIBBON_THICKNESS = 0.32;
const bFactorRanges = new WeakMap<object, { min: number; max: number }>();
const componentRoleLookups = new WeakMap<object, {
  byEntity: ReadonlyMap<number, number>;
  byChain: ReadonlyMap<string, number>;
}>();
const residueBindingLookups = new WeakMap<object, ProteinResidueBindingLookup>();

interface ProteinResidueBindingLookup {
  readonly atomResidues: readonly number[];
  readonly surfaceResidues: readonly number[];
}

type ProteinSecondaryKind = 'coil' | 'helix' | 'sheet';

function secondaryKind(value: string | undefined): ProteinSecondaryKind {
  const normalized = value?.toLowerCase();
  if (normalized === 'helix' || normalized === 'h' || normalized === 'alpha-helix') return 'helix';
  if (normalized === 'sheet' || normalized === 'e' || normalized === 'beta-sheet') return 'sheet';
  return 'coil';
}

function rainbowColor(t: number): THREE.Color {
  return new THREE.Color().setHSL(0.66 * (1 - Math.max(0, Math.min(1, t))), 0.86, 0.56);
}

function componentRoleColor(source: ProteinRenderSource, index: number): THREE.Color {
  let lookup = componentRoleLookups.get(source);
  if (!lookup) {
    const roles = [...new Set(source.semantic.components.map((component) => component.role))];
    const byEntity = new Map<number, number>();
    const byChain = new Map<string, number>();
    for (const component of source.semantic.components) {
      const roleIndex = Math.max(0, roles.indexOf(component.role));
      for (const entity of component.entities ?? []) byEntity.set(entity, roleIndex);
      for (const chain of component.chains) byChain.set(chain, roleIndex);
    }
    lookup = { byEntity, byChain };
    componentRoleLookups.set(source, lookup);
  }
  const entity = source.backbone.backboneEntities[index];
  const chain = source.backbone.backboneChains[index];
  const roleIndex = (entity === undefined ? undefined : lookup.byEntity.get(entity))
    ?? (chain === undefined ? undefined : lookup.byChain.get(chain))
    ?? 0;
  return new THREE.Color(COMPONENT_ROLE_COLORS[roleIndex % COMPONENT_ROLE_COLORS.length]!);
}

function ribbonColor(source: ProteinRenderSource, index: number, mode: ProteinRibbonColorMode): THREE.Color {
  const backbone = source.backbone;
  if (mode === 'rainbow') return rainbowColor(index / Math.max(1, backbone.backboneCount - 1));
  if (mode === 'secondary-structure') {
    const kind = secondaryKind(backbone.backboneSecondary[index]);
    return new THREE.Color(kind === 'helix' ? 0xe85d75 : kind === 'sheet' ? 0xf2c14e : 0x8fa7bd);
  }
  if (mode === 'b-factor') {
    let range = bFactorRanges.get(backbone);
    if (!range) {
      range = { min: Math.min(...backbone.backboneBFactors), max: Math.max(...backbone.backboneBFactors) };
      bFactorRanges.set(backbone, range);
    }
    const { min, max } = range;
    return rainbowColor(((backbone.backboneBFactors[index] ?? min) - min) / Math.max(1e-6, max - min));
  }
  if (mode === 'component-role') return componentRoleColor(source, index);
  if (mode === 'entity') {
    const entity = backbone.backboneEntities[index] ?? 1;
    return new THREE.Color().setHSL(((entity - 1) * 0.19 + 0.04) % 1, 0.78, 0.56);
  }
  const chain = backbone.backboneChains[index] ?? 'A';
  const chainIndex = Math.max(0, chain.charCodeAt(0) - 65);
  return new THREE.Color().setHSL((chainIndex * 0.13 + 0.02) % 1, 0.78, 0.56);
}

function backboneRuns(backbone: ProteinBackboneAsset): {
  kind: ProteinSecondaryKind;
  points: THREE.Vector3[];
  startIndex: number;
}[] {
  const runs: { kind: ProteinSecondaryKind; points: THREE.Vector3[]; startIndex: number }[] = [];
  let current: { kind: ProteinSecondaryKind; points: THREE.Vector3[]; startIndex: number } | null = null;
  for (let index = 0; index < backbone.backboneCount; index++) {
    const offset = index * 3;
    const point = new THREE.Vector3(
      backbone.backboneCoordinates[offset]!, backbone.backboneCoordinates[offset + 1]!, backbone.backboneCoordinates[offset + 2]!,
    );
    const previous = current?.points[current.points.length - 1];
    const kind = secondaryKind(backbone.backboneSecondary[index]);
    if (!current || !previous || point.distanceTo(previous) > 8
      || backbone.backboneChains[index] !== backbone.backboneChains[index - 1]
      || current.kind !== kind) {
      current = { kind, points: [], startIndex: index };
      runs.push(current);
    }
    current.points.push(point);
  }
  return runs;
}

function helixFrame(points: readonly THREE.Vector3[]): { center: THREE.Vector3; axis: THREE.Vector3 } {
  const center = points.reduce((sum, point) => sum.add(point), new THREE.Vector3()).multiplyScalar(1 / points.length);
  let axis = points[points.length - 1]!.clone().sub(points[0]!).normalize();
  if (axis.lengthSq() < 1e-8) axis.set(0, 0, 1);
  for (let iteration = 0; iteration < 8; iteration++) {
    const next = new THREE.Vector3();
    for (const point of points) {
      const offset = point.clone().sub(center);
      next.addScaledVector(offset, offset.dot(axis));
    }
    if (next.lengthSq() < 1e-8) break;
    axis.copy(next.normalize());
  }
  if (axis.dot(points[points.length - 1]!.clone().sub(points[0]!)) < 0) axis.negate();
  return { center, axis };
}

function backboneO(backbone: ProteinBackboneAsset, index: number, fallback: THREE.Vector3): THREE.Vector3 {
  const coordinates = backbone.backboneOCoordinates;
  const offset = index * 3;
  if (!coordinates || offset + 2 >= coordinates.length) return fallback.clone();
  return new THREE.Vector3(coordinates[offset]!, coordinates[offset + 1]!, coordinates[offset + 2]!);
}

function ribbonGeometry(
  source: ProteinRenderSource,
  run: { kind: ProteinSecondaryKind; points: readonly THREE.Vector3[]; startIndex: number },
  mode: ProteinRibbonColorMode,
  fixedColor: THREE.Color | null,
): THREE.BufferGeometry {
  const { backbone } = source;
  const positions: number[] = [];
  const colors: number[] = [];
  const residueA: number[] = [];
  const residueB: number[] = [];
  const residueT: number[] = [];
  const curve = new THREE.CatmullRomCurve3([...run.points], false, 'centripetal', 0.35);
  const segments = Math.max(1, (run.points.length - 1) * RIBBON_SUBDIVISIONS);
  const frame = run.kind === 'helix' ? helixFrame(run.points) : null;
  let previousTangent: THREE.Vector3 | null = null;
  let previousWidthDirection: THREE.Vector3 | null = null;

  for (let sample = 0; sample <= segments; sample++) {
    const t = sample / segments;
    const center = curve.getPoint(t);
    const tangent = curve.getTangent(t).normalize();
    const residuePosition = t * (run.points.length - 1);
    const localIndex = Math.min(run.points.length - 1, Math.floor(residuePosition));
    const nextIndex = Math.min(run.points.length - 1, localIndex + 1);
    const localT = residuePosition - localIndex;
    const sourceIndex = Math.min(backbone.backboneCount - 1, Math.round(run.startIndex + residuePosition));
    const oxygen = backboneO(backbone, run.startIndex + localIndex, center);
    if (nextIndex !== localIndex) {
      oxygen.lerp(backboneO(backbone, run.startIndex + nextIndex, center), localT);
    }

    let candidateWidthDirection: THREE.Vector3;
    if (frame !== null) {
      const radial = center.clone().sub(frame.center).projectOnPlane(frame.axis).normalize();
      candidateWidthDirection = frame.axis.clone().cross(radial).projectOnPlane(tangent).normalize();
    } else {
      candidateWidthDirection = oxygen.sub(center).projectOnPlane(tangent).normalize();
    }
    const widthDirection = candidateWidthDirection.clone();
    if (widthDirection.lengthSq() < 1e-8) {
      const reference = Math.abs(tangent.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
      widthDirection.copy(reference).projectOnPlane(tangent).normalize();
    }
    if (previousTangent !== null && previousWidthDirection !== null) {
      const transport = previousWidthDirection.clone()
        .applyQuaternion(new THREE.Quaternion().setFromUnitVectors(previousTangent, tangent))
        .projectOnPlane(tangent).normalize();
      if (candidateWidthDirection.lengthSq() >= 1e-8 && candidateWidthDirection.dot(transport) < 0) widthDirection.negate();
      widthDirection.lerp(transport, 0.25).normalize();
    }
    previousTangent = tangent.clone();
    previousWidthDirection = widthDirection.clone();

    const thicknessDirection = tangent.clone().cross(widthDirection).normalize();
    const arrowFactor = run.kind === 'sheet' && residuePosition >= run.points.length - 2
      ? Math.max(0.04, 1.15 * (run.points.length - 1 - residuePosition))
      : 1;
    const halfWidth = ((run.kind === 'helix' ? 2.0 : 1.8) * arrowFactor) / 2;
    const halfThickness = (RIBBON_THICKNESS * Math.min(1, arrowFactor)) / 2;
    const corners = [
      center.clone().addScaledVector(widthDirection, halfWidth).addScaledVector(thicknessDirection, halfThickness),
      center.clone().addScaledVector(widthDirection, -halfWidth).addScaledVector(thicknessDirection, halfThickness),
      center.clone().addScaledVector(widthDirection, -halfWidth).addScaledVector(thicknessDirection, -halfThickness),
      center.clone().addScaledVector(widthDirection, halfWidth).addScaledVector(thicknessDirection, -halfThickness),
    ];
    for (const corner of corners) positions.push(corner.x, corner.y, corner.z);
    for (let corner = 0; corner < 4; corner += 1) {
      const backboneA = run.startIndex + localIndex;
      const backboneB = run.startIndex + nextIndex;
      residueA.push(source.motion.bindings.backboneResidues[backboneA] ?? backboneA);
      residueB.push(source.motion.bindings.backboneResidues[backboneB] ?? backboneB);
      residueT.push(localT);
    }
    const color = fixedColor ?? ribbonColor(source, sourceIndex, mode);
    for (let corner = 0; corner < 4; corner++) colors.push(color.r, color.g, color.b);
  }

  const indices: number[] = [];
  for (let index = 0; index < segments; index++) {
    const a = index * 4;
    const b = a + 4;
    indices.push(a, b, a + 1, a + 1, b, b + 1);
    indices.push(a + 3, a + 2, b + 3, a + 2, b + 2, b + 3);
    indices.push(a, a + 3, b, a + 3, b + 3, b);
    indices.push(a + 1, b + 1, a + 2, a + 2, b + 1, b + 2);
  }
  indices.push(0, 1, 2, 0, 2, 3);
  const end = segments * 4;
  indices.push(end, end + 2, end + 1, end, end + 3, end + 2);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  attachProteinResidueBinding(geometry, residueA, residueB, residueT);
  geometry.computeVertexNormals();
  geometry.userData.proteinSecondary = run.kind;
  geometry.userData.proteinSecondaryKind = run.kind;
  return geometry;
}

function tubeColors(
  source: ProteinRenderSource, geometry: THREE.BufferGeometry, startIndex: number,
  pointCount: number, tubularSegments: number, mode: ProteinRibbonColorMode, fixedColor: THREE.Color | null,
): void {
  const radialSegments = 12;
  const colors: number[] = [];
  for (let vertex = 0; vertex < geometry.getAttribute('position').count; vertex++) {
    const longitudinal = Math.floor(vertex / (radialSegments + 1));
    const index = Math.min(source.backbone.backboneCount - 1,
      Math.round(startIndex + (pointCount - 1) * longitudinal / tubularSegments));
    const color = fixedColor ?? ribbonColor(source, index, mode);
    colors.push(color.r, color.g, color.b);
  }
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
}

function tubeResidueBinding(
  geometry: THREE.BufferGeometry,
  startIndex: number,
  pointCount: number,
  tubularSegments: number,
  backboneResidues: readonly number[],
): void {
  const radialSegments = 12;
  const residueA: number[] = [];
  const residueB: number[] = [];
  const residueT: number[] = [];
  for (let vertex = 0; vertex < geometry.getAttribute('position').count; vertex += 1) {
    const longitudinal = Math.floor(vertex / (radialSegments + 1));
    const residuePosition = (pointCount - 1) * longitudinal / tubularSegments;
    const localIndex = Math.min(pointCount - 1, Math.floor(residuePosition));
    const nextIndex = Math.min(pointCount - 1, localIndex + 1);
    residueA.push(backboneResidues[startIndex + localIndex] ?? startIndex + localIndex);
    residueB.push(backboneResidues[startIndex + nextIndex] ?? startIndex + nextIndex);
    residueT.push(residuePosition - localIndex);
  }
  attachProteinResidueBinding(geometry, residueA, residueB, residueT);
}

function buildRibbon(
  source: ProteinRenderSource,
  mode: ProteinRibbonColorMode,
  fixedColor: THREE.Color | null = null,
  motion?: ProteinMotionBinding,
): THREE.Group {
  const group = new THREE.Group();
  for (const run of backboneRuns(source.backbone)) {
    if (run.points.length < 2) continue;
    let geometry: THREE.BufferGeometry;
    if (run.kind === 'helix' || run.kind === 'sheet') {
      geometry = ribbonGeometry(source, run, mode, fixedColor);
    } else {
      const curve = new THREE.CatmullRomCurve3(run.points, false, 'centripetal', 0.35);
      const tubularSegments = Math.max(2, (run.points.length - 1) * RIBBON_SUBDIVISIONS);
      geometry = new THREE.TubeGeometry(curve, tubularSegments, 0.38, 12, false);
      tubeColors(source, geometry, run.startIndex, run.points.length, tubularSegments, mode, fixedColor);
      tubeResidueBinding(geometry, run.startIndex, run.points.length, tubularSegments, source.motion.bindings.backboneResidues);
      geometry.userData.proteinSecondary = run.kind;
      geometry.userData.proteinSecondaryKind = run.kind;
    }
    const material = proteinStandardMaterial({
      color: 0xffffff, vertexColors: true, roughness: 0.42, metalness: 0.24,
      side: THREE.DoubleSide,
    }, motion);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.userData.proteinComponent = source.backbone.backboneChains[run.startIndex] ?? 'A';
    mesh.userData.proteinRibbon = true;
    mesh.userData.proteinSecondary = run.kind;
    mesh.userData.proteinSecondaryKind = run.kind;
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

function residueBindingLookup(source: ProteinRenderSource): ProteinResidueBindingLookup {
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

function buildAtoms(
  source: ProteinRenderSource,
  selected: ReadonlySet<number> | null,
  ligand = false,
  motion?: ProteinMotionBinding,
): THREE.Group {
  const structure = source.structure;
  const bindings = residueBindingLookup(source);
  const group = new THREE.Group();
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
      const mesh = new THREE.InstancedMesh(new THREE.SphereGeometry(radius, 10, 8), atomMaterial(element, ligand, motion), atoms.length);
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
      mesh.userData.ownsMaterial = true;
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
  for (const [chain, bondPositions] of bondPositionsByChain) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(bondPositions, 3));
    const bondResidues = bondResiduesByChain.get(chain) ?? [];
    attachProteinResidueBinding(geometry, bondResidues);
    const bonds = new THREE.LineSegments(geometry, proteinLineMaterial({
      color: ligand ? 0xffb45e : 0x778899, transparent: true, opacity: ligand ? 0.9 : 0.65,
    }, motion));
    bonds.userData.proteinComponent = chain;
    bonds.userData.proteinLigand = ligand;
    bonds.userData.ownsGeometry = true;
    bonds.userData.ownsMaterial = true;
    group.add(bonds);
  }
  return group;
}

function buildLigands(source: ProteinRenderSource, motion?: ProteinMotionBinding): THREE.Group {
  const residues = new Set(source.semantic.ligands.map((ligand) => ligand.residue.toUpperCase()));
  const selected = new Set<number>();
  for (let atom = 0; atom < source.structure.atoms.count; atom++) {
    if (residues.has(atomResidue(source.structure, atom).toUpperCase())) selected.add(atom);
  }
  const group = buildAtoms(source, selected, true, motion);
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

function triangleComponent(components: readonly string[], a: number, b: number, c: number): string {
  const first = components[a] ?? 'A';
  const second = components[b] ?? first;
  const third = components[c] ?? first;
  if (first === second || first === third) return first;
  if (second === third) return second;
  return first;
}

interface ProteinSurfacePart {
  readonly positions: number[];
  readonly colors: number[];
  readonly indices: number[];
  readonly vertices: Map<number, number>;
}

function buildSilhouette(
  source: ProteinRenderSource,
  mode: 'surface-charge' | 'hydrophobicity',
  motion?: ProteinMotionBinding,
): THREE.Group {
  const group = new THREE.Group();
  // The shell carries the selected scalar field; the internal cartoon stays white so
  // it remains legible through the translucent surface in every protein asset.
  group.add(buildRibbon(source, 'chain', new THREE.Color(0xffffff), motion));
  if (source.semantic.ligands.length) group.add(buildLigands(source, motion));
  const surface = source.structure.surface.mesh;
  const bindings = residueBindingLookup(source);
  const values = mode === 'surface-charge' ? surface.charge : surface.hydrophobicity;
  const center = source.structure.coordinateFrame.centeredAt;
  const parts = new Map<string, ProteinSurfacePart>();
  for (let offset = 0; offset + 2 < surface.index.length; offset += 3) {
    const triangle = [surface.index[offset]!, surface.index[offset + 1]!, surface.index[offset + 2]!] as const;
    const component = triangleComponent(surface.component, ...triangle);
    const part: ProteinSurfacePart = parts.get(component) ?? {
      positions: [], colors: [], indices: [], vertices: new Map<number, number>(),
    };
    for (const sourceVertex of triangle) {
      let localVertex = part.vertices.get(sourceVertex);
      if (localVertex === undefined) {
        localVertex = part.vertices.size;
        part.vertices.set(sourceVertex, localVertex);
        part.positions.push(
          surface.position[sourceVertex * 3]! - (center[0] ?? 0),
          surface.position[sourceVertex * 3 + 1]! - (center[1] ?? 0),
          surface.position[sourceVertex * 3 + 2]! - (center[2] ?? 0),
        );
        const color = surfaceColor(values[sourceVertex] ?? 0, mode);
        part.colors.push(color.r, color.g, color.b);
      }
      part.indices.push(localVertex);
    }
    parts.set(component, part);
  }
  for (const [component, part] of parts) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(part.positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(part.colors, 3));
    geometry.setIndex(part.indices);
    const residueIndices = [...part.vertices.keys()].map((vertex) => bindings.surfaceResidues[vertex] ?? 0);
    attachProteinResidueBinding(geometry, residueIndices);
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, proteinStandardMaterial({
      color: 0xffffff, vertexColors: true, roughness: 0.32, metalness: 0.08,
      side: THREE.DoubleSide, transparent: true, opacity: 0.28, depthWrite: false,
    }, motion));
    mesh.renderOrder = 2;
    mesh.userData.proteinComponent = component;
    mesh.userData.proteinShadowOccluder = true;
    mesh.userData.ownsGeometry = true;
    mesh.userData.ownsMaterial = true;
    group.add(mesh);
  }
  return group;
}

export function buildProteinRibbonShip(
  source: ProteinRenderSource,
  mode: ProteinRibbonColorMode,
  fixedColor: THREE.Color | null = null,
  motion?: ProteinMotionBinding,
): THREE.Group {
  validateMotionBinding(source, motion);
  const structure = buildRibbon(source, mode, fixedColor, motion);
  if (source.semantic.ligands.length) structure.add(buildLigands(source, motion));
  const root = proteinCoordinateRoot(structure, source.semantic.coordinateScale);
  markLitOpaque(root);
  markProteinShadowLayers(root);
  return root;
}

export function buildProteinEnemyShip(
  source: ProteinRenderSource,
  display: ProteinDisplaySettings,
  motion?: ProteinMotionBinding,
): THREE.Group {
  validateMotionBinding(source, motion);
  let structure: THREE.Group;
  if (display.representation === 'molecular') structure = buildAtoms(source, null, false, motion);
  else if (display.representation === 'silhouette') structure = buildSilhouette(source, display.colorMode, motion);
  else return buildProteinRibbonShip(source, display.colorMode, null, motion);
  const root = proteinCoordinateRoot(structure, source.semantic.coordinateScale);
  markLitOpaque(root);
  // The translucent shell must be composited by the world pass. Keeping it in the
  // opaque GBuffer would overwrite the internal ribbon's depth and normal data.
  if (display.representation === 'silhouette') {
    root.traverse((child) => {
      if (child.userData.proteinShadowOccluder === true) child.layers.set(0);
    });
  }
  markProteinShadowLayers(root);
  return root;
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
