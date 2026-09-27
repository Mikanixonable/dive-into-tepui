// 機関砲の弾薬と消耗部品のモデル — 実弾入りのマガジンと薬莢。
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { importTsDataModule } from '../compile-source.mjs';
import { F0_ALUMINIUM, F0_BRASS, F0_BURNT_STEEL, F0_STEEL, std } from './materials.mjs';

const { MAG_THICKNESS, MAG_WIDTH, MAG_DEPTH, MAG_PLANAR_SCALE } = await importTsDataModule('src/physics/player-shape.ts');

// ------------------------------------------------------------- マガジン
// 給弾方向(+Z)の奥行き [m] と、並べる弾の段数・列数。
const MAG_ROWS = 1;
const MAG_COLS = 8;

const magPlateMat  = std(F0_STEEL, { metalness: 1, roughness: 0.42 });
const magRoundMat  = std(F0_BRASS, { metalness: 1, roughness: 0.36 }); // 真鍮色
const magTipMat    = std(0x828a91, { roughness: 0.56 }); // 光を拾いやすい銀色の弾頭
const magShellMat  = std(0x464e56, { roughness: 0.68 });
const magPanelMat  = std(0x30383f, { roughness: 0.72 });
const magWindowMat = std(0x11171c, { roughness: 0.88 });
const magTrimMat   = std(F0_STEEL, { metalness: 1, roughness: 0.48 });
const magFastenerMat = std(F0_ALUMINIUM, { metalness: 1, roughness: 0.38 });
const magPlateGeo  = beveledBoxGeometry(MAG_WIDTH, 0.055, MAG_DEPTH, 0.025);
const magPostGeo   = beveledBoxGeometry(0.07, MAG_THICKNESS, 0.07, 0.02);
const magFastenerGeo = new THREE.CylinderGeometry(0.038, 0.038, 0.032, 8);

// 1分割の浅い丸みで、直角を立てずに機械加工の C 面取りを表す。
function beveledBoxGeometry(width, height, depth, bevel = 0.04) {
  const minimumDimension = Math.min(width, height, depth);
  if (minimumDimension < 0.07) return new THREE.BoxGeometry(width, height, depth).toNonIndexed();
  const radius = Math.min(bevel, minimumDimension * 0.24);
  return new RoundedBoxGeometry(width, height, depth, radius, 1);
}

