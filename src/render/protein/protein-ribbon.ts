// タンパク質の表示用 Cartoon リボンを生成する。
import * as THREE from 'three/webgpu';
import { proteinRibbonColor, triangleComponent } from './protein-ribbon-color';
import {
  attachProteinResidueBinding,
  proteinStandardMaterial,
  type ProteinMotionBinding,
} from './protein-motion-material';
import type { ProteinRibbonColorMode } from './protein-display';
import type { ProteinRenderSource } from './protein-render-definition';

/** 論文図向けの非金属 Ribbon 材質を返す。 */
function ribbonMaterial(motion?: ProteinMotionBinding): THREE.MeshStandardNodeMaterial {
  return proteinStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.68,
    metalness: 0,
    side: THREE.DoubleSide,
  }, motion);
}

/** 鎖1本ぶんの geometry を、リボンの印を付けた Mesh として group へ加える。ownsMaterial なら Mesh が材質を破棄する。 */
function addChainMesh(
  group: THREE.Group,
  geometry: THREE.BufferGeometry,
  material: THREE.MeshStandardNodeMaterial,
  ownsMaterial: boolean,
): void {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.userData.proteinRibbon = true;
  mesh.userData.ownsGeometry = true;
  mesh.userData.ownsMaterial = ownsMaterial;
  group.add(mesh);
}

interface RibbonChainPart {
  readonly positions: number[];
  readonly colors: number[];
  readonly residues: number[];
  readonly indices: number[];
  readonly vertices: Map<number, number>;
}

/** 焼き込み頂点を鎖のローカル頂点へ登録し、その索引を返す。同じ焼き込み頂点には同じ索引を返す。 */
function ribbonLocalVertex(
  part: RibbonChainPart, source: ProteinRenderSource, mode: ProteinRibbonColorMode,
  fixedColor: THREE.Color | null, residues: readonly number[], sourceVertex: number,
): number {
  const existing = part.vertices.get(sourceVertex);
  if (existing !== undefined) return existing;
  const local = part.vertices.size;
  part.vertices.set(sourceVertex, local);
  // 原子と同じ中心寄せ済みの系へ移す。
  const mesh = source.structure.ribbon.mesh;
  const center = source.structure.coordinateFrame.centeredAt;
  const offset = sourceVertex * 3;
  part.positions.push(
    mesh.position[offset]! - (center[0] ?? 0),
    mesh.position[offset + 1]! - (center[1] ?? 0),
    mesh.position[offset + 2]! - (center[2] ?? 0),
  );
  // 色分けは実行時に切り替わるので、残基から都度求める。
  const residue = residues[sourceVertex] ?? 0;
  const color = fixedColor ?? proteinRibbonColor(source, residue, mode);
  part.colors.push(color.r, color.g, color.b);
  part.residues.push(residue);
  return local;
}

/** 焼き込み済みのリボンメッシュを鎖ごとに分けて着色し、残基変位を結ぶ。fixedColor を与えれば全頂点をその色にする。 */
export function buildProteinRibbon(
  source: ProteinRenderSource, mode: ProteinRibbonColorMode, fixedColor: THREE.Color | null = null,
  motion?: ProteinMotionBinding,
): THREE.Group {
  const group = new THREE.Group();
  const mesh = source.structure.ribbon.mesh;
  const residues = source.motion.bindings.ribbonResidues;
  // 三角形を、頂点の鎖の多数決で鎖ごとに振り分ける。
  const parts = new Map<string, RibbonChainPart>();
  for (let offset = 0; offset + 2 < mesh.index.length; offset += 3) {
    const triangle = [mesh.index[offset]!, mesh.index[offset + 1]!, mesh.index[offset + 2]!] as const;
    const chain = triangleComponent(mesh.chain, ...triangle);
    const part: RibbonChainPart = parts.get(chain) ?? { positions: [], colors: [], residues: [], indices: [], vertices: new Map() };
    parts.set(chain, part);
    for (const vertex of triangle) part.indices.push(ribbonLocalVertex(part, source, mode, fixedColor, residues, vertex));
  }
  // 材質は最初の mesh を作るときに作り、その mesh に破棄を任せる。
  let material: THREE.MeshStandardNodeMaterial | null = null;
  for (const part of parts.values()) {
    if (part.indices.length === 0) continue;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(part.positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(part.colors, 3));
    geometry.setIndex(part.indices);
    attachProteinResidueBinding(geometry, part.residues);
    geometry.computeVertexNormals();
    const ownsMaterial = material === null;
    material ??= ribbonMaterial(motion);
    addChainMesh(group, geometry, material, ownsMaterial);
  }
  return group;
}

