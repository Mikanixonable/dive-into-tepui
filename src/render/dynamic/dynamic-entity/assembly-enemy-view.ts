// 組み立て型の敵(SPEC/ASSEMBLY.md)1体ぶんの表示。形状モデルの部品ごとに管状のメッシュを
// 持ち、失われた部品は表示入力に従って畳む。
import * as THREE from 'three/webgpu';
import { assemblyPartMesh } from '../../assembly/assembly-part-mesh';
import { markLitOpaque, markShadowCaster } from '../../pipeline/lit-layer';
import { makeThermallyEmissive } from '../../thermal-emissive';
import { DynamicView, type DynamicRenderSource, type DynamicViewFrame } from '../dynamic-view';
import type { AssemblyShape } from '../../assembly/assembly-shape';
import type { KinematicState } from '../../../physics/kinematic-state';

// 組み立て型の敵の表示入力。aliveParts[i] が偽なら部品 i は描かない(失われた部品)。
export interface AssemblyVisualSource extends DynamicRenderSource {
  readonly aliveParts: readonly boolean[];
}

export class AssemblyEnemyView extends DynamicView<AssemblyVisualSource> {
  // 部品番号順のメッシュ。
  private readonly partMeshes: THREE.Mesh[] = [];

  // 形状 shape の個体を、識別色 accent で組み立てる。部品のメッシュは部品番号の添字に置き、
  // syncModel で失われた部品を畳めるようにする。
  public constructor(shape: AssemblyShape, accent: string | number, scene?: THREE.Scene) {
    const root = new THREE.Group();
    super(root, scene);
    for (const part of shape.parts) {
      const mesh = assemblyPartMesh(shape.seed, part, accent);
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
