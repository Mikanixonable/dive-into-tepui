// プリミティブ組み合わせによるローポリ機体・弾・薬莢・デブリのメッシュ生成。
// 機体の機首は +Z 方向。
import * as THREE from 'three/webgpu';

function std(color: number, opts: Partial<THREE.MeshStandardMaterialParameters> = {}) {
  return new THREE.MeshStandardMaterial({
    color,
    flatShading: true,
    roughness: 0.6,
    metalness: 0.25,
    ...opts,
  });
}

// 機関砲の銃口位置(機体座標系、前面に縦に並んだ 2 つの大きな短い穴)。
// 発砲・マズルフラッシュ・薬莢排出はこの 2 点から交互に行う。
export const MUZZLE_OFFSETS: { x: number; y: number; z: number }[] = [
  { x: 0, y: 0.55, z: 2.55 },
  { x: 0, y: -0.55, z: 2.55 },
];

// RCS スラスタブロックの機体座標(噴射パフの表示位置と一致させるためエクスポート)
export const RCS_BLOCK_OFFSETS: { x: number; y: number; z: number }[] = [
  { x: 1.0, y: 0.85, z: 1.9 },
  { x: -1.0, y: 0.85, z: 1.9 },
  { x: 1.0, y: -0.85, z: 1.9 },
  { x: -1.0, y: -0.85, z: 1.9 },
];

// 自機: 寸胴な直方体。後部に 4 発のエンジン、左右に小さな太陽電池パドル、
// 前面に縦二連の機関砲口を持つ。
export function buildPlayerShip(): THREE.Group {
  const g = new THREE.Group();

  const hull = new THREE.Mesh(new THREE.BoxGeometry(2.2, 2.0, 5.0), std(0xd8dde6));
  g.add(hull);

  // 前面プレート(わずかに暗い色で面の分節を出す)
  const face = new THREE.Mesh(new THREE.BoxGeometry(2.0, 1.8, 0.12), std(0xb8c2cf));
  face.position.z = 2.52;
  g.add(face);

  // 機関砲口: 縦に並んだ 2 つの大きな短い穴(暗い内筒 + 明るいリム)
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

  // 後部エンジン 4 発(2×2)+ ノズルグロー
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

  // 小さな太陽電池パドル(左右)
  const panelMat = std(0x2456c8, { metalness: 0.5, roughness: 0.4 });
  for (const side of [-1, 1]) {
    const panel = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.07, 1.1), panelMat);
    panel.position.set(side * 2.2, 0.4, -1.2);
    g.add(panel);
    const strut = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.1, 0.1), std(0x8a919c));
    strut.position.set(side * 1.4, 0.4, -1.2);
    g.add(strut);
  }

  // RCS スラスタブロック
  const rcsMat = std(0x9aa3ad);
  for (const p of RCS_BLOCK_OFFSETS) {
    const rcs = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.28, 0.28), rcsMat);
    rcs.position.set(p.x, p.y, p.z);
    g.add(rcs);
  }

  // 視認用アクセント灯
  const beacon = new THREE.Mesh(
    new THREE.BoxGeometry(0.18, 0.18, 0.18),
    new THREE.MeshBasicMaterial({ color: 0x4dffc4 }),
  );
  beacon.position.set(0, 1.1, -1.6);
  g.add(beacon);

  return g;
}

// --- マガジン ---
// 寸法(機体座標系): 厚み(上下)は機体全高 2.0 の 1/2(従来比 2 倍)、
// 横幅(ベルト方向 X)は厚みの 4 倍、前後幅(Z)は 3 倍。
// 弾をケージで固定した見た目で、4(上下)×8(横) = 32 発の配列が外から見える
// (MAG_ROUNDS = 32 と 1 対 1 対応)。
export const MAG_THICKNESS = 1.0;
export const MAG_WIDTH = MAG_THICKNESS * 4; // ベルト方向(X)
export const MAG_DEPTH = MAG_THICKNESS * 3; // 前後(Z)
export const MAG_BELT_PITCH = MAG_WIDTH + 0.18; // 連結間隔

const MAG_ROWS = 4;
const MAG_COLS = 8;

const magPlateMat = std(0x6b7280, { metalness: 0.55, roughness: 0.45 });
const magRoundMat = std(0xd9a441, { metalness: 0.85, roughness: 0.35 }); // 薬莢と同じ真鍮色
const magTipMat = std(0x9aa3ad, { metalness: 0.7, roughness: 0.4 });
const magPlateGeo = new THREE.BoxGeometry(MAG_WIDTH, 0.05, MAG_DEPTH);
const magPostGeo = new THREE.BoxGeometry(0.07, MAG_THICKNESS, 0.07);
const magRoundGeo = new THREE.CylinderGeometry(0.11, 0.11, MAG_DEPTH * 0.8, 6);
const magTipGeo = new THREE.ConeGeometry(0.11, 0.16, 6);

export function buildMagazineMesh(): THREE.Group {
  const g = new THREE.Group();
  // 上下プレート(ケージの枠。側面は開いていて弾が見える)
  for (const sy of [-1, 1]) {
    const plate = new THREE.Mesh(magPlateGeo, magPlateMat);
    plate.position.y = sy * (MAG_THICKNESS / 2 - 0.025);
    g.add(plate);
  }
  // 四隅の支柱
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const post = new THREE.Mesh(magPostGeo, magPlateMat);
      post.position.set(sx * (MAG_WIDTH / 2 - 0.06), 0, sz * (MAG_DEPTH / 2 - 0.06));
      g.add(post);
    }
  }
  // 弾: 4(上下)×8(横) = 32 発の配列、+Z(前方)向き
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

