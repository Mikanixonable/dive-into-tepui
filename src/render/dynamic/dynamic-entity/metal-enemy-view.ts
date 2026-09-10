import * as THREE from 'three/webgpu';
import { buildEnemyShip, buildStage0EnemyShip } from '../ships';
import { DynamicView } from '../dynamic-view';
import { ENEMY_MODEL_SCALE } from '../../../game/dynamic/dynamic-entity/enemy-motion';

function scaledEnemyModel(model: THREE.Object3D): THREE.Object3D {
  model.scale.setScalar(ENEMY_MODEL_SCALE);
  return model;
}

export class MetalEnemyView extends DynamicView {
  public constructor(accent: string | number, scene?: THREE.Scene) {
    super(scaledEnemyModel(buildEnemyShip(accent)), scene);
  }
}

export class Stage0MetalEnemyView extends DynamicView {
  public constructor(accent: string | number, typeIndex: number, scene?: THREE.Scene) {
    super(scaledEnemyModel(buildStage0EnemyShip(accent, typeIndex)), scene);
  }
}
