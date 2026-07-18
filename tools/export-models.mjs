// authoring source for asset JSON; see tools/export-models.mjs
// src/render/ships.ts のプリミティブ組み合わせメッシュ生成ロジックを
// (buildFlashMesh を除いて)そのまま複製し、各メッシュを THREE.Object3D.toJSON()
// でシリアライズして src/assets/models/*.json に書き出すツール。
// 実行時 (src/render/ships.ts) はこの JSON を THREE.ObjectLoader でパースし、
// clone(true) して使う — 起動時にジオメトリを組み立て直さない。
//
// 実行: node tools/export-models.mjs
//
// 注意: これは 'three' (プレーン NPM パッケージ) を使うツール専用スクリプト。
// src/ 配下では 'three/webgpu' 以外から THREE をインポートしてはならない
// (クラスの重複を避けるため)。
import * as THREE from 'three';
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

// RCS スラスタブロックの機体座標
const RCS_BLOCK_OFFSETS = [
  { x: 1.0, y: 0.85, z: 1.9 },
  { x: -1.0, y: 0.85, z: 1.9 },
  { x: 1.0, y: -0.85, z: 1.9 },
  { x: -1.0, y: -0.85, z: 1.9 },
];

// 自機: 寸胴な直方体。後部に 4 発のエンジン、左右に小さな太陽電池パドル、
// 前面に縦二連の機関砲口を持つ。
function buildPlayerShip() {
  const g = new THREE.Group();

  const hull = new THREE.Mesh(new THREE.BoxGeometry(2.2, 2.0, 5.0), std(0xd8dde6));
  g.add(hull);

  const face = new THREE.Mesh(new THREE.BoxGeometry(2.0, 1.8, 0.12), std(0xb8c2cf));
  face.position.z = 2.52;
  g.add(face);

  const boreMat = std(0x14161a, { metalness: 0.3, roughness: 0.8 });
  const rimMat = std(0x555c66, { metalness: 0.7, roughness: 0.35 });
  for (const m of MUZZLE_OFFSETS) {
    const bore = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.5, 10), boreMat);
    bore.rotation.x = Math.PI / 2;
    bore.position.set(m.x, m.y, m.z);
    g.add(bore);
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.16, 10), rimMat);
    rim.rotation.x = Math.PI / 2;
    rim.position.set(m.x, m.y, m.z + 0.18);
    g.add(rim);
  }

  const engMat = std(0x3a3f47, { metalness: 0.6 });
  const glowMat = new THREE.MeshBasicMaterial({ color: 0x66d9ff, transparent: true, opacity: 0.9 });
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      const eng = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.46, 0.7, 8), engMat);
      eng.rotation.x = Math.PI / 2;
      eng.position.set(sx * 0.58, sy * 0.55, -2.65);
      g.add(eng);
      const glow = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.34, 0.14, 8), glowMat);
      glow.rotation.x = Math.PI / 2;
      glow.position.set(sx * 0.58, sy * 0.55, -3.02);
      g.add(glow);
    }
  }

  const panelMat = std(0x2456c8, { metalness: 0.5, roughness: 0.4 });
  for (const side of [-1, 1]) {
    const panel = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.07, 1.1), panelMat);
    panel.position.set(side * 2.2, 0.4, -1.2);
    g.add(panel);
    const strut = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.1, 0.1), std(0x8a919c));
    strut.position.set(side * 1.4, 0.4, -1.2);
    g.add(strut);
  }

  const rcsMat = std(0x9aa3ad);
  for (const p of RCS_BLOCK_OFFSETS) {
    const rcs = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.28, 0.28), rcsMat);
    rcs.position.set(p.x, p.y, p.z);
    g.add(rcs);
  }

  const beacon = new THREE.Mesh(
    new THREE.BoxGeometry(0.18, 0.18, 0.18),
    new THREE.MeshBasicMaterial({ color: 0x4dffc4 }),
  );
  beacon.position.set(0, 1.1, -1.6);
  g.add(beacon);

  return g;
}

// --- マガジン ---
const MAG_THICKNESS = 1.0;
const MAG_WIDTH = MAG_THICKNESS * 4;
const MAG_DEPTH = MAG_THICKNESS * 3;
const MAG_ROWS = 4;
const MAG_COLS = 8;

const magPlateMat = std(0x6b7280, { metalness: 0.55, roughness: 0.45 });
const magRoundMat = std(0xd9a441, { metalness: 0.85, roughness: 0.35 });
const magTipMat = std(0x9aa3ad, { metalness: 0.7, roughness: 0.4 });
const magPlateGeo = new THREE.BoxGeometry(MAG_WIDTH, 0.05, MAG_DEPTH);
const magPostGeo = new THREE.BoxGeometry(0.07, MAG_THICKNESS, 0.07);
const magRoundGeo = new THREE.CylinderGeometry(0.11, 0.11, MAG_DEPTH * 0.8, 6);
const magTipGeo = new THREE.ConeGeometry(0.11, 0.16, 6);

