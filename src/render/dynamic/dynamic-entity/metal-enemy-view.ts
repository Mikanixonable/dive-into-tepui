import * as THREE from 'three/webgpu';
import { buildEnemyShip, buildStage0EnemyShip } from '../ships';
import { DynamicView } from '../dynamic-view';

// アセット座標のモデルを、渡された倍率で物理寸法へ合わせる。
function scaledEnemyModel(model: THREE.Object3D, modelScale: number): THREE.Object3D {
  model.scale.setScalar(modelScale);
  return model;
}

export class MetalEnemyView extends DynamicView {
  // 型番を持たない漂流機体を、accent 色・modelScale 倍で組み立てる。
  public constructor(accent: string | number, modelScale: number, scene?: THREE.Scene) {
    super(scaledEnemyModel(buildEnemyShip(accent), modelScale), scene);
  }
}

export class Stage0MetalEnemyView extends DynamicView {
  // typeIndex の機体テンプレートを、accent 色・modelScale 倍で組み立てる。
  public constructor(
    accent: string | number, typeIndex: number, modelScale: number, scene?: THREE.Scene,
  ) {
    super(scaledEnemyModel(buildStage0EnemyShip(accent, typeIndex), modelScale), scene);
  }
}
