// authoring source for asset JSON; see tools/export-models.mjs
// 敵艦・弾丸・薬莢・破片・マガジンのメッシュを組み立て、THREE.Object3D.toJSON() で
// シリアライズして src/assets/models/*.json に書き出すツール。自機の外皮は設計から
// 生成する(src/game/vessel/hull-mesh.ts)ので、ここには無い。
// 実行時 (src/render/ships.ts) はこの JSON を THREE.ObjectLoader でパースし、
// clone(true) して使う — 起動時にジオメトリを組み立て直さない。
//
// 実行: node tools/export-models.mjs
//
// 注意: これは 'three' (プレーン NPM パッケージ) を使うツール専用スクリプト。
// src/ 配下では 'three/webgpu' 以外から THREE をインポートしてはならない
// (クラスの重複を避けるため)。
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, '..', 'src', 'assets', 'models');
mkdirSync(outDir, { recursive: true });



function std(color, opts = {}) {
  return new THREE.MeshStandardMaterial({
    color,
    flatShading: true,
    roughness: 0.6,
    metalness: 0.25,
    ...opts,
  });
}

// 機関砲の銃口位置(機体座標系、前面に縦に並んだ 2 つの大きな短い穴)。
const MUZZLE_OFFSETS = [
  { x: 0, y: 0.55, z: 2.55 },
  { x: 0, y: -0.55, z: 2.55 },
];

// ------------------------------------------------------------- マガジン
const MAG_THICKNESS = 1.0;
const MAG_WIDTH = MAG_THICKNESS * 4 * (2 / 3);
const MAG_DEPTH = MAG_THICKNESS * 3 * (2 / 3);
const MAG_ROWS = 4;
const MAG_COLS = 8;

const magPlateMat  = std(0x6b7280, { metalness: 0.58, roughness: 0.42 });
const magRoundMat  = std(0xd4983a, { metalness: 0.88, roughness: 0.32 }); // 真鍮色
const magTipMat    = std(0x9faab5, { metalness: 0.74, roughness: 0.36 }); // シルバーチップ
const magPlateGeo  = new THREE.BoxGeometry(MAG_WIDTH, 0.055, MAG_DEPTH);
const magPostGeo   = new THREE.BoxGeometry(0.07, MAG_THICKNESS, 0.07);
const magRoundGeo  = new THREE.CylinderGeometry(0.11, 0.11, MAG_DEPTH * 0.8, 8); // 8セグメントでやや滑らか
const magTipGeo    = new THREE.ConeGeometry(0.11, 0.18, 8);

function buildMagazineMesh() {
  const g = new THREE.Group();

  // 上下プレート
  for (const sy of [-1, 1]) {
    const plate = new THREE.Mesh(magPlateGeo, magPlateMat);
    plate.position.y = sy * (MAG_THICKNESS / 2 - 0.028);
    g.add(plate);
  }

  // 左右サイドパネル(X方向の壁)
  const sideGeo = new THREE.BoxGeometry(0.07, MAG_THICKNESS * 0.90, MAG_DEPTH);
  for (const sx of [-1, 1]) {
    const side = new THREE.Mesh(sideGeo, magPlateMat);
    side.position.set(sx * (MAG_WIDTH / 2 - 0.04), 0, 0);
    g.add(side);
  }

  // 4隅ポスト
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const post = new THREE.Mesh(magPostGeo, magPlateMat);
      post.position.set(sx * (MAG_WIDTH / 2 - 0.06), 0, sz * (MAG_DEPTH / 2 - 0.06));
      g.add(post);
    }
  }

  // フィードリップ(+Z 先端・給弾口突起)
  const feedLipGeo = new THREE.BoxGeometry(MAG_WIDTH * 0.38, MAG_THICKNESS * 0.28, 0.13);
  const feedLip = new THREE.Mesh(feedLipGeo, magPlateMat);
  feedLip.position.set(0, 0, MAG_DEPTH / 2 + 0.05);
  g.add(feedLip);

  // === 切込み・段差でシルエットに厚みを出す ===
  const recessMat = std(0x50585f, { metalness: 0.65, roughness: 0.48 });
  const ridgeMat  = std(0x7e8894, { metalness: 0.55, roughness: 0.42 });

  // 上下面: 前後方向に走る溝(くぼみを外側に出っ張る溝で近似)
  for (const sy of [-1, 1]) {
    // 中央溝レール(上面/下面を横切る)
    const groove = new THREE.Mesh(
      new THREE.BoxGeometry(MAG_WIDTH * 0.55, 0.06, MAG_DEPTH * 0.80),
      recessMat,
    );
    groove.position.set(0, sy * (MAG_THICKNESS / 2 + 0.03), 0);
    g.add(groove);

    // 前後の段付きリブ(ショルダー)
    for (const sz of [-0.85, 0.85]) {
      const rib = new THREE.Mesh(
        new THREE.BoxGeometry(MAG_WIDTH * 0.80, 0.07, 0.12),
        ridgeMat,
      );
      rib.position.set(0, sy * (MAG_THICKNESS / 2 + 0.035), sz);
      g.add(rib);
    }
  }

  // 前後面: 縦方向の段差ライン
  for (const sz of [-1, 1]) {
    // 左右の縦段差
    for (const sx of [-1, 1]) {
      const ledge = new THREE.Mesh(
        new THREE.BoxGeometry(0.10, MAG_THICKNESS * 0.70, 0.07),
        recessMat,
      );
      ledge.position.set(sx * (MAG_WIDTH / 2 - 0.30), 0, sz * (MAG_DEPTH / 2 + 0.02));
      g.add(ledge);
    }
  }

  // サイド: ベルト案内レール(左右面中央に浮き出たリブ)
  const railGeo = new THREE.BoxGeometry(0.06, MAG_THICKNESS * 0.60, MAG_DEPTH * 0.75);
  for (const sx of [-1, 1]) {
    const rail = new THREE.Mesh(railGeo, ridgeMat);
    rail.position.set(sx * (MAG_WIDTH / 2 + 0.02), 0, 0);
    g.add(rail);
  }

  // 弾(実弾: 薬莢ボディ + シルバーチップ)
  for (let iy = 0; iy < MAG_ROWS; iy++) {
    for (let ix = 0; ix < MAG_COLS; ix++) {
      const x = (ix - (MAG_COLS - 1) / 2) * (MAG_WIDTH / (MAG_COLS * 1.1));
      const y = (iy - (MAG_ROWS - 1) / 2) * (MAG_THICKNESS * 0.24);

      const round = new THREE.Mesh(magRoundGeo, magRoundMat);
      round.rotation.x = Math.PI / 2;
      round.position.set(x, y, 0);
      round.userData = { role: 'round' };
      g.add(round);

      const tip = new THREE.Mesh(magTipGeo, magTipMat);
      tip.rotation.x = Math.PI / 2;
      tip.position.set(x, y, MAG_DEPTH * 0.40 + 0.08);
      tip.userData = { role: 'round' };
      g.add(tip);
    }
  }

  return g;
}

