// 機体・弾・薬莢・破片などのモデルを組み立て、src/assets/models/ へ書き出すツール。
// 小さいモデルは THREE.Object3D.toJSON() でシリアライズして <名前>.json にし、実行時は
// THREE.ObjectLoader でパースして使う。大きいモデルは GLTFExporter で <名前>.glb のバイナリにし、
// 実行時は起動時の fetch で取って GLTFLoader でパースして使う。
//
// 実行: node tools/model-builder/export-models.mjs
//
// 注意: これは 'three' (プレーン NPM パッケージ) を使うツール専用スクリプト。
// src/ 配下では 'three/webgpu' 以外から THREE をインポートしてはならない
// (クラスの重複を避けるため)。
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression } from '@gltf-transform/extensions';
import { reorder } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import { buildDebrisChunk, buildDebrisPanel, buildDebrisRod } from './debris-fragments.mjs';
import { buildCasingMesh, buildMagazineMesh } from './gun-parts.mjs';
import { buildAmmoPickup, buildRcsFuelPickup } from './pickups.mjs';
import { buildBulletMesh, buildPlasmaBullet } from './projectiles.mjs';
import { buildShipModules } from './ship-modules.mjs';

// Node.js 環境での GLTFExporter 用 FileReader ポリフィル
if (typeof globalThis.FileReader === 'undefined') {
  globalThis.FileReader = class FileReader {
    async readAsArrayBuffer(blob) {
      this.result = await blob.arrayBuffer();
      if (this.onloadend) this.onloadend();
    }
    async readAsDataURL(blob) {
      const buffer = Buffer.from(await blob.arrayBuffer());
      this.result = `data:${blob.type};base64,${buffer.toString('base64')}`;
      if (this.onloadend) this.onloadend();
    }
  };
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, '..', '..', 'src', 'assets', 'models');
mkdirSync(outDir, { recursive: true });

// ------------------------------------------------------------- 静的子メッシュの統合
// メッシュ数はそのまま draw call 数になるので、group の直属の Mesh 子を material ごとに1つへ統合する。
// 子 Group は統合せず境界として残す — 蛇腹の折り目のように名前で引いて個別に動かす Group を壊さないため。
function mergeSiblingMeshesByMaterial(group) {
  const byMaterial = new Map();
  for (const child of [...group.children]) {
    if (!child.isMesh) continue;
    const list = byMaterial.get(child.material) ?? [];
    list.push(child);
    byMaterial.set(child.material, list);
  }
  for (const [material, meshes] of byMaterial) {
    if (meshes.length < 2) continue;
    for (const m of meshes) group.remove(m);
    const geometries = meshes.map((m) => {
      m.updateMatrix();
      return m.geometry.clone().applyMatrix4(m.matrix);
    });
    const merged = new THREE.Mesh(mergeGeometries(geometries, false), material);
    for (const geo of geometries) geo.dispose();
    // 統合対象は同一 material を共有する兄弟なので role 等の userData も揃っている前提で、
    // 代表として先頭の子の userData を引き継ぐ(例: マガジンの弾/弾頭の role: 'round')。
    merged.userData = { ...meshes[0].userData };
    group.add(merged);
  }
}

// root 以下の Group ノードを辿り、各 Group ごとに直属メッシュ子を材質統合する。
function mergeStaticChildren(root) {
  const stack = [root];
  while (stack.length > 0) {
    const g = stack.pop();
    for (const child of g.children) {
      if (!child.isMesh && child.children.length > 0) stack.push(child);
    }
    mergeSiblingMeshesByMaterial(g);
  }
}

// glTF には flatShading 相当の指定がない。法線を面ごとに焼くと索引が外れて頂点が数倍に
// 膨らむので、材質の userData(GLB の extras)へ印を残し、読込側(src/render/dynamic/baked-glb.ts)が
// flatShading を戻す。テクスチャを貼らない材質の UV は読まれないので書き出さない。
function prepareForGlb(root) {
  root.traverse((node) => {
    if (!node.isMesh || node.geometry == null) return;
    const materials = Array.isArray(node.material) ? node.material : [node.material];
    for (const material of materials) {
      if (material.flatShading === true) material.userData.flatShading = true;
    }
    if (materials.every((m) => m.map == null) && node.geometry.hasAttribute('uv')) {
      node.geometry.deleteAttribute('uv');
    }
  });
}

// Object3D を binary GLB として outPath へ書き出す。頂点の並びを詰めてから
// EXT_meshopt_compression で圧縮する。方式は FILTER(位置は指数フィルタ、法線は八面体
// フィルタ)に限る — 量子化(KHR_mesh_quantization)は正規化の逆変換をメッシュのノードへ
// 入れて原点を外接箱へ動かすので、名前で引いた部品を回す駆動(weapon-drives.ts)の支点がずれる。
// 復号した属性は float に戻るので、読み手は圧縮の有無を区別しない。
async function exportGlb(object, outPath) {
  const exporter = new GLTFExporter();
  const glbBuffer = await new Promise((resolve, reject) => {
    exporter.parse(
      object,
      (result) => resolve(result),
      (error) => reject(error),
      { binary: true },
    );
  });
  await MeshoptEncoder.ready;
  await MeshoptDecoder.ready;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
    'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder,
  });
  const document = await io.readBinary(new Uint8Array(glbBuffer));
  await document.transform(reorder({ encoder: MeshoptEncoder, target: 'size' }));
  document.createExtension(EXTMeshoptCompression).setRequired(true)
    .setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.FILTER });
  const compressed = await io.writeBinary(document);
  writeFileSync(outPath, compressed);
  console.log(`Wrote ${outPath} (${glbBuffer.byteLength} → ${compressed.byteLength} bytes)`);
}

// ------------------------------------------------------------- 書き出し
const models = {
  bullet:       buildBulletMesh(),
  plasma:       buildPlasmaBullet(),

  casing:       buildCasingMesh(),
  debrisChunk:  buildDebrisChunk(),
  debrisPanel:  buildDebrisPanel(),
  debrisRod:    buildDebrisRod(),
  rcsFuel:      buildRcsFuelPickup(),
};

for (const [name, object] of Object.entries(models)) {
  // toJSON() は各ノードの matrix をそのまま書き、position/quaternion/scale から組み直さない。
  // レンダーループの外では matrix が単位行列のままなので、書き出す前に焼き込む。
  object.updateMatrixWorld(true);
  const json = object.toJSON();
  const outPath = join(outDir, `${name}.json`);
  writeFileSync(outPath, JSON.stringify(json));
  console.log(`Wrote ${outPath}`);
}

// 大きいモデルは統合 GLB バイナリとして書き出し、起動時に fetch して読む。
const glbModels = {
  magazine:     buildMagazineMesh(),
  ammo:         buildAmmoPickup(),
};

for (const [name, object] of Object.entries(glbModels)) {
  mergeStaticChildren(object);
  prepareForGlb(object);
  object.updateMatrixWorld(true);
  await exportGlb(object, join(outDir, `${name}.glb`));
}

const shipModules = await buildShipModules();
mergeStaticChildren(shipModules);
shipModules.updateMatrixWorld(true);
await exportGlb(shipModules, join(outDir, 'ship-modules.glb'));
