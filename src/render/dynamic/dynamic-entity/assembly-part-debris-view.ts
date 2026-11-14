// 組み立て型の敵から飛び出した部品1個の表示。敵にいたときの形と色のまま、重心を原点とした
// 部品を破片の姿勢と位置へ置く。
import * as THREE from 'three/webgpu';
import { assemblyPartMesh } from '../../assembly/assembly-part-mesh';
import type { AssemblyPartDef } from '../../assembly/assembly-shape';
import { markLitOpaque, markShadowCaster } from '../../pipeline/lit-layer';
import { makeThermallyEmissive } from '../../thermal-emissive';
import { DynamicView } from '../dynamic-view';

export class AssemblyPartDebrisView extends DynamicView {
  // part は重心を原点とした部品、seed と accent は敵にいたときの見た目を決める値。
  public constructor(
    part: AssemblyPartDef, seed: number, accent: string | number, scene?: THREE.Scene,
  ) {
    const root = new THREE.Group();
    super(root, scene);
    root.add(assemblyPartMesh(seed, part, accent));
    makeThermallyEmissive(root);
    markLitOpaque(root);
    markShadowCaster(root);
  }
}
