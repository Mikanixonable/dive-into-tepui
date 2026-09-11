// リロードで機体から外れる砲身と、空になって排出されたマガジンの外枠の表示。geometry/material は
// 全個体の共有物で、個体の片付けは表示ツリーから外すだけでよい。
import * as THREE from 'three/webgpu';
import { markLitOpaque, markShadowCaster } from '../../pipeline/lit-layer';
import { makeThermallyEmissive } from '../../thermal-emissive';
import { memoParseIndependent, memoTemplate } from '../baked-model';
import { DynamicView } from '../dynamic-view';
import barrelData from '../../../assets/models/barrel.json';
import magazineData from '../../../assets/models/magazine.json';

// root 配下のメッシュが握る geometry/material を、全個体の共有物として印す。
function markSharedResources(root: THREE.Object3D): void {
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.userData.ownsGeometry = false;
    mesh.userData.ownsMaterial = false;
  });
}

// 砲身のテンプレート。熱の状態は個体ごとの userData が運ぶ。
let barrelTemplate: THREE.Group | null = null;

// 砲身をテンプレートから複製して返す。
export function buildBarrelMesh(): THREE.Group {
  if (barrelTemplate === null) {
    const g = memoTemplate<THREE.Group>(barrelData)();
    makeThermallyEmissive(g);
    markSharedResources(g);
    // layers.mask は Object3D.clone(true) が子孫までコピーするので、テンプレートへ一度だけ印す。
    markLitOpaque(g);
    markShadowCaster(g);
    barrelTemplate = g;
  }
  return barrelTemplate.clone(true) as THREE.Group;
}

// 弾(role === 'round' のメッシュ)を抜いた、外枠だけのマガジンのテンプレート。
const parseMagazine = memoParseIndependent<THREE.Group>(magazineData);
let magazineFrameTemplate: THREE.Group | null = null;

// マガジンの外枠をテンプレートから複製して返す。
function buildMagazineFrameMesh(): THREE.Group {
  if (magazineFrameTemplate === null) {
    const g = parseMagazine();
    for (const child of [...g.children]) {
      if ((child as THREE.Mesh).userData?.['role'] === 'round') g.remove(child);
    }
    markSharedResources(g);
    magazineFrameTemplate = g;
  }
  return magazineFrameTemplate.clone(true) as THREE.Group;
}

// リロードで外れた砲身1本。
export class BarrelView extends DynamicView {
  // テンプレートを複製して scene へ登録する。
  public constructor(scene?: THREE.Scene) {
    super(buildBarrelMesh(), scene);
  }
}

// 排出されたマガジンの外枠1個。
export class MagazineFrameView extends DynamicView {
  // テンプレートを複製して scene へ登録する。
  public constructor(scene?: THREE.Scene) {
    super(buildMagazineFrameMesh(), scene);
  }
}
