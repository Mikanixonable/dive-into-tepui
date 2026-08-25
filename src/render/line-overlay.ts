// 模式図スタイルの地表へ貼る線(海岸線・月の海/クレーターの輪郭など)に共通のラッパー。
// ジオメトリ・マテリアルは呼び出し側が用意し、markOverlay で輪郭抽出をバイパスして直接合成する
// 3D UI パスへ乗せる。
import * as THREE from 'three/webgpu';
import { markOverlay } from './pipeline/lit-layer';

export class LineOverlay {
  private readonly line: THREE.LineSegments;

  constructor(geometry: THREE.BufferGeometry, material: THREE.LineBasicMaterial) {
    this.line = new THREE.LineSegments(geometry, material);
    markOverlay(this.line);
  }

  // 天体の姿勢を持つ group の子として置く。位置・スケール・自転姿勢は親から自動で継承する。
  addTo(parent: THREE.Object3D): void {
    parent.add(this.line);
  }

  setVisible(visible: boolean): void {
    this.line.visible = visible;
  }

  // line を親から外す。ジオメトリ・マテリアルは呼び出し側が共有しているため解放しない。
  dispose(): void {
    this.line.removeFromParent();
  }
}
