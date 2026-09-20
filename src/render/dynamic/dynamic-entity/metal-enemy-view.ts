import * as THREE from 'three/webgpu';
import { memoParseIndependent } from '../baked-model';
import { DynamicView } from '../dynamic-view';
import enemyData from '../../../assets/models/enemy.json';
import enemyVariantDataA from '../../../assets/models/enemyVariantA.json';
import enemyVariantDataB from '../../../assets/models/enemyVariantB.json';
import enemyVariantDataC from '../../../assets/models/enemyVariantC.json';

const parseEnemy = memoParseIndependent<THREE.Group>(enemyData);
const parseEnemyVariantA = memoParseIndependent<THREE.Group>(enemyVariantDataA);
const parseEnemyVariantB = memoParseIndependent<THREE.Group>(enemyVariantDataB);
const parseEnemyVariantC = memoParseIndependent<THREE.Group>(enemyVariantDataC);

// 型番付き敵機の typeIndex(0〜2)の機体テンプレートを複製する。
function parseEnemyVariant(typeIndex: number): THREE.Group {
  if (typeIndex === 1) return parseEnemyVariantB();
  if (typeIndex === 2) return parseEnemyVariantC();
  return parseEnemyVariantA();
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

export class VariantMetalEnemyView extends DynamicView {
  // typeIndex の機体テンプレートを、accent 色・modelScale 倍で組み立てる。
  public constructor(
    accent: string | number, typeIndex: number, modelScale: number, scene?: THREE.Scene,
  ) {
    super(enemyModel(parseEnemyVariant(typeIndex), accent, modelScale), scene);
  }
}
