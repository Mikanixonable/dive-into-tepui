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

// ------------------------------------------------------------- 自機

// 自機: テーパードハル + 突き出した砲身 + ベルノズルエンジン + 大型ソーラーパネル
// コックピット窓・アンテナ・アーマーストリップを追加してリッチ化。
// 機首は +Z 方向。MUZZLE_OFFSETS/RCS_BLOCK_OFFSETS 座標は維持。
function buildPlayerShip() {
  const g = new THREE.Group();

  // === ハル(前部は細く後部は太い2段テーパー構成) ===
  const hullMat   = std(0xcdd3de, { metalness: 0.30, roughness: 0.55 });
  const noseMat   = std(0xb2bccb, { metalness: 0.35, roughness: 0.50 });
  const armorMat  = std(0xaab4c2, { metalness: 0.42, roughness: 0.48 });

  // 後部胴体(幅広)
  const rearHull = new THREE.Mesh(new THREE.BoxGeometry(2.3, 2.0, 3.2), hullMat);
  rearHull.position.z = -1.15;
  g.add(rearHull);

  // 前部胴体(若干細め → テーパー感)
  const fwdHull = new THREE.Mesh(new THREE.BoxGeometry(2.0, 1.8, 2.0), hullMat);
  fwdHull.position.z = 1.5;
  g.add(fwdHull);

  // 機首フェイスプレート
  const nose = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.6, 0.14), noseMat);
  nose.position.z = 2.47;
  g.add(nose);

  // 左右アーマーストリップ(縦通材)
  for (const sx of [-1, 1]) {
    const armor = new THREE.Mesh(new THREE.BoxGeometry(0.10, 1.75, 5.0), armorMat);
    armor.position.set(sx * 1.20, 0, -0.10);
    g.add(armor);
  }

  // 上下アーマーストリップ
  for (const sy of [-1, 1]) {
    const strip = new THREE.Mesh(new THREE.BoxGeometry(2.25, 0.09, 5.0), armorMat);
    strip.position.set(0, sy * 1.05, -0.10);
    g.add(strip);
  }

  // === コックピット窓(前面に埋め込み暗窓) ===
  const cockpitMat = new THREE.MeshStandardMaterial({
    color: 0x0a1828, flatShading: true, metalness: 0.12, roughness: 0.18,
  });
  const cockpit = new THREE.Mesh(new THREE.BoxGeometry(0.78, 0.52, 0.05), cockpitMat);
  cockpit.position.set(0, 0.36, 2.51);
  g.add(cockpit);
  // 窓枠
  const frameGeo = new THREE.BoxGeometry(0.90, 0.64, 0.04);
  const frameMesh = new THREE.Mesh(frameGeo, std(0x9aa3ae, { metalness: 0.55, roughness: 0.35 }));
  frameMesh.position.set(0, 0.36, 2.48);
  g.add(frameMesh);

  // === 砲身(銃口位置から前方へ突き出す) ===
  const boreMat    = std(0x10131a, { metalness: 0.55, roughness: 0.65 });
  const rimMat     = std(0x4a5260, { metalness: 0.82, roughness: 0.28 });
  const barrelMat  = std(0x252b34, { metalness: 0.68, roughness: 0.40 });

  for (const m of MUZZLE_OFFSETS) {
    // ハル内部を通る砲身チューブ(z=0.0 〜 z=2.45)
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.28, 2.0, 10), barrelMat);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(m.x, m.y, 1.45);
    g.add(barrel);

    // 砲口カラー(ハル前面との接合部リング)
    const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, 0.10, 10), rimMat);
    collar.rotation.x = Math.PI / 2;
    collar.position.set(m.x, m.y, m.z - 0.42);
    g.add(collar);

    // マズルブレーキ(3連リング)
    for (let ri = 0; ri < 3; ri++) {
      const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.33, 0.30, 0.07, 10), rimMat);
      ring.rotation.x = Math.PI / 2;
      ring.position.set(m.x, m.y, m.z - 0.20 + ri * 0.14);
      g.add(ring);
    }

    // 砲口ボア(最前端の暗い穴)
    const bore = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.16, 10), boreMat);
    bore.rotation.x = Math.PI / 2;
    bore.position.set(m.x, m.y, m.z + 0.04);
    g.add(bore);
  }

  // === エンジン(ベルノズル形状) ===
  const engMat     = std(0x353b44, { metalness: 0.68 });
  const nozzleMat  = std(0x1e2328, { metalness: 0.82, roughness: 0.28 });
  const glowMat    = new THREE.MeshBasicMaterial({ color: 0x77dbff, transparent: true, opacity: 0.92 });
  const heatRingMat = new THREE.MeshBasicMaterial({ color: 0xff7722, transparent: true, opacity: 0.55 });

  // エンジン取付プレート(後端)
  const mountPlate = new THREE.Mesh(
    new THREE.BoxGeometry(2.12, 1.82, 0.18),
    std(0x2e3440, { metalness: 0.52 }),
  );
  mountPlate.position.z = -2.72;
  g.add(mountPlate);

  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      // エンジン外壁(シュラウド)
      const eng = new THREE.Mesh(new THREE.CylinderGeometry(0.27, 0.44, 0.90, 10), engMat);
      eng.rotation.x = Math.PI / 2;
      eng.position.set(sx * 0.60, sy * 0.56, -2.86);
      g.add(eng);

      // ノズルベル(出口方向に広がる)
      const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.44, 0.62, 0.55, 10), nozzleMat);
      nozzle.rotation.x = Math.PI / 2;
      nozzle.position.set(sx * 0.60, sy * 0.56, -3.38);
      g.add(nozzle);

      // ノズル出口エッジリング
      const exitRing = new THREE.Mesh(new THREE.CylinderGeometry(0.63, 0.63, 0.055, 12), rimMat);
      exitRing.rotation.x = Math.PI / 2;
      exitRing.position.set(sx * 0.60, sy * 0.56, -3.68);
      g.add(exitRing);

      // エンジングロー(内部発光)
      const glow = new THREE.Mesh(new THREE.CylinderGeometry(0.20, 0.30, 0.12, 10), glowMat);
      glow.rotation.x = Math.PI / 2;
      glow.position.set(sx * 0.60, sy * 0.56, -3.70);
      g.add(glow);
      // ヒートリングは省略
    }
  }

  // === 太陽電池パネル(大型・フレーム格子付き) ===
  const panelMat   = std(0x1a3a8c, { metalness: 0.38, roughness: 0.52 });
  const panelFrame = std(0x7a838f, { metalness: 0.68, roughness: 0.33 });

  for (const side of [-1, 1]) {
    // パネル面
    const panel = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.055, 1.5), panelMat);
    panel.position.set(side * 2.62, 0.52, -0.90);
    g.add(panel);

    // 外枠(上下 2 本)
    for (const fz of [-0.76, 0.76]) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(2.50, 0.10, 0.07), panelFrame);
      bar.position.set(side * 2.62, 0.52, -0.90 + fz);
      g.add(bar);
    }
    // 外枠(左右 2 本)
    for (const fx of [-1.26, 1.26]) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.10, 1.60), panelFrame);
      bar.position.set(side * 2.62 + fx * side, 0.52, -0.90);
      g.add(bar);
    }
    // 内部格子(縦 2 本)
    for (const dx of [-0.54, 0.54]) {
      const div = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.08, 1.48), panelFrame);
      div.position.set(side * 2.62 + dx * side, 0.52, -0.90);
      g.add(div);
    }

    // パネル接続ストラット
    const strut = new THREE.Mesh(new THREE.BoxGeometry(1.30, 0.10, 0.10), panelFrame);
    strut.position.set(side * 1.78, 0.52, -0.90);
    g.add(strut);
    // 補強ブラケット(Z方向)
    const bracket = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.10, 1.50), panelFrame);
    bracket.position.set(side * 1.18, 0.52, -0.90);
    g.add(bracket);
  }

  // === RCS スラスタ(ノズルリング付き) ===
  const rcsMat      = std(0x9aa3ad, { metalness: 0.52 });
  const rcsNozzMat  = std(0xb5bfc9, { metalness: 0.72, roughness: 0.28 });

  for (const p of RCS_BLOCK_OFFSETS) {
    const rcs = new THREE.Mesh(new THREE.BoxGeometry(0.30, 0.30, 0.30), rcsMat);
    rcs.position.set(p.x, p.y, p.z);
    g.add(rcs);
    // ノズル先端(小さな前向き円筒)
    const nozzleSmall = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.11, 6), rcsNozzMat);
    nozzleSmall.rotation.x = Math.PI / 2;
    nozzleSmall.position.set(p.x, p.y, p.z + 0.21);
    g.add(nozzleSmall);
  }

  // === アンテナ ===
  const antMat = std(0x8a9199, { metalness: 0.72, roughness: 0.30 });
  const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.033, 0.033, 1.50, 5), antMat);
  ant.position.set(0.26, 1.22, 0.32);
  g.add(ant);
  const antTip = new THREE.Mesh(new THREE.SphereGeometry(0.075, 6, 4), std(0xd9e0ea));
  antTip.position.set(0.26, 2.00, 0.32);
  g.add(antTip);

  // === 航法ビーコン ===
  const beacon = new THREE.Mesh(
    new THREE.BoxGeometry(0.16, 0.16, 0.16),
    new THREE.MeshBasicMaterial({ color: 0x4dffc4 }),
  );
  beacon.position.set(0, 1.12, -1.60);
  g.add(beacon);

  return g;
}

