// 機関砲の弾薬と消耗部品のモデル — 実弾入りのマガジン、薬莢、放出される砲身。
import * as THREE from 'three';
import { importTsDataModule, loadSourceModules } from '../compile-source.mjs';
import { F0_ALUMINIUM, F0_BRASS, F0_BURNT_STEEL, F0_STEEL, std } from './materials.mjs';

const { MAG_THICKNESS, MAG_WIDTH } = await importTsDataModule('src/physics/player-shape.ts');
const thermalSource = loadSourceModules(['render/thermal-emissive']);
const { THERMAL_SHAPE_ATTRIBUTE } = thermalSource.thermalEmissive;
thermalSource.dispose();

// ------------------------------------------------------------- マガジン
// 給弾方向(+Z)の奥行き [m] と、並べる弾の段数・列数。
const MAG_DEPTH = MAG_THICKNESS * 3 * (2 / 3);
const MAG_ROWS = 3;
const MAG_COLS = 8;

const magPlateMat  = std(F0_STEEL, { metalness: 1, roughness: 0.42 });
const magRoundMat  = std(F0_BRASS, { metalness: 1, roughness: 0.32 }); // 真鍮色
const magTipMat    = std(F0_ALUMINIUM, { metalness: 1, roughness: 0.36 }); // シルバーチップ
const magPlateGeo  = new THREE.BoxGeometry(MAG_WIDTH, 0.055, MAG_DEPTH);
const magPostGeo   = new THREE.BoxGeometry(0.07, MAG_THICKNESS, 0.07);

// 実弾の輪郭 (半径, 長手位置) — 放出される薬莢と同族のボトルネック形状。
// 太く短い薬室部(φ0.30・全長 0.7 ほど)に細い弾体(φ0.20)が +Z へ伸びる。
const magCaseProfile = [
  new THREE.Vector2(0.000, -0.72), // 底部中心
  new THREE.Vector2(0.150, -0.72), // リム底面
  new THREE.Vector2(0.150, -0.66), // リム側面
  new THREE.Vector2(0.128, -0.62), // エクストラクターグルーブ
  new THREE.Vector2(0.128, -0.58),
  new THREE.Vector2(0.148, -0.55), // ボディ径に戻る
  new THREE.Vector2(0.148, -0.06), // ボディ
  new THREE.Vector2(0.100,  0.04), // ショルダー・ネック口
];
const magProjProfile = [
  new THREE.Vector2(0.000, -0.02), // 弾体尾部(薬室内)
  new THREE.Vector2(0.098, -0.02),
  new THREE.Vector2(0.098,  0.55), // 弾体の円筒部
  new THREE.Vector2(0.070,  0.78), // オジーブ
  new THREE.Vector2(0.035,  0.90),
  new THREE.Vector2(0.000,  0.97), // 弾先
];
const magCaseGeo = new THREE.LatheGeometry(magCaseProfile, 10);
const magProjGeo = new THREE.LatheGeometry(magProjProfile, 10);

// 実弾入りのマガジン。給弾口は +Z。弾と弾頭のメッシュは userData.role = 'round' を持つ。
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

  // 弾(実弾: ボトルネックの薬室部 + 弾体)
  for (let iy = 0; iy < MAG_ROWS; iy++) {
    for (let ix = 0; ix < MAG_COLS; ix++) {
      const x = (ix - (MAG_COLS - 1) / 2) * (MAG_WIDTH / (MAG_COLS * 1.1));
      const y = (iy - (MAG_ROWS - 1) / 2) * (MAG_THICKNESS * 0.29);

      const round = new THREE.Mesh(magCaseGeo, magRoundMat);
      round.rotation.x = Math.PI / 2;
      round.position.set(x, y, 0);
      round.userData = { role: 'round' };
      g.add(round);

      const tip = new THREE.Mesh(magProjGeo, magTipMat);
      tip.rotation.x = Math.PI / 2;
      tip.position.set(x, y, 0);
      tip.userData = { role: 'round' };
      g.add(tip);
    }
  }

  return g;
}

// ------------------------------------------------------------- 薬莢
// CIWS 艦砲弾薬をモチーフにしたボトルネック形状。輪郭は (半径, 長手方向の位置) の組で、
// 径と長さに別々の縮尺を掛ける。
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

