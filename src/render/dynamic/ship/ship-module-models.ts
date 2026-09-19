// shipModules.json の template から module 境界ごとの表示インスタンスを作る。
// geometry は template と共有し、可変 material は個体ごとに所有する。
import type * as THREE from 'three/webgpu';
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