// 軌道上の弾薬補給ピックアップ。マガジン数個(既定 4)とビーコンを束ねる。
function buildAmmoPickup(count = 4) {
  const g = new THREE.Group();
  for (let i = 0; i < count; i++) {
    const mag = buildMagazineMesh();
    mag.position.y = (i - (count - 1) / 2) * (MAG_THICKNESS + 0.12);
    g.add(mag);
  }
  const beacon = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.35, 0),
    new THREE.MeshBasicMaterial({ color: 0x4de8ff }),
  );
  beacon.position.y = (count / 2) * (MAG_THICKNESS + 0.12) + 0.4;
  g.add(beacon);
  return g;
}

// ------------------------------------------------------------- 敵機
// 敵機: 基本(未着色)版を書き出す。アクセントカラーは実行時にマテリアルをクローンして差し替える。
function buildEnemyShip() {
  const accent = 0xff4a3d; // プレースホルダ(実行時に上書きされる)
  const g = new THREE.Group();

  const core = new THREE.Mesh(new THREE.OctahedronGeometry(1.5, 0), std(0x4a4f58));
  core.scale.set(0.8, 0.8, 1.4);
  g.add(core);

  const ringMat = std(0x666d78, { metalness: 0.5 });
  const ring = new THREE.Mesh(new THREE.TorusGeometry(1.6, 0.18, 4, 8), ringMat);
  g.add(ring);

  const finMat = std(accent, { metalness: 0.3, roughness: 0.5 });
  finMat.userData = { role: 'accent' };
  for (let i = 0; i < 4; i++) {
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.5, 1.1), finMat);
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    fin.position.set(Math.cos(a) * 1.7, Math.sin(a) * 1.7, -0.9);
    fin.rotation.z = a + Math.PI / 2;
    g.add(fin);
  }

  const lampMat = new THREE.MeshBasicMaterial({ color: accent });
  lampMat.userData = { role: 'accent' };
  const lamp = new THREE.Mesh(new THREE.OctahedronGeometry(0.45, 0), lampMat);
  lamp.position.z = 1.9;
  g.add(lamp);

  return g;
}

// ------------------------------------------------------------- 弾

