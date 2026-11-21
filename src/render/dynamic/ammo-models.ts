// 弾薬ピックアップとマガジンの焼き込みモデル(ammo.glb・magazine.glb)を、起動時に
// 一度だけ読み込んでテンプレートとして渡す。
import type * as THREE from 'three/webgpu';
import { loadBakedGlb } from './baked-glb';
import ammoSource from '../../assets/models/ammo.glb';
import magazineSource from '../../assets/models/magazine.glb';

let ammoPickupTemplate: THREE.Group | null = null;
let magazineTemplate: THREE.Group | null = null;
let loadPromise: Promise<void> | null = null;

// 書き出した1本のモデルは、GLTFLoader の返す scene の子1本として入っている。
function unwrappedModel(scene: THREE.Group): THREE.Group {
  return (scene.children.length === 1 ? scene.children[0]! : scene) as THREE.Group;
}

// production の外部 asset を先読みする。複数の起動経路から呼ばれても fetch/parse は一度だけ。
export function loadAmmoModels(): Promise<void> {
  if (loadPromise !== null) return loadPromise;
  loadPromise = Promise.all([loadBakedGlb(ammoSource), loadBakedGlb(magazineSource)])
    .then(([ammoScene, magazineScene]) => {
      ammoPickupTemplate = unwrappedModel(ammoScene);
      magazineTemplate = unwrappedModel(magazineScene);
    });
  return loadPromise;
}

export function getAmmoPickupTemplate(): THREE.Group {
  if (ammoPickupTemplate === null) {
    throw new Error('ammo models are not loaded; call loadAmmoModels() during startup');
  }
  return ammoPickupTemplate;
}

export function getMagazineTemplate(): THREE.Group {
  if (magazineTemplate === null) {
    throw new Error('ammo models are not loaded; call loadAmmoModels() during startup');
  }
  return magazineTemplate;
}