// ------------------------------------------------------------- マガジン
const MAG_THICKNESS = 1.0;
const MAG_WIDTH = MAG_THICKNESS * 4;
const MAG_DEPTH = MAG_THICKNESS * 3;
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

// 軌道上に投入される補給マガジン: マガジン数個(既定 4)を束ねてビーコンを付けた漂流物。
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
// セグメント数 8(約半分)に削減。直径を 0.7 倍にしてスリムに。
const CASING_SCALE = 0.7;
const casingProfile = [
  new THREE.Vector2(0.000 * CASING_SCALE, -0.56),  // 内底(中心)
  new THREE.Vector2(0.330 * CASING_SCALE, -0.56),  // リム底面
  new THREE.Vector2(0.330 * CASING_SCALE, -0.47),  // リム側面
  new THREE.Vector2(0.230 * CASING_SCALE, -0.47),  // エクストラクターグルーブ底
  new THREE.Vector2(0.230 * CASING_SCALE, -0.38),  // グルーブ上端
  new THREE.Vector2(0.305 * CASING_SCALE, -0.35),  // ボディ径に戻る
  new THREE.Vector2(0.300 * CASING_SCALE,  0.18),  // ボディ
  new THREE.Vector2(0.175 * CASING_SCALE,  0.34),  // ショルダー
  new THREE.Vector2(0.148 * CASING_SCALE,  0.42),  // ネック
  new THREE.Vector2(0.148 * CASING_SCALE,  0.54),  // ネック先端
  new THREE.Vector2(0.115 * CASING_SCALE,  0.54),  // マウス内径
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


// ------------------------------------------------------------- 書き出し
const models = {
  player:       buildPlayerShip(),
  enemy:        buildEnemyShip(),
  stage0EnemyA: buildStage0EnemyA(),
  stage0EnemyB: buildStage0EnemyB(),
  stage0EnemyC: buildStage0EnemyC(),
  magazine:     buildMagazineMesh(),
  magPickup:    buildMagPickup(),
  bullet:       buildBulletMesh(),
  plasma:       buildPlasmaBullet(),
  casing:       buildCasingMesh(),
  debrisChunk:  buildDebrisChunk(),
  debrisPanel:  buildDebrisPanel(),
  debrisRod:    buildDebrisRod(),
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
