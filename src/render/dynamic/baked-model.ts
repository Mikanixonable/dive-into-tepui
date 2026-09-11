// src/assets/models/*.json へ焼いたモデルを初回だけパースしてテンプレートとし、その複製を作る。
// メッシュが握る geometry/material に、個体の持ち物か全個体の共有物かの印を付ける。
import * as THREE from 'three/webgpu';
import { markLitOpaque, markShadowCaster } from '../pipeline/lit-layer';
import { makeThermallyEmissive } from '../thermal-emissive';

const loader = new THREE.ObjectLoader();

// template を複製し、マテリアルを個体ごとに持たせたうえで熱発光と照明・影のレイヤを印す。
function cloneIndependent<T extends THREE.Object3D>(template: T): T {
  const clone = template.clone(true) as T;
  // clone(true) はマテリアルを参照共有するので、複製し直さないと個体の塗り替えが全個体へ波及する。
  clone.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh && mesh.material) {
      if (Array.isArray(mesh.material)) {
        mesh.material = mesh.material.map((m) => m.clone());
      } else {
        mesh.material = mesh.material.clone();
      }
      mesh.userData.ownsMaterial = true;
    }
  });
  makeThermallyEmissive(clone);
  markLitOpaque(clone);
  markShadowCaster(clone);
  return clone;
}

// data を初回の呼び出しでパースし、以後は同じテンプレートの実体を返す関数を作る。
export function memoTemplate<T extends THREE.Object3D>(data: unknown): () => T {
  let cached: T | null = null;
  return () => {
    if (!cached) cached = loader.parse(data) as T;
    return cached;
  };
}

// data のテンプレートから、マテリアルを個体ごとに持ち、熱発光と照明・影のレイヤを印した複製を
// 返すビルダーを作る。
export function memoParseIndependent<T extends THREE.Object3D>(data: unknown): () => T {
  const template = memoTemplate<T>(data);
  return () => cloneIndependent(template());
}

// data のテンプレートから、geometry/material をテンプレートと共有する複製を返すビルダーを作る。
// 生成のたびに GPU 資源が増えることがないので、大量に生成する種別に使う。
export function memoParseShared<T extends THREE.Object3D>(data: unknown): () => T {
  const template = memoTemplate<T>(data);
  return () => template().clone(true) as T;
}

// root 配下のメッシュが握る geometry/material を、全個体の共有物として印す。
export function markSharedResources(root: THREE.Object3D): void {
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.userData.ownsGeometry = false;
    mesh.userData.ownsMaterial = false;
  });
}
