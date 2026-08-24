// カメラ方向を向く発光平面(噴射パフ・被弾/撃破フラッシュ・太陽など、加算ブレンドの
// グローテクスチャで描く光点が共有する構造)。位置・スケール・明るさの決定は
// 各エフェクトクラスの責務とし、ここではそれらをカメラ正対の平面へ反映するだけに徹する。
//
// **明るさは色に載せ、不透明度は 1 に固定する。** 不透明度は「背景をどれだけ置き換えるか」
// という別の量で、1 を超える明るさを表せない — THREE.Color の各成分は素の float なので、
// 太陽面のように表示値で 1 を大きく超える明るさもそのまま入る。
import * as THREE from 'three/webgpu';
import { getGlowTexture } from './glow-texture';

export class Billboard {
  readonly mesh: THREE.Mesh;
  // 明るさ 1 のときの色。sync がこれへ明るさを掛けてマテリアルの色を書く。
  private readonly baseColor: THREE.Color;

  // 指定色の発光平面を非表示状態で組み立てる。
  constructor(color: string | number, renderOrder = 5) {
    this.baseColor = new THREE.Color(color);
    // 加算ブレンドのグローマテリアル
    const mat = new THREE.MeshBasicMaterial({
      map: getGlowTexture(),
      color,
      transparent: true,
      opacity: 1,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    // 1x1 平面メッシュとして生成し、sync で毎フレームスケール/位置を与える
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    this.mesh.renderOrder = renderOrder;
    this.mesh.visible = false;
  }

  // 平面を非表示にする。
  hide(): void {
    this.mesh.visible = false;
  }

  // position は描画フレーム(フローティングオリジン補正済み)の THREE.Vector3。
  // 慣性座標 → 描画フレームの変換は呼び出し側が fo 経由で済ませておくこと。
  // brightness は 1 を超えうる明るさの倍率で、基準色へ掛かる。
  sync(position: THREE.Vector3, scale: number, brightness: number, cameraQuat: THREE.Quaternion): void {
    this.mesh.visible = true;
    this.mesh.position.copy(position);
    this.mesh.scale.setScalar(scale);
    this.mesh.quaternion.copy(cameraQuat);
    (this.mesh.material as THREE.MeshBasicMaterial).color
      .copy(this.baseColor).multiplyScalar(brightness);
  }

  // ジオメトリ・マテリアルを破棄する。
  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

// InstancedPool が全フラッシュエフェクトで使い回す共有ジオメトリ/マテリアル。色は白のまま
// 固定し、個体ごとの色は呼び出し側が InstancedPool の per-instance color で与える。
export function flashResources(): { geometry: THREE.BufferGeometry; material: THREE.Material } {
  const material = new THREE.MeshBasicMaterial({
    map: getGlowTexture(),
    color: 0xffffff,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  return { geometry: new THREE.PlaneGeometry(1, 1), material };
}
