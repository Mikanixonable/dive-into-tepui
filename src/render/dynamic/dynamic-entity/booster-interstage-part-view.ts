import type * as THREE from 'three/webgpu';
import { buildBoosterExplosiveBoltMesh, buildBoosterInterstageCoverPanelMesh } from '../booster-model';
import { DynamicView } from '../dynamic-view';

// 段の分離で段間カバーから外れて飛ぶパネル1枚。
export class BoosterInterstageCoverPanelView extends DynamicView {
  // 段間カバーの segment 番目のパネルを複製して scene へ登録する。
  public constructor(segment: number, scene?: THREE.Scene) {
    super(buildBoosterInterstageCoverPanelMesh(segment), scene);
  }
}

// 段の分離で段間カバーから外れて飛ぶ爆砕ボルト1本。
export class BoosterExplosiveBoltView extends DynamicView {
  // 段間カバーの segment 番目の爆砕ボルトを複製して scene へ登録する。
  public constructor(segment: number, scene?: THREE.Scene) {
    super(buildBoosterExplosiveBoltMesh(segment), scene);
  }
}
