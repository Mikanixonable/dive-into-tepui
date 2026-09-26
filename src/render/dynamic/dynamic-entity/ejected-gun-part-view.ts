// 空になって排出されたマガジン外枠とカートリッジの表示。
import type * as THREE from 'three/webgpu';
import { memoParseIndependent, markSharedResources } from '../baked-model';
import { DynamicView } from '../dynamic-view';
import magazineData from '../../../assets/models/magazine.json';

const parseMagazine = memoParseIndependent<THREE.Group>(magazineData);
let magazineFrameTemplate: THREE.Group | null = null;
let cartridgeFrameTemplate: THREE.Group | null = null;

// 装填済みモデルから外箱だけを残した、排出表示用の共有テンプレートを複製する。
function buildMagazineFrameMesh(): THREE.Group {
  if (magazineFrameTemplate === null) {
    const magazine = parseMagazine();
    for (const child of [...magazine.children]) {
      if (child.userData['role'] !== 'magazineFrame') magazine.remove(child);
    }
    markSharedResources(magazine);
    magazineFrameTemplate = magazine;
  }
  return magazineFrameTemplate.clone(true) as THREE.Group;
}

// 上段カートリッジから実弾を外し、空の骨組みだけを排出表示へ渡す。
function buildCartridgeFrameMesh(): THREE.Group {
  if (cartridgeFrameTemplate === null) {
    const magazine = parseMagazine();
    for (const child of [...magazine.children]) {
      if (child.userData['role'] !== 'cartridgeFrame' || child.userData['stage'] !== 0) {
        magazine.remove(child);
        continue;
      }
      child.position.y = 0;
      for (const round of [...child.children]) {
        if (round.userData['role'] !== 'cartridgeShell') child.remove(round);
      }
    }
    markSharedResources(magazine);
    cartridgeFrameTemplate = magazine;
  }
  return cartridgeFrameTemplate.clone(true) as THREE.Group;
}

// 空になって排出されたマガジンの外枠1個。
export class MagazineFrameView extends DynamicView {
  public constructor(scene?: THREE.Scene) {
    super(buildMagazineFrameMesh(), scene);
  }
}

// 射出された空カートリッジ1個。テンプレートは上段の骨組みを原点へ移して使う。
export class CartridgeFrameView extends DynamicView {
  public constructor(scene?: THREE.Scene) {
    super(buildCartridgeFrameMesh(), scene);
  }
}
