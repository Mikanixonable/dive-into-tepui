// 射撃のたびに排出される薬莢1個の表示と、全薬莢が共有する描画資源。
import * as THREE from 'three/webgpu';
import { attachThermalEmissive } from '../../thermal-emissive';
import { memoParseIndependent } from '../baked-model';
import { DynamicView, type DynamicRenderSource, type DynamicViewFrame } from '../dynamic-view';
import casingData from '../../../assets/models/casing.json';
import type { KinematicState } from '../../../physics/kinematic-state';

const parseCasing = memoParseIndependent<THREE.Mesh>(casingData);

// 全薬莢が共有する geometry/material。初回に生成する。
let casingBody: { readonly geometry: THREE.BufferGeometry; readonly material: THREE.Material } | null = null;

// 全薬莢が共有する geometry/material を返す。geometry はテンプレートの複製へ全長補正を焼き込み、
// material はテンプレートから一度だけ複製したものを不変資源として使う。
export function casingBodyResources(): { geometry: THREE.BufferGeometry; material: THREE.Material } {
  if (casingBody === null) {
    const template = parseCasing();
    const geometry = template.geometry.clone();
    geometry.scale(1, 2, 1);
    const material = template.material as THREE.MeshStandardNodeMaterial;
    material.color.setHex(0xFF9F5E);
    material.metalness = 0.8;
    material.roughness = 0.3;
    // 個体は 1 本の InstancedMesh へ積まれるので、温度は個体ごとの属性から読む。
    attachThermalEmissive(material, 'instance');
    casingBody = { geometry, material };
  }
  return casingBody;
}

// 薬莢1個の表示。全薬莢で共有する1本のプールへ積む。
export class CasingView extends DynamicView {
  // 共有資源を指す薬莢メッシュを、プールへ積む変換の担い手として持つ。
  public constructor(scene?: THREE.Scene) {
    const body = casingBodyResources();
    const mesh = new THREE.Mesh(body.geometry, body.material);
    mesh.userData.ownsGeometry = false;
    mesh.userData.ownsMaterial = false;
    super(mesh, scene, false);
  }

  // 薬莢は全個体で共有する1本のプールへ積む。
  protected override syncModel(
    _source: DynamicRenderSource,
    _displayed: KinematicState | null,
    context: DynamicViewFrame,
  ): void {
    context.pools.pushCasing(this.object);
  }
}