// 進行方向 +Z に伸びる曳光弾
function buildBulletMesh() {
  const geo = new THREE.BoxGeometry(0.22, 0.22, 6);
  const mat = new THREE.MeshBasicMaterial({
    color: 0xffc86e,
    transparent: true,
    opacity: 0.95,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  return new THREE.Mesh(geo, mat);
}

// ------------------------------------------------------------- 薬莢
// CIWS 艦砲弾薬をモチーフにしたボトルネック Lathe 形状。
// セグメント数 8(約半分)に削減。直径を 0.7 倍にしてスリムに、全長を 2/3 倍に短縮。
const CASING_SCALE = 0.7;
const CASING_LENGTH_SCALE = 2 / 3;
const casingProfile = [
  new THREE.Vector2(0.000 * CASING_SCALE, -0.56 * CASING_LENGTH_SCALE),  // 内底(中心)
  new THREE.Vector2(0.330 * CASING_SCALE, -0.56 * CASING_LENGTH_SCALE),  // リム底面
  new THREE.Vector2(0.330 * CASING_SCALE, -0.47 * CASING_LENGTH_SCALE),  // リム側面
  new THREE.Vector2(0.230 * CASING_SCALE, -0.47 * CASING_LENGTH_SCALE),  // エクストラクターグルーブ底
  new THREE.Vector2(0.230 * CASING_SCALE, -0.38 * CASING_LENGTH_SCALE),  // グルーブ上端
  new THREE.Vector2(0.305 * CASING_SCALE, -0.35 * CASING_LENGTH_SCALE),  // ボディ径に戻る
  new THREE.Vector2(0.300 * CASING_SCALE,  0.18 * CASING_LENGTH_SCALE),  // ボディ
  new THREE.Vector2(0.175 * CASING_SCALE,  0.34 * CASING_LENGTH_SCALE),  // ショルダー
  new THREE.Vector2(0.148 * CASING_SCALE,  0.42 * CASING_LENGTH_SCALE),  // ネック
  new THREE.Vector2(0.148 * CASING_SCALE,  0.54 * CASING_LENGTH_SCALE),  // ネック先端
  new THREE.Vector2(0.115 * CASING_SCALE,  0.54 * CASING_LENGTH_SCALE),  // マウス内径
];

function buildCasingMesh() {
  const geo = new THREE.LatheGeometry(casingProfile, 8); // 8セグメント(ポリゴン数約半分)
  const mat = new THREE.MeshStandardMaterial({
    color: 0xcf9432,
    metalness: 0.90,
    roughness: 0.28,
  });
  return new THREE.Mesh(geo, mat);
}

// ------------------------------------------------------------- 破片
// 形状ごとに固定サイズ(size=1)で書き出し、実行時に scale と material.color で個体差を付ける。

function buildDebrisChunk() {
  const tetra = new THREE.TetrahedronGeometry(1, 0);
  return new THREE.Mesh(tetra, std(0x3c4149, { roughness: 0.8, metalness: 0.2 }));
}

function buildDebrisPanel() {
  const geo = new THREE.BoxGeometry(1, 1, 1);
  return new THREE.Mesh(geo, std(0x3c4149, { roughness: 0.8, metalness: 0.2 }));
}

function buildDebrisRod() {
  const geo = new THREE.CylinderGeometry(0.1, 0.13, 1, 5);
  return new THREE.Mesh(geo, std(0x3c4149, { roughness: 0.8, metalness: 0.2 }));
}

// ------------------------------------------------------------- ステージ0 敵機

function buildStage0EnemyA() {
  const accent = 0x3dc6ff;
  const g = new THREE.Group();

  const core = new THREE.Mesh(new THREE.IcosahedronGeometry(1.2, 0), std(0x4a4f58));
  g.add(core);

  const ligandMat = std(accent, { metalness: 0.4, roughness: 0.4 });
  ligandMat.userData = { role: 'accent' };
  const bondMat = std(0x666d78, { metalness: 0.6 });

  const positions = [
    new THREE.Vector3(2.2, 0, 0),
    new THREE.Vector3(-2.2, 0, 0),
    new THREE.Vector3(0, 2.2, 0),
    new THREE.Vector3(0, -2.2, 0),
    new THREE.Vector3(0, 0, 2.2),
    new THREE.Vector3(0, 0, -2.2),
  ];

  for (const pos of positions) {
    const ligand = new THREE.Mesh(new THREE.IcosahedronGeometry(0.6, 0), ligandMat);
    ligand.position.copy(pos);
    g.add(ligand);

    const bondLen = pos.length() - 1.2;
    const bond = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, bondLen, 5), bondMat);
    bond.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), pos.clone().normalize());
    bond.position.copy(pos.clone().normalize().multiplyScalar(1.2 + bondLen / 2));
    g.add(bond);
  }

  const ringMat = std(0x8a919c, { metalness: 0.5 });
  const ring1 = new THREE.Mesh(new THREE.TorusGeometry(2.2, 0.1, 4, 12), ringMat);
  ring1.rotation.x = Math.PI / 2;
  g.add(ring1);
  const ring2 = new THREE.Mesh(new THREE.TorusGeometry(2.2, 0.1, 4, 12), ringMat);
  ring2.rotation.y = Math.PI / 2;
  g.add(ring2);

  return g;
}

