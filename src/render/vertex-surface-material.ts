// 部品ごとの素材(ベース色・粗さ・金属度)を頂点属性で運ぶ、全部品で共有する標準マテリアル。
// 素材の違う部品どうしを 1 枚のメッシュへ焼き合わせられるようにする。自照は Mesh ごとの熱の状態から引く。
import * as THREE from 'three/webgpu';
import { attribute } from 'three/tsl';
import { attachThermalEmissive, THERMAL_SHAPE_ATTRIBUTE } from './thermal-emissive';
import { isStandardMaterial } from './pipeline/lit-layer';
import type { FloatNode, Vec3Node } from './tsl-types';

// 頂点ごとのベース色(線形 RGB)。
const SURFACE_COLOR_ATTRIBUTE = 'surfaceColor';
// 頂点ごとの (粗さ, 金属度)。
const SURFACE_FINISH_ATTRIBUTE = 'surfaceFinish';

// 共有マテリアルが geometry から読む属性。
const READ_ATTRIBUTES = new Set(['position', 'normal', THERMAL_SHAPE_ATTRIBUTE]);

// 面の向きと熱の形の有無の組 → 共有マテリアル。どちらもシェーダの組み方を変える。
const sharedMaterials = new Map<string, THREE.MeshStandardNodeMaterial>();

// side と、geometry が熱の形の属性を持つか(shaped)に対応する共有マテリアル。
function vertexSurfaceMaterial(side: THREE.Side, shaped: boolean): THREE.MeshStandardNodeMaterial {
  const key = `${side}:${shaped}`;
  const cached = sharedMaterials.get(key);
  if (cached !== undefined) return cached;
  // ベース色・粗さ・金属度を頂点属性から、自照を熱の状態から引く。
  const material = new THREE.MeshStandardNodeMaterial({ name: 'vertex-surface', side });
  material.colorNode = attribute(SURFACE_COLOR_ATTRIBUTE, 'vec3') as unknown as Vec3Node;
  const finish = attribute(SURFACE_FINISH_ATTRIBUTE, 'vec2') as unknown as THREE.Node<'vec2'>;
  material.roughnessNode = finish.x as FloatNode;
  material.metalnessNode = finish.y as FloatNode;
  attachThermalEmissive(material, 'object', shaped);
  sharedMaterials.set(key, material);
  return material;
}

// 素材が色・粗さ・金属度・面の向きだけで決まる標準マテリアルか。テクスチャ・透過・自照の色・
// 頂点色を持つものは頂点属性へ移せない。
function isPlainSurface(material: THREE.Material): material is THREE.MeshStandardMaterial {
  if (!isStandardMaterial(material)) return false;
  const m = material as THREE.MeshStandardMaterial;
  const maps = [m.map, m.roughnessMap, m.metalnessMap, m.normalMap, m.emissiveMap, m.alphaMap,
    m.aoMap, m.lightMap, m.bumpMap, m.displacementMap];
  return maps.every((map) => map === null) && !m.transparent && m.opacity === 1 && m.alphaTest === 0
    && !m.vertexColors && !m.flatShading && !m.wireframe && m.depthTest && m.depthWrite
    && m.emissive.getHex() === 0 && (m as { colorNode?: unknown }).colorNode == null;
}

// root 配下で素材を頂点属性へ移せる Mesh を、素材を焼いた geometry の複製と共有マテリアルへ持ち替える。
// 元の geometry とマテリアルは他の模型と共有されうるので、持ち主の手に残す。
export function bakeVertexSurface(root: THREE.Object3D): void {
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.isMesh !== true || Array.isArray(mesh.material) || !isPlainSurface(mesh.material)) return;
    const material = mesh.material;
    const geometry = mesh.geometry.clone();
    // 共有マテリアルが読まない属性(uv・接線など)を落とし、部品どうしの属性の組を揃える。
    for (const name of Object.keys(geometry.attributes)) {
      if (!READ_ATTRIBUTES.has(name)) geometry.deleteAttribute(name);
    }
    const count = geometry.getAttribute('position').count;
    // 素材の値を全頂点へ同じだけ書く。
    const color = new Float32Array(count * 3);
    const finish = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      color[i * 3] = material.color.r;
      color[i * 3 + 1] = material.color.g;
      color[i * 3 + 2] = material.color.b;
      finish[i * 2] = material.roughness;
      finish[i * 2 + 1] = material.metalness;
    }
    geometry.setAttribute(SURFACE_COLOR_ATTRIBUTE, new THREE.BufferAttribute(color, 3));
    geometry.setAttribute(SURFACE_FINISH_ATTRIBUTE, new THREE.BufferAttribute(finish, 2));
    const shaped = geometry.getAttribute(THERMAL_SHAPE_ATTRIBUTE) !== undefined;
    mesh.geometry = geometry;
    mesh.material = vertexSurfaceMaterial(material.side, shaped);
  });
}
