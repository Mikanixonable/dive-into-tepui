import * as THREE from 'three/webgpu';
import type { ProteinSilhouetteColorMode } from '../game/protein/protein-display';
import {
  attachProteinResidueBinding,
  proteinStandardMaterial,
  type ProteinMotionBinding,
} from './protein-motion-material';
import { buildProteinLigands, proteinResidueBindingLookup } from './protein-atom-view';
import { buildProteinRibbon, type ProteinRenderSource } from './protein-ribbon';
import { triangleComponent } from './protein-ribbon-color';

function surfaceColor(value: number, mode: ProteinSilhouetteColorMode): THREE.Color {
  const t = Math.max(0, Math.min(1, (value + 127) / 254));
  if (mode === 'surface-charge') {
    if (t < 0.5) return new THREE.Color(0xd84a4a).lerp(new THREE.Color(0xf4f0e8), t * 2);
    return new THREE.Color(0xf4f0e8).lerp(new THREE.Color(0x477fd1), (t - 0.5) * 2);
  }
  return new THREE.Color(0x4575b4).lerp(new THREE.Color(0xf7f7f7), Math.min(1, t * 2))
    .lerp(new THREE.Color(0xd95f02), Math.max(0, (t - 0.5) * 2));
}

interface ProteinSurfacePart {
  readonly positions: number[];
  readonly colors: number[];
  readonly indices: number[];
  readonly vertices: Map<number, number>;
}

export function buildProteinSilhouette(
  source: ProteinRenderSource,
  mode: ProteinSilhouetteColorMode,
  motion?: ProteinMotionBinding,
): THREE.Group {
  const group = new THREE.Group();
  // The shell carries the selected scalar field; the internal cartoon stays white so
  // it remains legible through the translucent surface in every protein asset.
  group.add(buildProteinRibbon(source, 'chain', new THREE.Color(0xffffff), motion));
  if (source.semantic.ligands.length) group.add(buildProteinLigands(source, motion));
  const surface = source.structure.surface.mesh;
  const bindings = proteinResidueBindingLookup(source);
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
