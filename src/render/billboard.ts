// カメラ方向を向く発光平面(噴射パフ・被弾/撃破フラッシュ・太陽など、加算ブレンドの
// グローテクスチャで描く光点が共有する構造)。位置・スケール・不透明度の決定は
// 各エフェクトクラスの責務とし、ここではそれらをカメラ正対の平面へ反映するだけに徹する。
import * as THREE from 'three/webgpu';
import { getGlowTexture } from './glow-texture';

export class Billboard {
  readonly mesh: THREE.Mesh;

  constructor(color: number, renderOrder = 5) {
    const mat = new THREE.MeshBasicMaterial({
      map: getGlowTexture(),
      color,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
    this.mesh.visible = false;
  }

  hide(): void {
    this.mesh.visible = false;
  }

  // position は描画フレーム(フローティングオリジン補正済み)の THREE.Vector3。
  // 慣性座標 → 描画フレームの変換は呼び出し側が fo 経由で済ませておくこと。
  sync(position: THREE.Vector3, scale: number, opacity: number, cameraQuat: THREE.Quaternion): void {
    this.mesh.visible = true;
    this.mesh.position.copy(position);
    this.mesh.scale.setScalar(scale);
    this.mesh.quaternion.copy(cameraQuat);
    (this.mesh.material as THREE.MeshBasicMaterial).opacity = opacity;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
