// src/render/dynamic/base-station-model.ts の造形から、基地の判定形状(ローポリメッシュ)を焼き出す。
// 部位ごとにメッシュを AABB の接触で連結成分へ分け、成分ごとの凸包を取る。凸包はその成分の
// 全頂点を必ず内側へ含むので、見えている構造を弾がすり抜けることも、見えている面へ自機が
// めり込むことも起きない。細かい部材の足切りはしない — 落とすと判定形状の外へはみ出す。
//
// 実行: node tools/export-base-collision.mjs [--check]
//   --check は焼き直しても差分が出ないことだけを見る(書き換えない)。
//
// 注意: これは 'three' (プレーン NPM パッケージ) を使うツール専用スクリプト。
// src/ 配下では 'three/webgpu' 以外から THREE をインポートしてはならない。
import * as THREE from 'three';
import { ConvexHull } from 'three/examples/jsm/math/ConvexHull.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSourceModules } from './compile-source.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const outPath = join(repoRoot, 'src', 'assets', 'models', 'baseCollision.json');
const checkOnly = process.argv.includes('--check');

// 座標を mm 単位まで残す。判定形状の覆いを見る許容(0.5 m)より 3 桁細かいので、丸めても
// 元の頂点が凸包の外へ出ることはない。
const COORDINATE_SCALE = 1e3;

/** 表示モデルの Mesh を、部位(root 直下の子)ごとに、ワールド座標の頂点と AABB の組で集める。 */
function collectSections(root) {
  return root.children.map((section) => {
    const meshes = [];
    section.traverse((child) => {
      const position = child.isMesh ? child.geometry?.attributes.position : undefined;
      if (!position) return;
      const points = [];
      const box = new THREE.Box3();
      const vertex = new THREE.Vector3();
      for (let i = 0; i < position.count; i++) {
        vertex.fromBufferAttribute(position, i).applyMatrix4(child.matrixWorld);
        points.push(vertex.clone());
        box.expandByPoint(vertex);
      }
      meshes.push({ points, box });
    });
    return meshes;
  });
}

/** AABB が接するメッシュどうしを1つの塊へまとめ、塊ごとの頂点列を返す(union-find)。 */
function connectedChunks(meshes) {
  const parent = meshes.map((_, i) => i);
  const find = (i) => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };
  for (let i = 0; i < meshes.length; i++) {
    for (let j = i + 1; j < meshes.length; j++) {
      if (!meshes[i].box.intersectsBox(meshes[j].box)) continue;
      const a = find(i);
      const b = find(j);
      if (a !== b) parent[a] = b;
    }
  }

  const chunks = new Map();
  for (let i = 0; i < meshes.length; i++) {
    const root = find(i);
    const chunk = chunks.get(root);
    if (chunk === undefined) chunks.set(root, [...meshes[i].points]);
    else chunk.push(...meshes[i].points);
  }
  return [...chunks.values()];
}

// 三角形の外向き法線は実行時に頂点から求めるので、ここでは巻き方だけを揃えて出す。
// ConvexHull の面は a→b→c が外向きになる巻きで、面はすべて三角形。
function pushHull(points, out) {
  const hull = new ConvexHull().setFromPoints(points);
  for (const face of hull.faces) {
    let edge = face.edge;
    do {
      out.indices.push(vertexIndex(out, edge.head().point));
      edge = edge.next;
    } while (edge !== face.edge);
  }
}

// 同じ座標の頂点を1つへ畳む。丸めた整数がそのまま添字表のキーになる。
function vertexIndex(out, point) {
  const x = Math.round(point.x * COORDINATE_SCALE);
  const y = Math.round(point.y * COORDINATE_SCALE);
  const z = Math.round(point.z * COORDINATE_SCALE);
  const key = `${x},${y},${z}`;
  const known = out.byKey.get(key);
  if (known !== undefined) return known;
  const index = out.positions.length / 3;
  out.positions.push(x / COORDINATE_SCALE, y / COORDINATE_SCALE, z / COORDINATE_SCALE);
  out.byKey.set(key, index);
  return index;
}

const { baseStationModel, dispose } = loadSourceModules(['render/dynamic/base-station-model']);
const root = baseStationModel.buildBaseModel();
root.updateMatrixWorld(true);

const out = { positions: [], indices: [], byKey: new Map() };
let chunkCount = 0;
for (const meshes of collectSections(root)) {
  for (const chunk of connectedChunks(meshes)) {
    chunkCount++;
    pushHull(chunk, out);
  }
}
dispose();

const baked = JSON.stringify({ positions: out.positions, indices: out.indices });
const label = `${relative(repoRoot, outPath)} (${chunkCount} chunks, `
  + `${out.positions.length / 3} vertices, ${out.indices.length / 3} triangles)`;

if (checkOnly) {
  if (readFileSync(outPath, 'utf8') !== baked) {
    console.error(`base collision shape differs from ${relative(repoRoot, outPath)}`);
    process.exitCode = 1;
  } else {
    console.log(`base collision shape is up to date: ${label}`);
  }
} else {
  writeFileSync(outPath, baked);
  console.log(`wrote ${label}`);
}
