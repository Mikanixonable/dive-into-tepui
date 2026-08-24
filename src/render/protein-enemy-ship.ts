// タンパク質敵の原子・リボン・分子表面表示を組み立てる。
import * as THREE from 'three/webgpu';
import type { ProteinDisplayAsset } from '../game/protein/protein-display-asset';
import type { ProteinDisplaySettings, ProteinRibbonColorMode } from '../game/protein/protein-display';
import { markLitOpaque, markProteinShadowLayers } from './pipeline/lit-layer';
import {
  buildProteinRibbon,
  type ProteinRenderSource,
} from './protein-ribbon';

export type { ProteinBackboneAsset, ProteinRenderSource } from './protein-ribbon';

const ELEMENT_COLORS: Readonly<Record<string, number>> = {
  H: 0xffffff, C: 0x909090, N: 0x3050f8, O: 0xff0d0d, F: 0x90e050,
  P: 0xff8000, S: 0xffff30, CL: 0x1ff01f, SE: 0xffa100, MG: 0x8aff00,
  ZN: 0x7d80b0, NA: 0xab5cf2, CA: 0x3dff00, FE: 0xe06633, K: 0x8f40d4,
};

/** atom の元素記号をテーブルから復元する。 */
function atomElement(structure: ProteinDisplayAsset, atom: number): string {
  return structure.atoms.elementTable[structure.atoms.elements[atom] ?? 1] ?? 'C';
}

/** atom の residue 名をテーブルから復元する。 */
function atomResidue(structure: ProteinDisplayAsset, atom: number): string {
  return structure.atoms.residueTable[structure.atoms.residues[atom] ?? 0] ?? '';
}

/** atom の chain ID をテーブルから復元する。 */
function atomChain(structure: ProteinDisplayAsset, atom: number): string {
  return structure.atoms.chainTable[structure.atoms.chains[atom] ?? 0] ?? 'A';
}

/** 元素とリガンド状態に対応する原子材質を返す。 */
function atomMaterial(element: string, ligand = false): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: ELEMENT_COLORS[element.toUpperCase()] ?? 0xc0c0c0,
    emissive: ligand && element.toUpperCase() === 'FE' ? 0x7a1f00 : 0x000000,
    emissiveIntensity: ligand && element.toUpperCase() === 'FE' ? 0.9 : 0,
    roughness: 0.25,
    metalness: element.toUpperCase() === 'FE' ? 0.72 : 0.18,
  });
}

/** 選択した atom を鎖・元素別の InstancedMesh と結合線へ変換する。 */
function buildAtoms(source: ProteinRenderSource, selected: ReadonlySet<number> | null, ligand = false): THREE.Group {
  const structure = source.structure;
  const group = new THREE.Group();
  const byChain = new Map<string, Map<string, number[]>>();
  // 同じ材質と半径を共有できる atom を鎖・元素単位にまとめる。
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
      chainGroup.add(mesh);
    }
    group.add(chainGroup);
  }

  const bondPositionsByChain = new Map<string, number[]>();
  // 選択集合の内部だけにある結合を鎖別の LineSegments へまとめる。
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
  }
  for (const [chain, bondPositions] of bondPositionsByChain) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(bondPositions, 3));
    const bonds = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({
      color: ligand ? 0xffb45e : 0x778899, transparent: true, opacity: ligand ? 0.9 : 0.65,
    }));
    bonds.userData.proteinComponent = chain;
    bonds.userData.proteinLigand = ligand;
    bonds.userData.ownsGeometry = true;
    bonds.userData.ownsMaterial = true;
    group.add(bonds);
  }
  return group;
}

/** semantic 定義に列挙された residue の原子表示を生成する。 */
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

/** 分子表面のスカラー値を選択モードの発散色へ写像する。 */
function surfaceColor(value: number, mode: 'surface-charge' | 'hydrophobicity'): THREE.Color {
  const t = Math.max(0, Math.min(1, (value + 127) / 254));
  if (mode === 'surface-charge') {
    if (t < 0.5) return new THREE.Color(0xd84a4a).lerp(new THREE.Color(0xf4f0e8), t * 2);
    return new THREE.Color(0xf4f0e8).lerp(new THREE.Color(0x477fd1), (t - 0.5) * 2);
  }
  return new THREE.Color(0x4575b4).lerp(new THREE.Color(0xf7f7f7), Math.min(1, t * 2))
    .lerp(new THREE.Color(0xd95f02), Math.max(0, (t - 0.5) * 2));
}

/** 三角形の頂点多数決から所属 component を決める。 */
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

/** 半透明分子表面、白色 Ribbon、リガンドを重ねた表示を生成する。 */
function buildSilhouette(source: ProteinRenderSource, mode: 'surface-charge' | 'hydrophobicity'): THREE.Group {
  const group = new THREE.Group();
  // シェルは選択したスカラー場を示し、内部 Ribbon は半透明面越しにも読める白色にする。
  group.add(buildProteinRibbon(source, 'chain', new THREE.Color(0xffffff)));
  if (source.semantic.ligands.length) group.add(buildLigands(source));
  const surface = source.structure.surface.mesh;
  const values = mode === 'surface-charge' ? surface.charge : surface.hydrophobicity;
  const center = source.structure.coordinateFrame.centeredAt;
  const parts = new Map<string, ProteinSurfacePart>();
  // component ごとに頂点を再配置し、運動制御できる独立 Mesh に分ける。
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
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
      color: 0xffffff, vertexColors: true, roughness: 0.32, metalness: 0.08,
      side: THREE.DoubleSide, transparent: true, opacity: 0.28, depthWrite: false,
    }));
    mesh.renderOrder = 2;
    mesh.userData.proteinComponent = component;
    mesh.userData.proteinShadowOccluder = true;
    mesh.userData.ownsGeometry = true;
    mesh.userData.ownsMaterial = true;
    group.add(mesh);
  }
  return group;
}

/** リボンとリガンドをゲーム座標の縮尺で構築する。 */
export function buildProteinRibbonShip(
  source: ProteinRenderSource, mode: ProteinRibbonColorMode, fixedColor: THREE.Color | null = null,
): THREE.Group {
  const group = buildProteinRibbon(source, mode, fixedColor);
  if (source.semantic.ligands.length) group.add(buildLigands(source));
  group.scale.setScalar(source.semantic.coordinateScale);
  markLitOpaque(group);
  markProteinShadowLayers(group);
  return group;
}

/** 表示設定に対応するタンパク質敵の Object3D を構築する。 */
export function buildProteinEnemyShip(source: ProteinRenderSource, display: ProteinDisplaySettings): THREE.Group {
  let group: THREE.Group;
  if (display.representation === 'molecular') group = buildAtoms(source, null);
  else if (display.representation === 'silhouette') group = buildSilhouette(source, display.colorMode);
  else return buildProteinRibbonShip(source, display.colorMode);
  group.scale.setScalar(source.semantic.coordinateScale);
  markLitOpaque(group);
  // 半透明シェルは World pass で合成し、内部 Ribbon の深度・法線を保つ。
  if (display.representation === 'silhouette') {
    group.traverse((child) => {
      if (child.userData.proteinShadowOccluder === true) child.layers.set(0);
    });
  }
  markProteinShadowLayers(group);
  return group;
}

/** target の所有リソースを破棄し、replacement の子要素へ入れ替える。 */
export function replaceProteinEnemyShip(target: THREE.Object3D, replacement: THREE.Object3D): void {
  // target が所有する geometry と material だけを表示ツリーから回収する。
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