// 実弾の輪郭 (半径, 長手位置) — 放出される薬莢と同族のボトルネック形状。
// 太く短い薬室部(φ0.30・全長 0.7 ほど)に細い弾体(φ0.20)が +Y へ伸び、窓の中で縦に並ぶ。
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
  const sideGeo = beveledBoxGeometry(0.07, MAG_THICKNESS * 0.90, MAG_DEPTH, 0.025);
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

  // フィードリップ(+Z 先端・給弾口突起)は、弾薬窓を塞がない外周へ寄せる。
  const feedLipGeo = beveledBoxGeometry(0.52 * MAG_PLANAR_SCALE, 0.16, 0.14 * MAG_PLANAR_SCALE, 0.035);
  const feedLip = new THREE.Mesh(feedLipGeo, magPlateMat);
  feedLip.position.set(0, 0.80, MAG_DEPTH / 2 + 0.04);
  g.add(feedLip);

  // === 切込み・段差でシルエットに厚みを出す ===
  const recessMat = std(F0_BURNT_STEEL, { metalness: 1, roughness: 0.48 });
  const ridgeMat  = std(F0_STEEL, { metalness: 1, roughness: 0.42 });

  // 上下面: 前後方向に走る溝(くぼみを外側に出っ張る溝で近似)
  for (const sy of [-1, 1]) {
    // 中央溝レール(上面/下面を横切る)
    const groove = new THREE.Mesh(
      beveledBoxGeometry(MAG_WIDTH * 0.55, 0.06, MAG_DEPTH * 0.80, 0.025),
      recessMat,
    );
    groove.position.set(0, sy * (MAG_THICKNESS / 2 + 0.03), 0);
    g.add(groove);

    // 前後の段付きリブ(ショルダー)
    for (const sz of [-0.85 * MAG_PLANAR_SCALE, 0.85 * MAG_PLANAR_SCALE]) {
      const rib = new THREE.Mesh(
        beveledBoxGeometry(MAG_WIDTH * 0.80, 0.07, 0.12, 0.025),
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
        beveledBoxGeometry(0.10, MAG_THICKNESS * 0.70, 0.07, 0.025),
        recessMat,
      );
      ledge.position.set(sx * (MAG_WIDTH / 2 - 0.30), 0, sz * (MAG_DEPTH / 2 + 0.02));
      g.add(ledge);
    }
  }

  // サイド: ベルト案内レール(左右面中央に浮き出たリブ)
  const railGeo = beveledBoxGeometry(0.06, MAG_THICKNESS * 0.60, MAG_DEPTH * 0.75, 0.02);
  for (const sx of [-1, 1]) {
    const rail = new THREE.Mesh(railGeo, ridgeMat);
    rail.position.set(sx * (MAG_WIDTH / 2 + 0.02), 0, 0);
    g.add(rail);
  }

  // 弾(実弾: ボトルネックの薬室部 + 弾体)
  for (let iy = 0; iy < MAG_ROWS; iy++) {
    for (let ix = 0; ix < MAG_COLS; ix++) {
      const x = (ix - (MAG_COLS - 1) / 2) * (MAG_WIDTH / (MAG_COLS * 1.1));
      const z = 0.68 + (iy - (MAG_ROWS - 1) / 2) * 0.38;

      const round = new THREE.Mesh(magCaseGeo, magRoundMat);
      round.position.set(x, 0.07, z);
      round.userData = { role: 'round' };
      g.add(round);

      const tip = new THREE.Mesh(magProjGeo, magTipMat);
      tip.position.set(x, 0.07, z);
      tip.userData = { role: 'round' };
      g.add(tip);
    }
  }

  // 弾を箱の中に保持する外殻。前面の開口と背板の間に実包を見せる。
  const shellHeight = 2.04;
  const shellDepth = MAG_DEPTH * 0.88;
  const shellSideThickness = 0.14;
  const shellTopThickness = 0.14;
  const frontZ = MAG_DEPTH * 0.43;
  const windowWidth = MAG_WIDTH * 0.64;
  const windowHeight = 1.34;
  const addBox = (width, height, depth, x, y, z, material) => {
    const panel = new THREE.Mesh(beveledBoxGeometry(width, height, depth, 0.07), material);
    panel.position.set(x, y, z);
    g.add(panel);
  };

  addBox(MAG_WIDTH - 0.12, shellHeight - 0.16, 0.12, 0, 0, -shellDepth / 2, magPanelMat);
  for (const sx of [-1, 1]) {
    addBox(shellSideThickness, shellHeight - 0.16, shellDepth, sx * (MAG_WIDTH / 2 - shellSideThickness / 2), 0, 0,
      magShellMat);
  }
  for (const sy of [-1, 1]) {
    addBox(MAG_WIDTH, shellTopThickness, shellDepth, 0, sy * (shellHeight / 2 - shellTopThickness / 2), 0,
      magShellMat);
  }

  const windowSideWidth = (MAG_WIDTH - windowWidth) / 2;
  for (const sx of [-1, 1]) {
    addBox(windowSideWidth, shellHeight - 0.20, 0.16,
      sx * (windowWidth / 2 + windowSideWidth / 2), 0, frontZ, magShellMat);
  }
  const windowRailHeight = (shellHeight - 0.20 - windowHeight) / 2;
  for (const sy of [-1, 1]) {
    addBox(MAG_WIDTH - 0.08, windowRailHeight, 0.16,
      0, sy * (windowHeight / 2 + windowRailHeight / 2), frontZ, magShellMat);
  }

  // 窓の縁は黒いガスケットと、縁の光を拾う細い鋼の押さえで囲う。
  for (const sx of [-1, 1]) {
    addBox(0.045, windowHeight, 0.025, sx * (windowWidth / 2), 0, frontZ + 0.082, magWindowMat);
  }
  for (const sy of [-1, 1]) {
    addBox(windowWidth, 0.045, 0.025, 0, sy * (windowHeight / 2), frontZ + 0.082, magWindowMat);
  }
  addBox(windowWidth - 0.10, 0.035, 0.035, 0, 0.68, frontZ + 0.075, magTrimMat);
  addBox(windowWidth - 0.10, 0.035, 0.035, 0, -0.68, frontZ + 0.075, magTrimMat);

  // 窓の外側四隅は厚い面取りブロックと小さな締結具で受け、薄板の箱に見せない。
  const cornerGuardGeo = beveledBoxGeometry(0.24 * MAG_PLANAR_SCALE, 0.30, 0.16 * MAG_PLANAR_SCALE, 0.055);
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      const guard = new THREE.Mesh(cornerGuardGeo, magPlateMat);
      guard.position.set(sx * (MAG_WIDTH / 2 - 0.16), sy * (shellHeight / 2 - 0.17), frontZ + 0.10);
      g.add(guard);
      addFastener(sx * (MAG_WIDTH / 2 - 0.16), sy * (shellHeight / 2 - 0.17), frontZ + 0.19, 'front');
    }
  }

  // 上面の整備蓋は浅い段差と対称な締結具を持つ。
  const lidY = shellHeight / 2 + 0.025;
  addBox(1.72 * MAG_PLANAR_SCALE, 0.05, 1.12 * MAG_PLANAR_SCALE, 0, lidY, -0.02, magPanelMat);
  for (const sx of [-1, 1]) {
    addBox(0.045, 0.028, 1.16 * MAG_PLANAR_SCALE,
      sx * 0.89 * MAG_PLANAR_SCALE, shellHeight / 2 + 0.04, -0.02, magTrimMat);
  }
  for (const sz of [-1, 1]) {
    addBox(1.82 * MAG_PLANAR_SCALE, 0.028, 0.045,
      0, shellHeight / 2 + 0.04, sz * 0.60 * MAG_PLANAR_SCALE, magTrimMat);
  }

  // 頭が外を向くボルトで、蓋と窓枠を外装へ締結する。
  function addFastener(x, y, z, face) {
    const fastener = new THREE.Mesh(magFastenerGeo, magFastenerMat);
    if (face === 'front') fastener.rotation.x = Math.PI / 2;
    else if (face === 'side') fastener.rotation.z = Math.PI / 2;
    fastener.position.set(x, y, z);
    g.add(fastener);
  }
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) addFastener(sx * 0.76 * MAG_PLANAR_SCALE,
      lidY + 0.045, sz * 0.48 * MAG_PLANAR_SCALE, 'top');
    for (const sy of [-1, 1]) addFastener(sx * (MAG_WIDTH / 2 + 0.01), sy * 0.76,
      0.56 * MAG_PLANAR_SCALE, 'side');
    for (const sy of [-1, 1]) addFastener(sx * (windowWidth / 2 + windowSideWidth / 2), sy * 0.79,
      frontZ + 0.10, 'front');
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
