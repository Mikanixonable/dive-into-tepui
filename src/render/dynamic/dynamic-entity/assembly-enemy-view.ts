// 組み立て型の敵(SPEC/ASSEMBLY.md)1体ぶんの表示。形状モデルの部品ごとに管状のメッシュを
// 持ち、失われた部品は表示入力に従って畳む。
import * as THREE from 'three/webgpu';
import { mulberry32 } from '../../../math/random';
import { assemblyPartGeometry } from '../../assembly/assembly-geometry';
import { markLitOpaque, markShadowCaster } from '../../pipeline/lit-layer';
import { makeThermallyEmissive } from '../../thermal-emissive';
import { DynamicView, type DynamicRenderSource, type DynamicViewFrame } from '../dynamic-view';
import type { AssemblyPartDef, AssemblyShape } from '../../assembly/assembly-shape';
import type { KinematicState } from '../../../physics/kinematic-state';

// 組み立て型の敵の表示入力。aliveParts[i] が偽なら部品 i は描かない(失われた部品)。
export interface AssemblyVisualSource extends DynamicRenderSource {
  readonly aliveParts: readonly boolean[];
}

// 構造部の中性色。識別色(accent)を持つ部品と区別が付く、白〜煙色の薄いトーンだけを置く。
const STRUCTURE_COLORS = [0xf1edf0, 0xd9d9d3, 0xc6cbd6, 0xa8aec0, 0x8d95a8] as const;
// 誘電体プラスチックの粗さの範囲。部品ごとにこの中でばらつかせる。
const ROUGHNESS_MIN = 0.15;
const ROUGHNESS_MAX = 0.3;

// 部品のマテリアル。構造部は個体の seed と部品番号で決まる中性色、発射部・中核は識別色。
function partMaterial(
  shape: AssemblyShape, part: AssemblyPartDef, accent: string | number,
): THREE.MeshStandardNodeMaterial {
  const rand = mulberry32((shape.seed ^ Math.imul(part.index + 1, 0x9e3779b9)) >>> 0);
  const color = part.role === 'structure'
    ? STRUCTURE_COLORS[Math.floor(rand() * STRUCTURE_COLORS.length)]!
    : accent;
  return new THREE.MeshStandardNodeMaterial({
    color,
    roughness: ROUGHNESS_MIN + rand() * (ROUGHNESS_MAX - ROUGHNESS_MIN),
    metalness: 0,
  });
}

export class AssemblyEnemyView extends DynamicView<AssemblyVisualSource> {
  // 部品番号順のメッシュ。
  private readonly partMeshes: THREE.Mesh[] = [];

  // 形状 shape の個体を、識別色 accent で組み立てる。
  public constructor(shape: AssemblyShape, accent: string | number, scene?: THREE.Scene) {
    const root = new THREE.Group();
    super(root, scene);
    for (const part of shape.parts) {
      const mesh = new THREE.Mesh(assemblyPartGeometry(part), partMaterial(shape, part, accent));
      mesh.userData.ownsGeometry = true;
      mesh.userData.ownsMaterial = true;
      this.partMeshes[part.index] = mesh;
      root.add(mesh);
    }
    makeThermallyEmissive(root);
    markLitOpaque(root);
    markShadowCaster(root);
  }

  // 失われた部品のメッシュを畳む。
  protected override syncModel(
    source: AssemblyVisualSource, _displayed: KinematicState | null, _viewFrame: DynamicViewFrame,
  ): void {
    for (const [index, mesh] of this.partMeshes.entries()) {
      mesh.visible = source.aliveParts[index] === true;
    }
  }
}