function buildMagazineMesh() {
  const g = new THREE.Group();
  for (const sy of [-1, 1]) {
    const plate = new THREE.Mesh(magPlateGeo, magPlateMat);
    plate.position.y = sy * (MAG_THICKNESS / 2 - 0.025);
    g.add(plate);
  }
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const post = new THREE.Mesh(magPostGeo, magPlateMat);
      post.position.set(sx * (MAG_WIDTH / 2 - 0.06), 0, sz * (MAG_DEPTH / 2 - 0.06));
      g.add(post);
    }
  }
  for (let iy = 0; iy < MAG_ROWS; iy++) {
    for (let ix = 0; ix < MAG_COLS; ix++) {
      const x = (ix - (MAG_COLS - 1) / 2) * (MAG_WIDTH / (MAG_COLS * 1.1));
      const y = (iy - (MAG_ROWS - 1) / 2) * (MAG_THICKNESS * 0.24);
      const round = new THREE.Mesh(magRoundGeo, magRoundMat);
      round.rotation.x = Math.PI / 2;
      round.position.set(x, y, 0);
      g.add(round);
      const tip = new THREE.Mesh(magTipGeo, magTipMat);
      tip.rotation.x = Math.PI / 2;
      tip.position.set(x, y, MAG_DEPTH * 0.4 + 0.07);
      g.add(tip);
    }
  }
  return g;
}

// 軌道上に投入される補給マガジン: マガジン数個(既定 4)を束ねてビーコンを付けた漂流物。
// count は実行時にも可変だが、JSON テンプレートは既定値(4 個)で焼き出し、
// 他の個数が要る呼び出し元は現状ないため 1 テンプレートのみで足りる。
function buildMagPickup(count = 4) {
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

// 敵機: 基本(未着色)版を書き出す。アクセントカラーは実行時にマテリアルを
// クローンして差し替える(色ごとに JSON を複製しない)。
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

// 薬莢: 艦砲 CIWS の弾薬をモチーフにしたボトルネック形状(Lathe)。
const casingProfile = [
  new THREE.Vector2(0.0, -0.52),
  new THREE.Vector2(0.3, -0.52),
  new THREE.Vector2(0.3, -0.45),
  new THREE.Vector2(0.23, -0.45),
  new THREE.Vector2(0.23, -0.39),
  new THREE.Vector2(0.29, -0.37),
  new THREE.Vector2(0.27, 0.26),
  new THREE.Vector2(0.16, 0.4),
  new THREE.Vector2(0.16, 0.52),
  new THREE.Vector2(0.13, 0.52),
];

function buildCasingMesh() {
  const geo = new THREE.LatheGeometry(casingProfile, 12);
  const mat = new THREE.MeshStandardMaterial({
    color: 0xd9a441,
    metalness: 0.85,
    roughness: 0.35,
  });
  return new THREE.Mesh(geo, mat);
}

// 破片: ships.ts 側は kind/size/accent/dark をランダムに選ぶが、テンプレートは
// 形状ごとに固定サイズ(size=1)で書き出し、実行時に scale と material.color で
// 個体差(size, accent/dark)を付ける。
// 単位(size=1, ジッタなし)のテトラヒドロン。実行時に buildDebrisMesh() が
// 頂点ごとの乱数ジッタ(0.6〜1.5倍)を加えたうえで scale.setScalar(size) する
// ため、ここでは素の形状のみを焼き出す。
function buildDebrisChunk() {
  const tetra = new THREE.TetrahedronGeometry(1, 0);
  return new THREE.Mesh(tetra, std(0x3c4149, { roughness: 0.8, metalness: 0.2 }));
}

// 単位立方体(1x1x1)。実行時に buildDebrisMesh() が
// scale.set(size*(1.2+rand*0.8), size*0.1, size*(0.8+rand*0.6)) で
// 元の乱数幅の伸縮を再現する(このテンプレート自体は伸縮を含まない)。
function buildDebrisPanel() {
  const geo = new THREE.BoxGeometry(1, 1, 1);
  return new THREE.Mesh(geo, std(0x3c4149, { roughness: 0.8, metalness: 0.2 }));
}

// 半径比(0.1:0.13)のみ焼き込んだ単位高さ(=1)の円柱。実行時に
// scale.set(size, size*(1.6+rand), size) で高さの乱数幅を再現する。
function buildDebrisRod() {
  const geo = new THREE.CylinderGeometry(0.1, 0.13, 1, 5);
  return new THREE.Mesh(geo, std(0x3c4149, { roughness: 0.8, metalness: 0.2 }));
}

const models = {
  player: buildPlayerShip(),
  enemy: buildEnemyShip(),
  magazine: buildMagazineMesh(),
  magPickup: buildMagPickup(),
  bullet: buildBulletMesh(),
  casing: buildCasingMesh(),
  debrisChunk: buildDebrisChunk(),
  debrisPanel: buildDebrisPanel(),
  debrisRod: buildDebrisRod(),
};

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
