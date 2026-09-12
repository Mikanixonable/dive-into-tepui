// 飛翔中の弾のモデル。進行方向は +Z で、加算合成の発光体として描く。
import * as THREE from 'three';

// 進行方向 +Z に伸びる曳光弾
export function buildBulletMesh() {
  const geo = new THREE.BoxGeometry(0.22, 0.22, 6);
  const mat = new THREE.MeshBasicMaterial({
    // 明るさは色に載せ、不透明度は 1 のままにする。
    color: new THREE.Color(0xffc86e).multiplyScalar(0.95),
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  return new THREE.Mesh(geo, mat);
}

// プラズマ弾。長さ軸を +Z へ向ける回転は頂点に焼き込んである。
export function buildPlasmaBullet() {
  const geo = new THREE.CylinderGeometry(0.2, 0.2, 4.0, 5);
  geo.rotateX(Math.PI / 2);
  const mat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(0x3dc6ff).multiplyScalar(0.95),
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  return new THREE.Mesh(geo, mat);
}
