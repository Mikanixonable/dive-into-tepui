// 機体・弾・薬莢・破片・基地などのモデルを組み立て、THREE.Object3D.toJSON() でシリアライズして
// src/assets/models/<名前>.json に書き出すツール。実行時はこの JSON を THREE.ObjectLoader でパースして使う。
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
import { buildBaseModel } from './base-station.mjs';
import { buildBoosterInterstageCover, buildBoosterStage } from './booster.mjs';
import { buildDebrisChunk, buildDebrisPanel, buildDebrisRod } from './debris-fragments.mjs';
import { buildBarrelMesh, buildCasingMesh, buildMagazineMesh } from './gun-parts.mjs';
import { buildEnemyShip, buildStage0EnemyA, buildStage0EnemyB, buildStage0EnemyC } from './metal-enemies.mjs';
import { buildAmmoPickup, buildRcsFuelPickup } from './pickups.mjs';
import { buildPlayerShip } from './player-ship.mjs';
import { buildBulletMesh, buildPlasmaBullet } from './projectiles.mjs';

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
      if (child.isGroup) stack.push(child);
    }
    mergeSiblingMeshesByMaterial(g);
  }
}

// ------------------------------------------------------------- 書き出し
const models = {
  player:       buildPlayerShip(),
  enemy:        buildEnemyShip(),
  stage0EnemyA: buildStage0EnemyA(),
  stage0EnemyB: buildStage0EnemyB(),
  stage0EnemyC: buildStage0EnemyC(),
  magazine:     buildMagazineMesh(),
  ammo:         buildAmmoPickup(),
  bullet:       buildBulletMesh(),
  plasma:       buildPlasmaBullet(),
  barrel:       buildBarrelMesh(),
  casing:       buildCasingMesh(),
  debrisChunk:  buildDebrisChunk(),
  debrisPanel:  buildDebrisPanel(),
  debrisRod:    buildDebrisRod(),
  base:         buildBaseModel(),
  rcsFuel:      buildRcsFuelPickup(),
  boosterStage: buildBoosterStage(),
  boosterInterstageCover: buildBoosterInterstageCover(),
};

// draw call の大半を占める player と magazine(ammo が束ねる分も)の静的な子メッシュを統合する。
mergeStaticChildren(models.player);
mergeStaticChildren(models.magazine);
mergeStaticChildren(models.ammo);

for (const [name, object] of Object.entries(models)) {
  // toJSON() は各ノードの matrix をそのまま書き、position/quaternion/scale から組み直さない。
  // レンダーループの外では matrix が単位行列のままなので、書き出す前に焼き込む。
  object.updateMatrixWorld(true);
  const json = object.toJSON();
  const outPath = join(outDir, `${name}.json`);
  writeFileSync(outPath, JSON.stringify(json));
  console.log(`Wrote ${outPath}`);
}
