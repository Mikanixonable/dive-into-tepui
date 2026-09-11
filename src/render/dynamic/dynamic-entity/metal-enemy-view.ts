import * as THREE from 'three/webgpu';
import { memoParseIndependent } from '../baked-model';
import { DynamicView } from '../dynamic-view';
import enemyData from '../../../assets/models/enemy.json';
import stage0EnemyDataA from '../../../assets/models/stage0EnemyA.json';
import stage0EnemyDataB from '../../../assets/models/stage0EnemyB.json';
import stage0EnemyDataC from '../../../assets/models/stage0EnemyC.json';

const parseEnemy = memoParseIndependent<THREE.Group>(enemyData);
const parseStage0EnemyA = memoParseIndependent<THREE.Group>(stage0EnemyDataA);
const parseStage0EnemyB = memoParseIndependent<THREE.Group>(stage0EnemyDataB);
const parseStage0EnemyC = memoParseIndependent<THREE.Group>(stage0EnemyDataC);

// stage0 敵機の typeIndex(0〜2)の機体テンプレートを複製する。
function parseStage0Enemy(typeIndex: number): THREE.Group {
  if (typeIndex === 1) return parseStage0EnemyB();
  if (typeIndex === 2) return parseStage0EnemyC();
  return parseStage0EnemyA();
}

// model の userData.role === 'accent' のマテリアルを accent 色へ塗り、modelScale 倍で物理寸法へ
// 合わせる。model そのものを書き換えて返す。
function enemyModel(model: THREE.Group, accent: string | number, modelScale: number): THREE.Object3D {
  // accent 役のマテリアルだけを塗り替える。
  model.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mat = mesh.material as THREE.Material & { color?: THREE.Color };
    if (mat && mat.userData && mat.userData.role === 'accent' && mat.color) {
      mat.color.set(accent);
    }
  });
  // アセット座標から物理寸法へ合わせる。
  model.scale.setScalar(modelScale);
  return model;
}

export class MetalEnemyView extends DynamicView {
  // 型番を持たない漂流機体を、accent 色・modelScale 倍で組み立てる。
  public constructor(accent: string | number, modelScale: number, scene?: THREE.Scene) {
    super(enemyModel(parseEnemy(), accent, modelScale), scene);
  }
}

export class Stage0MetalEnemyView extends DynamicView {
  // typeIndex の機体テンプレートを、accent 色・modelScale 倍で組み立てる。
  public constructor(
    accent: string | number, typeIndex: number, modelScale: number, scene?: THREE.Scene,
  ) {
    super(enemyModel(parseStage0Enemy(typeIndex), accent, modelScale), scene);
  }
}
