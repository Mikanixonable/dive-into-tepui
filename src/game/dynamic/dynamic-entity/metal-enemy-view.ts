import * as THREE from 'three/webgpu';
import { buildEnemyShip, buildStage0EnemyShip } from '../../../render/ships';
import { DynamicView } from '../dynamic-view';
import { ENEMY_MODEL_SCALE } from './enemy-motion';

function enemyModel(accent: string | number, typeIndex: number | null): THREE.Object3D {
  const model = typeIndex === null ? buildEnemyShip(accent) : buildStage0EnemyShip(accent, typeIndex);
  model.scale.setScalar(ENEMY_MODEL_SCALE);
  return model;
}

// 金属敵機のモデルと共通軌道表示を所有する。
export class MetalEnemyView extends DynamicView {
  public constructor(accent: string | number, typeIndex: number | null, scene?: THREE.Scene) {
    const model = enemyModel(accent, typeIndex);
    super(model, scene);
  }
}
