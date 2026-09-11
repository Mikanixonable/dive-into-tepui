// tools/model-builder/export-models.mjs が src/assets/models/*.json へ焼いたモデルを ObjectLoader で読み、
// 初回だけパースしたテンプレートから複製を作る。テンプレートそのものは書き換えない。
import * as THREE from 'three/webgpu';
import { markLitOpaque, markShadowCaster } from '../pipeline/lit-layer';
import { makeThermallyEmissive } from '../thermal-emissive';

const loader = new THREE.ObjectLoader();

// template を複製し、マテリアルを個体ごとに持たせたうえで熱発光と照明・影のレイヤを印す。
// Object3D.clone(true) はマテリアルを参照共有するので、複製し直さないと個体ごとの色の塗り替えが
// 全個体へ波及する。
function cloneIndependent<T extends THREE.Object3D>(template: T): T {
  const clone = template.clone(true) as T;
  // 各メッシュのマテリアルを個体ごとに複製し、個体の破棄で解放させる。
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
  // 熱発光と照明・影のレイヤを印す。
  makeThermallyEmissive(clone);
  markLitOpaque(clone);
  markShadowCaster(clone);
  return clone;
}

// data を初回だけパースしてキャッシュし、以後も同じテンプレートを返す関数を作る。
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
// 大量に生成する種別で、生成のたびに GPU 資源が増えないようにするためのもの。
export function memoParseShared<T extends THREE.Object3D>(data: unknown): () => T {
  const template = memoTemplate<T>(data);
  return () => template().clone(true) as T;
}
