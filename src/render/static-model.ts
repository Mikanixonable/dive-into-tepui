// 複製して使う模型のテンプレートを、描画の負荷が小さい形へ 1 度だけ下ごしらえする。互いに動かない
// 部品は 1 枚のメッシュへ焼き合わせ、外から動かされたり位置を引かれたりする節(境界)は残す。部品は
// 自分を含む最も近い境界の座標系へ焼くので、境界を動かせば中の部品も一緒に動く。
import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { markLitOpaque, markShadowCaster } from './pipeline/lit-layer';
import { makeThermallyEmissive } from './thermal-emissive';
import { bakeVertexSurface } from './vertex-surface-material';

// root を下ごしらえする。素材を頂点属性へ焼いて共有マテリアルへ持ち替え、静的な部品を境界ごとに
// 焼き合わせ、熱発光と照明・影の層を印す。isBoundary が真の節は外から動かされうるものとして残す
// (省けば root だけが境界)。root はこのあと複製の元としてだけ使う。
export function prepareStaticModel(
  root: THREE.Object3D, isBoundary: (object: THREE.Object3D) => boolean = () => false,
): void {
  bakeVertexSurface(root);
  mergeStaticMeshes(root, isBoundary);
  makeThermallyEmissive(root);
  markLitOpaque(root);
  markShadowCaster(root);
}

// root 配下の静的な葉メッシュを、境界ごと・描画の設定ごとに 1 枚へ焼き合わせる。root 自身も境界として
// 扱う。焼き合わせた元のメッシュは外し、それで空になった中継の節も畳む。元の geometry は他の模型と
// 共有されうるので、持ち主の手に残す。
function mergeStaticMeshes(root: THREE.Object3D, isBoundary: (object: THREE.Object3D) => boolean): void {
  root.updateMatrixWorld(true);
  // 境界 → 描画の設定の鍵 → 束ねるメッシュ。
  const batches = new Map<THREE.Object3D, Map<string, THREE.Mesh[]>>();
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (object === root || !isMergeable(mesh) || isBoundary(mesh)) return;
    const boundary = visibleBoundaryOf(mesh, root, isBoundary);
    if (boundary === null) return;
    const byKey = batches.get(boundary) ?? new Map<string, THREE.Mesh[]>();
    batches.set(boundary, byKey);
    const key = batchKey(mesh);
    byKey.set(key, [...(byKey.get(key) ?? []), mesh]);
  });

  const emptied = new Set<THREE.Object3D>();
  for (const [boundary, byKey] of batches) {
    const toBoundary = new THREE.Matrix4().copy(boundary.matrixWorld).invert();
    for (const meshes of byKey.values()) {
      if (meshes.length < 2) continue;
      boundary.add(mergedMesh(meshes, toBoundary));
      // 元の部品を外し、親が空になったかは後でまとめて見る。
      for (const mesh of meshes) {
        const parent = mesh.parent;
        mesh.removeFromParent();
        if (parent !== null && parent !== boundary) emptied.add(parent);
      }
    }
  }
  for (const node of emptied) pruneEmptyChain(node, root, isBoundary);
}

// 焼き合わせてよい葉メッシュか。子を持つもの・複数マテリアル・変形するもの・インスタンス描画は除く。
function isMergeable(mesh: THREE.Mesh): boolean {
  if (mesh.isMesh !== true || mesh.children.length > 0) return false;
  if (Array.isArray(mesh.material)) return false;
  const special = mesh as THREE.Mesh & { isInstancedMesh?: boolean; isSkinnedMesh?: boolean; isBatchedMesh?: boolean };
  if (special.isInstancedMesh === true || special.isSkinnedMesh === true || special.isBatchedMesh === true) return false;
  return Object.keys(mesh.geometry.morphAttributes).length === 0;
}

// mesh から上へ辿った最も近い境界(root を含む)。途中に隠れた節があれば null — 焼き合わせると、
// 隠れていた部品が見えてしまう。
function visibleBoundaryOf(
  mesh: THREE.Mesh, root: THREE.Object3D, isBoundary: (object: THREE.Object3D) => boolean,
): THREE.Object3D | null {
  if (!mesh.visible) return null;
  for (let node = mesh.parent; node !== null; node = node.parent) {
    if (node === root || isBoundary(node)) return node;
    if (!node.visible) return null;
  }
  return null;
}

// 同じ 1 枚へ束ねてよいメッシュが同じ値を持つ鍵。マテリアル、属性の組、描画の振る舞いを揃える。
function batchKey(mesh: THREE.Mesh): string {
  const geometry = mesh.geometry;
  // 属性は名前と形まで揃っていないと 1 本の頂点列へ連結できない。
  const attributes = Object.keys(geometry.attributes).sort().map((name) => {
    const attribute = geometry.getAttribute(name);
    return `${name}:${attribute.itemSize}:${attribute.normalized}:${attribute.array.constructor.name}`;
  });
  const material = mesh.material as THREE.Material;
  return [
    material.uuid, attributes.join(','), mesh.layers.mask, mesh.castShadow, mesh.receiveShadow,
    mesh.renderOrder, mesh.frustumCulled,
  ].join('|');
}

// meshes を境界の座標系(toBoundary は境界の世界行列の逆)へ焼いて 1 枚のメッシュにする。描画の
// 振る舞いは先頭のメッシュから写す(鍵で揃っている)。
function mergedMesh(meshes: readonly THREE.Mesh[], toBoundary: THREE.Matrix4): THREE.Mesh {
  const relative = new THREE.Matrix4();
  const baked = meshes.map((mesh) => {
    relative.multiplyMatrices(toBoundary, mesh.matrixWorld);
    const geometry = mesh.geometry.clone().applyMatrix4(relative);
    // 索引の有無が混ざると束ねられないので、索引の無いものへ頂点順の索引を付ける。
    if (geometry.index === null) geometry.setIndex([...Array(geometry.getAttribute('position').count).keys()]);
    // 鏡映の変換は三角形の巻き順を裏返すので、表の向きを保つよう巻き順を戻す。
    if (relative.determinant() < 0) reverseWinding(geometry);
    return geometry;
  });
  const merged = mergeGeometries(baked, false);
  for (const geometry of baked) geometry.dispose();
  if (merged === null) throw new Error(`cannot merge static meshes: ${meshes.map((mesh) => mesh.name).join(', ')}`);
  const first = meshes[0]!;
  const mesh = new THREE.Mesh(merged, first.material);
  mesh.name = `merged:${(first.material as THREE.Material).name}`;
  mesh.layers.mask = first.layers.mask;
  mesh.castShadow = first.castShadow;
  mesh.receiveShadow = first.receiveShadow;
  mesh.renderOrder = first.renderOrder;
  mesh.frustumCulled = first.frustumCulled;
  return mesh;
}

// 索引付きの geometry の各三角形の巻き順を逆にする。
function reverseWinding(geometry: THREE.BufferGeometry): void {
  const index = geometry.index!;
  for (let i = 0; i + 2 < index.count; i += 3) {
    const b = index.getX(i + 1);
    index.setX(i + 1, index.getX(i + 2));
    index.setX(i + 2, b);
  }
}

// node から上へ、境界でも root でもなく子を失った節を畳む。
function pruneEmptyChain(
  node: THREE.Object3D, root: THREE.Object3D, isBoundary: (object: THREE.Object3D) => boolean,
): void {
  let current: THREE.Object3D | null = node;
  while (current !== null && current !== root && !isBoundary(current) && current.children.length === 0) {
    const parent: THREE.Object3D | null = current.parent;
    current.removeFromParent();
    current = parent;
  }
}
