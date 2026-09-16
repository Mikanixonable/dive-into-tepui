// shipModules.json を一度だけパースし、module 境界ごとの独立した表示インスタンスを作る。
// geometry は焼き込み template と共有し、状態で変わりうる material だけを個体所有にする。
import * as THREE from 'three/webgpu';
import shipModulesData from '../../../assets/models/shipModules.json';
import { memoTemplate } from '../baked-model';
import { makeThermallyEmissive } from '../../thermal-emissive';
import { markLitOpaque, markShadowCaster } from '../../pipeline/lit-layer';

const parsedShipModules = memoTemplate<THREE.Group>(shipModulesData);

function templateFor(modelId: string): THREE.Object3D {
  const template = parsedShipModules().children.find(
    child => child.userData.moduleModelId === modelId,
  );
  if (template === undefined) throw new Error(`unknown ship module model: ${modelId}`);
  return template;
}

// 呼び出し側が disposeOwnedRenderResources で安全に破棄できる module model を返す。
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