// 軌道上に投入される補給マガジン: マガジン数個を束ねてビーコンを付けた漂流物
export function buildMagPickup(count = 4): THREE.Group {
  const g = new THREE.Group();
  for (let i = 0; i < count; i++) {
    const mag = buildMagazineMesh();
    mag.position.y = (i - (count - 1) / 2) * (MAG_THICKNESS + 0.12);
    g.add(mag);
  }
  // 視認用の発光ビーコン(遠距離でも点として見える)
  const beacon = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.35, 0),
    new THREE.MeshBasicMaterial({ color: 0x4de8ff }),
  );
  beacon.position.y = (count / 2) * (MAG_THICKNESS + 0.12) + 0.4;
  g.add(beacon);
  return g;
}

export function buildEnemyShip(accent = 0xff4a3d): THREE.Group {
  const g = new THREE.Group();

  const core = new THREE.Mesh(new THREE.OctahedronGeometry(1.5, 0), std(0x4a4f58));
  core.scale.set(0.8, 0.8, 1.4);
  g.add(core);

  const ringMat = std(0x666d78, { metalness: 0.5 });
  const ring = new THREE.Mesh(new THREE.TorusGeometry(1.6, 0.18, 4, 8), ringMat);
  g.add(ring);

  const finMat = std(accent, { metalness: 0.3, roughness: 0.5 });
  for (let i = 0; i < 4; i++) {
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.5, 1.1), finMat);
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    fin.position.set(Math.cos(a) * 1.7, Math.sin(a) * 1.7, -0.9);
    fin.rotation.z = a + Math.PI / 2;
    g.add(fin);
  }

  // 敵識別用の発光部(遠距離でも点として見える)
  const lampMat = new THREE.MeshBasicMaterial({ color: accent });
  const lamp = new THREE.Mesh(new THREE.OctahedronGeometry(0.45, 0), lampMat);
  lamp.position.z = 1.9;
  g.add(lamp);

  return g;
}

// 進行方向 +Z に伸びる曳光弾(ジオメトリ・マテリアルは全弾で共有)
const bulletGeo = new THREE.BoxGeometry(0.22, 0.22, 6);
const bulletMat = new THREE.MeshBasicMaterial({
  color: 0xffc86e,
  transparent: true,
  opacity: 0.95,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
});

export function buildBulletMesh(): THREE.Mesh {
  const m = new THREE.Mesh(bulletGeo, bulletMat);
  m.frustumCulled = false;
  return m;
}

// 薬莢: 艦砲 CIWS の弾薬をモチーフにしたボトルネック形状。
// リム(抽出溝つき)→ わずかにテーパーした胴 → 肩 → 細いネックを
// 回転体(Lathe)で作る。(半径, 軸方向 y) のプロファイル。
const casingProfile: THREE.Vector2[] = [
  new THREE.Vector2(0.0, -0.52), // 底面中心
  new THREE.Vector2(0.3, -0.52), // リム底
  new THREE.Vector2(0.3, -0.45), // リム上端
  new THREE.Vector2(0.23, -0.45), // 抽出溝へ
  new THREE.Vector2(0.23, -0.39), // 溝
  new THREE.Vector2(0.29, -0.37), // 胴の付け根
  new THREE.Vector2(0.27, 0.26), // 胴(わずかにテーパー)
  new THREE.Vector2(0.16, 0.4), // 肩
  new THREE.Vector2(0.16, 0.52), // ネック
  new THREE.Vector2(0.13, 0.52), // 口
];
const casingGeo = new THREE.LatheGeometry(casingProfile, 12);
const casingMat = new THREE.MeshStandardMaterial({
  color: 0xd9a441,
  metalness: 0.85,
  roughness: 0.35,
});

export function buildCasingMesh(): THREE.Mesh {
  return new THREE.Mesh(casingGeo, casingMat);
}

// 破片: 塊・外板(パネル)・桁(ロッド)の 3 種をランダムに混ぜる。
// 撃破時の飛散と被弾時の欠片の両方で使う。
export function buildDebrisMesh(accent: number, size: number): THREE.Mesh {
  const kind = Math.random();
  let geo: THREE.BufferGeometry;
  if (kind < 0.45) {
    // 不規則な低ポリ塊
    const tetra = new THREE.TetrahedronGeometry(size, 0);
    const pos = tetra.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      pos.setXYZ(
        i,
        pos.getX(i) * (0.6 + Math.random() * 0.9),
        pos.getY(i) * (0.6 + Math.random() * 0.9),
        pos.getZ(i) * (0.6 + Math.random() * 0.9),
      );
    }
    tetra.computeVertexNormals();
    geo = tetra;
  } else if (kind < 0.78) {
    // ちぎれた外板(タンブリングで表裏がチラつき、破片らしく見える)
    geo = new THREE.BoxGeometry(size * (1.2 + Math.random() * 0.8), size * 0.1, size * (0.8 + Math.random() * 0.6));
  } else {
    // 折れた桁・配管
    geo = new THREE.CylinderGeometry(size * 0.1, size * 0.13, size * (1.6 + Math.random()), 5);
  }
  const dark = Math.random() < 0.6;
  const mat = std(dark ? 0x3c4149 : accent, { roughness: 0.8, metalness: 0.2 });
  return new THREE.Mesh(geo, mat);
}

// カメラ方向を向く発光ビルボード(マズルフラッシュ・爆発)
export function buildFlashMesh(texture: THREE.Texture, color: number): THREE.Mesh {
  const mat = new THREE.MeshBasicMaterial({
    map: texture,
    color,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
  m.frustumCulled = false;
  m.renderOrder = 5;
  return m;
}
