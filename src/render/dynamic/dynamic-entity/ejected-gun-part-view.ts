// 空になって排出されたマガジンの外枠の表示。geometry/material は全個体の共有物で、個体の片付けは
// 表示ツリーから外すだけでよい。
import type * as THREE from 'three/webgpu';
import { memoParseIndependent, markSharedResources } from '../baked-model';
import { DynamicView } from '../dynamic-view';
import magazineData from '../../../assets/models/magazine.json';

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

// 排出されたマガジンの外枠1個。
export class MagazineFrameView extends DynamicView {
  // テンプレートを複製して scene へ登録する。
  public constructor(scene?: THREE.Scene) {
    super(buildMagazineFrameMesh(), scene);
  }
}