// 薬莢。輪郭をローカル Y 軸まわりに回した回転体で、口が +Y。
export function buildCasingMesh() {
  const geo = new THREE.LatheGeometry(casingProfile, 8);
  const mat = new THREE.MeshStandardMaterial({
    color: F0_BRASS,
    metalness: 1,
    roughness: 0.28,
  });
  return new THREE.Mesh(geo, mat);
}

// ------------------------------------------------------------- 砲身

// 薬室の位置 [m] と、そこから砲口へ向かって温度差が落ちる長さ [m]。発射ガスは銃身に沿って
// 熱を置いていくので、薬室側がいちばん熱く、砲口へ向かって指数で下がる。
const BARREL_BREECH_Z = -1.16;
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

// リロード時に放出される砲身束。モジュールに架かっている回転砲身そのままの形(後部ハブ・心棒・
// 5本の砲身・締め板)で、長手方向は Z、砲口が +Z、薬室側が -Z。
// 各頂点に、薬室からの距離で決まる温度差の分布を焼いた属性を持つ。
export function buildBarrelMesh() {
  const g = new THREE.Group();

  // モジュール側の寸法(blender/build-ship-modules.py の回転部)を、その中心が原点へ来るよう写したもの。
  const BARREL_COUNT = 5;
  const CLUSTER_R = 0.60;
  const BREECH_Z = -1.16;  // 砲身の尾端
  const MUZZLE_Z = 1.16;   // 砲口
  const BARREL_LEN = MUZZLE_Z - BREECH_Z;

  const steelMat = new THREE.MeshStandardMaterial({ color: F0_STEEL, roughness: 0.42, metalness: 1 });
  const darkSteelMat = new THREE.MeshStandardMaterial({ color: F0_BURNT_STEEL, roughness: 0.45, metalness: 1 });
  const boreMat = new THREE.MeshStandardMaterial({ color: 0x080b10, roughness: 0.80, metalness: 0 });

  // --- 後部ハブ(駆動軸の受けを兼ねる厚円盤) ---
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.74, 0.74, 0.16, 24), steelMat);
  hub.rotation.x = Math.PI / 2;
  hub.position.z = BREECH_Z - 0.04;
  g.add(hub);

  // --- 中心の心棒 ---
  const spindle = new THREE.Mesh(
    new THREE.CylinderGeometry(0.055, 0.055, MUZZLE_Z - 0.10 - BREECH_Z, 10), darkSteelMat);
  spindle.rotation.x = Math.PI / 2;
  spindle.position.z = (BREECH_Z + MUZZLE_Z - 0.10) / 2;
  g.add(spindle);

  // --- 5本の砲身(尾栓側が太く、砲口へ先細り)と砲口の穴 ---
  const barrelGeo = new THREE.CylinderGeometry(0.150, 0.185, BARREL_LEN, 14);
  const boreGeo = new THREE.CylinderGeometry(0.125, 0.125, 0.06, 10);
  for (let b = 0; b < BARREL_COUNT; b++) {
    const a = (b * 2 * Math.PI) / BARREL_COUNT;
    const bx = CLUSTER_R * Math.cos(a);
    const by = CLUSTER_R * Math.sin(a);
    const barrel = new THREE.Mesh(barrelGeo, steelMat);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(bx, by, (BREECH_Z + MUZZLE_Z) / 2);
    g.add(barrel);
    const bore = new THREE.Mesh(boreGeo, boreMat);
    bore.rotation.x = Math.PI / 2;
    bore.position.set(bx, by, MUZZLE_Z - 0.03);
    g.add(bore);
  }

  // --- 長砲身を束ねる締め板(間隔を開けて3枚) ---
  for (const [zc, thickness] of [
    [BREECH_Z + BARREL_LEN * 0.35, 0.05],
    [BREECH_Z + BARREL_LEN * 0.70, 0.05],
    [MUZZLE_Z - 0.10, 0.06],
  ]) {
    const clamp = new THREE.Mesh(new THREE.CylinderGeometry(0.80, 0.80, thickness, 24), darkSteelMat);
    clamp.rotation.x = Math.PI / 2;
    clamp.position.z = zc;
    g.add(clamp);
  }

  bakeBarrelThermalShape(g);
  return g;
}