function buildStage0EnemyB() {
  const accent = 0x3dc6ff;
  const g = new THREE.Group();

  const core = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.5, 0.6, 8), std(0x4a4f58));
  core.rotation.x = Math.PI / 2;
  g.add(core);

  const ligandMat = std(accent, { metalness: 0.4, roughness: 0.4 });
  ligandMat.userData = { role: 'accent' };

  const ring = new THREE.Mesh(new THREE.TorusGeometry(2.5, 0.2, 8, 16), std(0x666d78, { metalness: 0.6 }));
  g.add(ring);

  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    const pod = new THREE.Mesh(new THREE.SphereGeometry(0.7, 8, 8), ligandMat);
    pod.position.set(Math.cos(a) * 2.5, Math.sin(a) * 2.5, 0);
    g.add(pod);
  }

  return g;
}

function buildStage0EnemyC() {
  const accent = 0x3dc6ff;
  const g = new THREE.Group();

  const core = new THREE.Mesh(new THREE.TetrahedronGeometry(1.8, 0), std(0x4a4f58));
  g.add(core);

  const ligandMat = std(accent, { metalness: 0.4, roughness: 0.4 });
  ligandMat.userData = { role: 'accent' };

  const positions = [
    new THREE.Vector3(1, 1, 1),
    new THREE.Vector3(-1, -1, 1),
    new THREE.Vector3(-1, 1, -1),
    new THREE.Vector3(1, -1, -1),
  ];

  for (const p of positions) {
    p.normalize().multiplyScalar(2.4);
    const spike = new THREE.Mesh(new THREE.ConeGeometry(0.5, 2.0, 4), ligandMat);
    spike.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), p.clone().normalize());
    spike.position.copy(p);
    g.add(spike);
  }

  return g;
}

// ------------------------------------------------------------- プラズマ弾
function buildPlasmaBullet() {
  const geo = new THREE.CylinderGeometry(0.2, 0.2, 4.0, 5);
  geo.rotateX(Math.PI / 2);
  const mat = new THREE.MeshBasicMaterial({
    color: 0x3dc6ff,
    transparent: true,
    opacity: 0.95,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  return new THREE.Mesh(geo, mat);
}


// ------------------------------------------------------------- 静的子メッシュの統合
// 実行時にはメッシュ数がそのまま draw call 数になるため、互いに相対運動しない
// (= 実行時に個別の Object3D として名前検索・変換されない)兄弟メッシュは
// 構築時にジオメトリごと1つへ統合し、draw call を減らす。
// group の直属の Mesh 子だけを対象に、同一 material 参照ごとにジオメトリを
// ワールド変換込みで結合する。子 Group には踏み込まない(呼び出し側が
// mergeStaticChildren で再帰する)ので、蛇腹の折り目 Group のように実行時に
// getObjectByName で引いて個別に rotation を書く Group は、その子だけが
// 統合され、Group 自身は境界として保たれる。
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
  enemy:        buildEnemyShip(),
  stage0EnemyA: buildStage0EnemyA(),
  stage0EnemyB: buildStage0EnemyB(),
  stage0EnemyC: buildStage0EnemyC(),
  magazine:     buildMagazineMesh(),
  ammo:         buildAmmoPickup(),
  bullet:       buildBulletMesh(),
  plasma:       buildPlasmaBullet(),
  casing:       buildCasingMesh(),
  debrisChunk:  buildDebrisChunk(),
  debrisPanel:  buildDebrisPanel(),
  debrisRod:    buildDebrisRod(),
};

// magazine(ammo が内包する分も含む)は draw call 数の大半を占めるため、
// 静的な子メッシュを統合する。他のモデルは対象が少なく現状のままでよい。
mergeStaticChildren(models.magazine);
mergeStaticChildren(models.ammo);

for (const [name, object] of Object.entries(models)) {
  // toJSON() は各ノードの `matrix` プロパティをそのままシリアライズするだけで、
  // position/rotation/scale から再合成はしない。ここはレンダーループの外(ヘッド
  // レスな export スクリプト)なので、three.js が通常フレーム毎に自動で行う
  // updateMatrix() が一度も呼ばれておらず、matrix は単位行列のまま出力されてしまう
  // (= ObjectLoader.parse() 側で decompose しても位置・回転が全部ゼロになる)。
  // toJSON() の前に明示的に updateMatrixWorld(true) を呼び、全ノードの matrix に
  // position/quaternion/scale を焼き込んでからシリアライズする。
  object.updateMatrixWorld(true);
  const json = object.toJSON();
  const outPath = join(outDir, `${name}.json`);
  writeFileSync(outPath, JSON.stringify(json));
  console.log(`Wrote ${outPath}`);
}
