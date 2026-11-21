// *.glb へ焼き込んだモデルのバイナリを、URL ごとに一度だけ取得して GLTFLoader でパースする。
// production ではバイナリを asset/resource として別ファイルへ出し、起動時に fetch で取る。
// tsc/node テストではローカルファイルを直接読み込み、同じ読込口を使える。
import type * as THREE from 'three/webgpu';
import type * as NodeFs from 'node:fs';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const loadPromises = new Map<string, Promise<THREE.Group>>();

async function fetchGlbArrayBuffer(source: string): Promise<ArrayBuffer> {
  if (typeof window === 'undefined' && typeof process !== 'undefined' && process.versions?.node != null) {
    // Node.js テスト環境: new Function を用いて webpack の静的解析を完全に回避
    const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<unknown>;
    const fs = (await dynamicImport('node:fs')) as typeof NodeFs;
    const buf = fs.readFileSync(source);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  }
  const response = await fetch(source);
  if (!response.ok) throw new Error(`baked model fetch failed: ${response.status} ${response.statusText}`);
  return await response.arrayBuffer();
}

function parseGlb(arrayBuffer: ArrayBuffer): Promise<THREE.Group> {
  const loader = new GLTFLoader();
  return new Promise((resolve, reject) => {
    loader.parse(
      arrayBuffer,
      '',
      (gltf) => {
        // GLTFLoader はノード名を PropertyBinding 向けの文字へ置き換えるので、
        // userData.name に残った名をここで復元する。flatShading も glTF に無いので、
        // 書き出し側が材質の extras へ残した印から戻す。
        gltf.scene.traverse((node) => {
          if (typeof node.userData?.name === 'string') {
            node.name = node.userData.name;
          }
          const mesh = node as THREE.Mesh;
          if (!mesh.isMesh) return;
          for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
            // GLTFLoader が作る材質は MeshStandardMaterial 系だけなので、flatShading を持つ。
            if (material.userData?.flatShading === true) (material as THREE.MeshStandardMaterial).flatShading = true;
          }
        });
        resolve(gltf.scene);
      },
      (error) => {
        reject(error);
      },
    );
  });
}

// source の GLB を読み込み、パースしたシーンのルートを返す。同じ source への呼び出しは
// 一度だけの読込を共有する。
export function loadBakedGlb(source: string): Promise<THREE.Group> {
  let promise = loadPromises.get(source);
  if (promise === undefined) {
    promise = fetchGlbArrayBuffer(source).then(parseGlb);
    loadPromises.set(source, promise);
  }
  return promise;
}
