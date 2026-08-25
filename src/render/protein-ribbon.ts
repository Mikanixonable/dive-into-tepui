// タンパク質の表示用 Cartoon と衝突判定用リボンを生成する。
import * as THREE from 'three/webgpu';
import type { ProteinAssetDefinition, ProteinMotionAsset } from '../game/protein/protein-schema';
import type { ProteinDisplayAsset } from '../game/protein/protein-display-asset';
import type { ProteinRibbonColorMode } from '../game/protein/protein-display';
import { proteinRibbonColor, triangleComponent } from './protein-ribbon-color';
import {
  attachProteinResidueBinding,
  proteinStandardMaterial,
  type ProteinMotionBinding,
} from './protein-motion-material';
export interface ProteinBackboneAsset {
  readonly backboneCount: number;
  readonly backboneCoordinates: readonly number[];
  /** カルボニル酸素の座標。Ribbon の幅方向を定める。 */
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

/** 鎖1本ぶんの geometry を、衝突判定と影が読むタグ付き Mesh として group へ追加する。material の dispose は最初の Mesh だけが持つ。 */
function addChainMesh(
  group: THREE.Group,
  geometry: THREE.BufferGeometry,
  material: THREE.MeshStandardNodeMaterial,
  ownsMaterial: boolean,
): void {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.userData.proteinRibbon = true;
  mesh.userData.proteinShadowReceiver = true;
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

/** 焼き込み済みメッシュの頂点(三角形をまたいで重複する場合がある)を鎖ごとのローカル頂点へ登録する。 */
function ribbonLocalVertex(
  part: RibbonChainPart, source: ProteinRenderSource, mode: ProteinRibbonColorMode,
  fixedColor: THREE.Color | null, residues: readonly number[], sourceVertex: number,
): number {
  // 同じ焼き込み頂点を指す2度目以降の三角形は、既に登録したローカル頂点を再利用する。
  const existing = part.vertices.get(sourceVertex);
  if (existing !== undefined) return existing;
  const local = part.vertices.size;
  part.vertices.set(sourceVertex, local);
  const mesh = source.structure.ribbon.mesh;
  const center = source.structure.coordinateFrame.centeredAt;
  const offset = sourceVertex * 3;
  part.positions.push(
    mesh.position[offset]! - (center[0] ?? 0),
    mesh.position[offset + 1]! - (center[1] ?? 0),
    mesh.position[offset + 2]! - (center[2] ?? 0),
  );
  // 色は残基番号から都度計算する — 色分けモードは実行時に切り替わるため焼き込めない。
  const residue = residues[sourceVertex] ?? 0;
  const color = fixedColor ?? proteinRibbonColor(source, residue, mode);
  part.colors.push(color.r, color.g, color.b);
  part.residues.push(residue);
  return local;
}

/** 焼き込み済みカートゥーンメッシュを鎖ごとに分割し、着色と GPU 変位バインディングを付けて構築する。 */
export function buildProteinRibbon(
  source: ProteinRenderSource, mode: ProteinRibbonColorMode, fixedColor: THREE.Color | null = null,
  motion?: ProteinMotionBinding,
): THREE.Group {
  const group = new THREE.Group();
  const mesh = source.structure.ribbon.mesh;
  const residues = source.motion.bindings.ribbonResidues;
  const parts = new Map<string, RibbonChainPart>();
  for (let offset = 0; offset + 2 < mesh.index.length; offset += 3) {
    const triangle = [mesh.index[offset]!, mesh.index[offset + 1]!, mesh.index[offset + 2]!] as const;
    const chain = triangleComponent(mesh.chain, ...triangle);
    const part: RibbonChainPart = parts.get(chain) ?? { positions: [], colors: [], residues: [], indices: [], vertices: new Map() };
    parts.set(chain, part);
    for (const vertex of triangle) part.indices.push(ribbonLocalVertex(part, source, mode, fixedColor, residues, vertex));
  }
  // 材質は最初の mesh を作る直前まで遅らせる — 鎖が1本も成立しない source では誰にも
  // 所有されない材質を残さない。
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

export { buildProteinCollisionRibbon } from './protein-collision-ribbon';
