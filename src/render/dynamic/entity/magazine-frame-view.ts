// 空になって排出されたマガジンの外枠の表示。geometry/material は全個体の共有物で、個体の片付けは
// 表示ツリーから外すだけでよい。
import type * as THREE from 'three/webgpu';
import { cloneIndependent, markSharedResources } from '../model-template';
import { DynamicView } from '../dynamic-view';
import { getMagazineTemplate } from '../ammo-models';

// 弾(role === 'round' のメッシュ)を抜いた、外枠だけのマガジンのテンプレート。
let magazineFrameTemplate: THREE.Group | null = null;

// マガジンの外枠をテンプレートから複製して返す。
function buildMagazineFrameMesh(): THREE.Group {
  if (magazineFrameTemplate === null) {
    const g = cloneIndependent(getMagazineTemplate());
    for (const child of [...g.children]) {
      if ((child as THREE.Mesh).userData?.['role'] === 'round') g.remove(child);
    }
    markSharedResources(g);
    magazineFrameTemplate = g;
  }
  return magazineFrameTemplate.clone(true) as THREE.Group;
}

// 排出されたマガジンの外枠1個。
export class MagazineFrameView extends DynamicView {
  // テンプレートを複製して scene へ登録する。
  public constructor(scene?: THREE.Scene) {
    super(buildMagazineFrameMesh(), scene);
  }
}
