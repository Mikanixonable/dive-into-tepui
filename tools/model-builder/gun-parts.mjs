// 機関砲の弾薬と消耗部品のモデル — 実弾入りのマガジン、薬莢、放出される砲身。
import * as THREE from 'three';
import { loadSourceModules } from '../compile-source.mjs';
import { F0_ALUMINIUM, F0_BRASS, F0_BURNT_STEEL, F0_STEEL, std } from './materials.mjs';

const thermalSource = loadSourceModules(['render/thermal-emissive']);
const { THERMAL_SHAPE_ATTRIBUTE } = thermalSource.thermalEmissive;
thermalSource.dispose();

// ------------------------------------------------------------- マガジン
export const MAG_THICKNESS = 1.0;
const MAG_WIDTH = MAG_THICKNESS * 4 * (2 / 3);
const MAG_DEPTH = MAG_THICKNESS * 3 * (2 / 3);
const MAG_ROWS = 4;
const MAG_COLS = 8;

const magPlateMat  = std(F0_STEEL, { metalness: 1, roughness: 0.42 });
const magRoundMat  = std(F0_BRASS, { metalness: 1, roughness: 0.32 }); // 真鍮色
const magTipMat    = std(F0_ALUMINIUM, { metalness: 1, roughness: 0.36 }); // シルバーチップ
const magPlateGeo  = new THREE.BoxGeometry(MAG_WIDTH, 0.055, MAG_DEPTH);
const magPostGeo   = new THREE.BoxGeometry(0.07, MAG_THICKNESS, 0.07);
const magRoundGeo  = new THREE.CylinderGeometry(0.11, 0.11, MAG_DEPTH * 0.8, 8); // 8セグメントでやや滑らか
const magTipGeo    = new THREE.ConeGeometry(0.11, 0.18, 8);

export function buildMagazineMesh() {
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
  const recessMat = std(F0_BURNT_STEEL, { metalness: 1, roughness: 0.48 });
  const ridgeMat  = std(F0_STEEL, { metalness: 1, roughness: 0.42 });

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

export function buildCasingMesh() {
  const geo = new THREE.LatheGeometry(casingProfile, 8); // 8セグメント(ポリゴン数約半分)
  const mat = new THREE.MeshStandardMaterial({
    color: F0_BRASS,
    metalness: 1,
    roughness: 0.28,
  });
  return new THREE.Mesh(geo, mat);
}

// ------------------------------------------------------------- 砲身
// リロード時に放出される砲身。砲身本体 + 後端フランジ + 放熱フィン + マズルブレーキ + ガスポート。

// 薬室の位置 [m] と、そこから砲口へ向かって温度差が落ちる長さ [m]。発射ガスは銃身に沿って
// 熱を置いていくので、薬室側がいちばん熱く、砲口へ向かって指数で下がる。
const BARREL_BREECH_Z = -2.3;
const BARREL_HEAT_FALLOFF = 1.2;

// 砲身の各メッシュへ、平均温度からの温度差の分布(薬室側 1、砲口側 0)を焼く。
function bakeBarrelThermalShape(root) {
  const vertex = new THREE.Vector3();
  root.traverse((child) => {
    if (!child.isMesh) return;
    child.updateMatrix();
    // 形状パラメータを持つ型のままだと toJSON が足した属性を書き出さないので、素の BufferGeometry へ写す。
    const geometry = new THREE.BufferGeometry().copy(child.geometry);
    const position = geometry.getAttribute('position');
    const shape = new Float32Array(position.count);
    for (let i = 0; i < position.count; i++) {
      vertex.fromBufferAttribute(position, i).applyMatrix4(child.matrix);
      shape[i] = Math.min(1, Math.exp(-(vertex.z - BARREL_BREECH_Z) / BARREL_HEAT_FALLOFF));
    }
    geometry.setAttribute(THERMAL_SHAPE_ATTRIBUTE, new THREE.Float32BufferAttribute(shape, 1));
    child.geometry = geometry;
  });
}

export function buildBarrelMesh() {
  const g = new THREE.Group();
  const S = 0.7; // 直径スケール係数

  // --- 砲身チューブ本体(熱焼け黒鋼) ---
  const tubeGeo = new THREE.CylinderGeometry(0.58 * S, 0.64 * S, 4.4, 12);
  const tubeMat = new THREE.MeshStandardMaterial({ color: F0_BURNT_STEEL, roughness: 0.38, metalness: 1 });
  const tube = new THREE.Mesh(tubeGeo, tubeMat);
  tube.rotation.x = Math.PI / 2;
  g.add(tube);

  // --- 後端フランジ(薬室側・太めリング) ---
  const flangeMat = new THREE.MeshStandardMaterial({ color: F0_STEEL, roughness: 0.42, metalness: 1 });
  const flange = new THREE.Mesh(new THREE.CylinderGeometry(0.88 * S, 0.85 * S, 0.32, 12), flangeMat);
  flange.rotation.x = Math.PI / 2;
  flange.position.z = -2.3;
  g.add(flange);

  // 後端中補強リング
  const midRing = new THREE.Mesh(new THREE.CylinderGeometry(0.72 * S, 0.72 * S, 0.10, 12), flangeMat);
  midRing.rotation.x = Math.PI / 2;
  midRing.position.z = -0.8;
  g.add(midRing);

  // --- 放熱フィン(6枚、後部寄りに配置) ---
  const finMat = new THREE.MeshStandardMaterial({ color: F0_BURNT_STEEL, roughness: 0.52, metalness: 1 });
  const FIN_COUNT = 6;
  for (let i = 0; i < FIN_COUNT; i++) {
    const angle = (i / FIN_COUNT) * Math.PI * 2;
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.52 * S, 1.6), finMat);
    fin.rotation.z = angle;
    fin.position.set(Math.cos(angle) * 0.90 * S, Math.sin(angle) * 0.90 * S, -0.8);
    g.add(fin);
  }

  // --- ガスポートリング(中間部) ---
  const gasPortMat = new THREE.MeshStandardMaterial({ color: F0_STEEL, roughness: 0.50, metalness: 1 });
  const gasPort = new THREE.Mesh(new THREE.TorusGeometry(0.66 * S, 0.065, 6, 16), gasPortMat);
  gasPort.rotation.x = Math.PI / 2;
  gasPort.position.z = 0.4;
  g.add(gasPort);

  // --- マズルブレーキ(先端3連リング) ---
  const brakeMat = new THREE.MeshStandardMaterial({ color: F0_STEEL, roughness: 0.30, metalness: 1 });
  for (let ri = 0; ri < 3; ri++) {
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.76 * S, 0.70 * S, 0.11, 12), brakeMat);
    ring.rotation.x = Math.PI / 2;
    ring.position.z = 1.55 + ri * 0.24;
    g.add(ring);
  }

  // --- 砲口ボア(最前端・暗い穴) ---
  // 発射煙のすすで覆われた内壁なので金属ではない。ベース色は拡散アルベドとして読まれる。
  const boreMat = new THREE.MeshStandardMaterial({ color: 0x080b10, roughness: 0.80, metalness: 0 });
  const bore = new THREE.Mesh(new THREE.CylinderGeometry(0.34 * S, 0.34 * S, 0.14, 10), boreMat);
  bore.rotation.x = Math.PI / 2;
  bore.position.z = 2.28;
  g.add(bore);

  bakeBarrelThermalShape(g);
  return g;
}
