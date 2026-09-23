// shipModules.json の template から module 境界ごとの表示インスタンスを作る。
// production では巨大な JSON を asset/resource として別ファイルへ出し、起動時に一度だけ取得する。
// tsc/node テストでは JSON import が実体の object のままなので、fetch を経ず同じ同期 factory を使える。
import * as THREE from 'three/webgpu';
import shipModulesSource from '../../../assets/models/shipModules.json';
import { makeThermallyEmissive } from '../../thermal-emissive';
import { markLitOpaque, markShadowCaster } from '../../pipeline/lit-layer';

const loader = new THREE.ObjectLoader();
let sourceData: unknown | null = typeof shipModulesSource === 'string' ? null : shipModulesSource;
let parsedShipModules: THREE.Group | null = null;
let loadPromise: Promise<void> | null = null;

function parseSource(): THREE.Group {
  if (parsedShipModules !== null) return parsedShipModules;
  if (sourceData === null) {
    throw new Error('ship module models are not loaded; call loadShipModuleModels() during startup');
  }
  parsedShipModules = loader.parse(sourceData) as THREE.Group;
  sourceData = null;
  return parsedShipModules;
}

// production の外部 asset を先読みする。複数の起動経路から呼ばれても fetch/parse は一度だけ。
export function loadShipModuleModels(): Promise<void> {
  if (parsedShipModules !== null || sourceData !== null) return Promise.resolve();
  if (loadPromise !== null) return loadPromise;
  if (typeof shipModulesSource !== 'string') {
    sourceData = shipModulesSource;
    return Promise.resolve();
  }
  loadPromise = fetch(shipModulesSource)
    .then((response) => {
      if (!response.ok) throw new Error(`ship module asset fetch failed: ${response.status} ${response.statusText}`);
      return response.json() as Promise<unknown>;
    })
    .then((data) => {
      sourceData = data;
      parseSource();
    });
  return loadPromise;
}

function templateFor(modelId: string): THREE.Object3D {
  const template = parseSource().children.find(
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
