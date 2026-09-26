// ship-modules.glb の template から module 境界ごとの表示インスタンスを作る。
// production ではバイナリを asset/resource として別ファイルへ出し、起動時に一度だけ取得する。
// tsc/node テストではローカルファイルを直接読み込み、同じ同期 factory を使える。
import type * as THREE from 'three/webgpu';
import type * as NodeFs from 'node:fs';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import shipModulesSource from '../../../assets/models/ship-modules.glb';
import { makeThermallyEmissive } from '../../thermal-emissive';
import { markLitOpaque, markShadowCaster } from '../../pipeline/lit-layer';

let parsedShipModules: THREE.Group | null = null;
let loadPromise: Promise<void> | null = null;

async function fetchGlbArrayBuffer(): Promise<ArrayBuffer> {
  if (typeof window === 'undefined' && typeof process !== 'undefined' && process.versions?.node != null) {
    // Node.js テスト環境: new Function を用いて webpack の静的解析を完全に回避
    const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<unknown>;
    const fs = (await dynamicImport('node:fs')) as typeof NodeFs;
    const buf = fs.readFileSync(shipModulesSource);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  }
  const response = await fetch(shipModulesSource);
  if (!response.ok) throw new Error(`ship module asset fetch failed: ${response.status} ${response.statusText}`);
  return await response.arrayBuffer();
}

function parseGlb(arrayBuffer: ArrayBuffer): Promise<THREE.Group> {
  const loader = new GLTFLoader();
  return new Promise((resolve, reject) => {
    loader.parse(
      arrayBuffer,
      '',
      (gltf) => {
        gltf.scene.traverse((node) => {
          if (node.userData?.name && typeof node.userData.name === 'string') {
            node.name = node.userData.name;
          }
        });
        const shipModulesRoot = gltf.scene.children.find(
          child => child.name === 'ship-modules' || child.userData?.name === 'ship-modules',
        ) ?? gltf.scene;
        resolve(shipModulesRoot as THREE.Group);
      },
      (error) => {
        reject(error);
      },
    );
  });
}

// production の外部 asset を先読みする。複数の起動経路から呼ばれても fetch/parse は一度だけ。
export function loadShipModuleModels(): Promise<void> {
  if (parsedShipModules !== null) return Promise.resolve();
  if (loadPromise !== null) return loadPromise;
  loadPromise = fetchGlbArrayBuffer()
    .then((arrayBuf) => parseGlb(arrayBuf))
    .then((root) => {
      parsedShipModules = root;
    });
  return loadPromise;
}

export function getShipModuleTemplates(): THREE.Group {
  if (parsedShipModules === null) {
    throw new Error('ship module models are not loaded; call loadShipModuleModels() during startup');
  }
  return parsedShipModules;
}

function templateFor(modelId: string): THREE.Object3D {
  const template = getShipModuleTemplates().children.find(
    child => child.userData.moduleModelId === modelId,
  );
  if (template === undefined) throw new Error(`unknown ship module model: ${modelId}`);
  return template;
}

// 所有 material と共有 geometry を印付けした module model を返す。
export function buildShipModuleModel(modelId: string): THREE.Object3D {
  const model = templateFor(modelId).clone(true);
  model.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.userData.ownsGeometry = false;
    if (Array.isArray(mesh.material)) mesh.material = mesh.material.map(material => material.clone());
    else mesh.material = mesh.material.clone();
    mesh.userData.ownsMaterial = true;
  });
  makeThermallyEmissive(model);
  markLitOpaque(model);
  markShadowCaster(model);
  return model;
}
