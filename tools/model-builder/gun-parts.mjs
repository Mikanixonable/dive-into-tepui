// 機関砲の弾薬と消耗部品のモデル — 実弾入りのマガジンと薬莢。
import * as THREE from 'three';
import { importTsDataModule } from '../compile-source.mjs';
import { F0_ALUMINIUM, F0_BRASS, F0_BURNT_STEEL, F0_STEEL, std } from './materials.mjs';

const { MAG_THICKNESS, MAG_WIDTH } = await importTsDataModule('src/physics/player-shape.ts');
const { MAG_ROUNDS } = await importTsDataModule('src/game/player/ammo-spec.ts');

// ------------------------------------------------------------- マガジン
// 給弾方向(+Z)の奥行き [m] と、並べる弾の列数。段数は装弾数 MAG_ROUNDS から決まる。
const MAG_DEPTH = MAG_THICKNESS * 3 * (2 / 3);
const MAG_COLS = 8;
const MAG_ROWS = MAG_ROUNDS / MAG_COLS;
// 弾の輪郭の半径倍率。装弾数ぶんを厚み方向の段で収める縮尺。
const MAG_ROUND_SCALE = 0.7;

const magPlateMat  = std(F0_STEEL, { metalness: 1, roughness: 0.42 });
const magRecessMat = std(F0_BURNT_STEEL, { metalness: 1, roughness: 0.48 });
const magRoundMat  = std(F0_BRASS, { metalness: 1, roughness: 0.32 }); // 真鍮色
const magTipMat    = std(F0_ALUMINIUM, { metalness: 1, roughness: 0.36 }); // シルバーチップ
const magPlateGeo  = new THREE.BoxGeometry(MAG_WIDTH, 0.055, MAG_DEPTH);
const magPostGeo   = new THREE.BoxGeometry(0.07, MAG_THICKNESS, 0.07);

// 実弾の輪郭 (半径, 長手位置) — 放出される薬莢と同族のボトルネック形状。
// 太く短い薬室部(φ0.30・全長 0.7 ほど)に細い弾体(φ0.20)が +Z へ伸びる。
const magCaseProfile = [
  new THREE.Vector2(0.000 * MAG_ROUND_SCALE, -0.72), // 底部中心
  new THREE.Vector2(0.150 * MAG_ROUND_SCALE, -0.72), // リム底面
  new THREE.Vector2(0.150 * MAG_ROUND_SCALE, -0.66), // リム側面
  new THREE.Vector2(0.128 * MAG_ROUND_SCALE, -0.62), // エクストラクターグルーブ
  new THREE.Vector2(0.128 * MAG_ROUND_SCALE, -0.58),
  new THREE.Vector2(0.148 * MAG_ROUND_SCALE, -0.55), // ボディ径に戻る
  new THREE.Vector2(0.148 * MAG_ROUND_SCALE, -0.06), // ボディ
  new THREE.Vector2(0.100 * MAG_ROUND_SCALE,  0.04), // ショルダー・ネック口
];
const magProjProfile = [
  new THREE.Vector2(0.000 * MAG_ROUND_SCALE, -0.02), // 弾体尾部(薬室内)
  new THREE.Vector2(0.098 * MAG_ROUND_SCALE, -0.02),
  new THREE.Vector2(0.098 * MAG_ROUND_SCALE,  0.55), // 弾体の円筒部
  new THREE.Vector2(0.070 * MAG_ROUND_SCALE,  0.78), // オジーブ
  new THREE.Vector2(0.035 * MAG_ROUND_SCALE,  0.90),
  new THREE.Vector2(0.000 * MAG_ROUND_SCALE,  0.97), // 弾先
];
const magCaseGeo = new THREE.LatheGeometry(magCaseProfile, 10);
const magProjGeo = new THREE.LatheGeometry(magProjProfile, 10);

// 軸が Z の円筒を (x, y, z) に置く。継手の眼・ピン・スプリングに使う。
function axisZCylinder(radius, length, x, y, z, openEnded = false) {
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius, length, 14, 1, openEnded),
    magPlateMat,
  );
  mesh.rotation.x = Math.PI / 2;
  mesh.position.set(x, y, z);
  return mesh;
}

// 実弾入りのマガジン。給弾口は +Z。弾と弾頭のメッシュは userData.role = 'round' を持つ。
export function buildMagazineMesh() {
  const g = new THREE.Group();
  const edgeX = MAG_WIDTH / 2;
  const faceZ = MAG_DEPTH / 2;

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

  // === リンク間の継手(ナックル継手) ===
  // +X 端の眼2個と -X 端の眼1個が、隣リンクの眼と互い違いに並び、Z 軸のピンで
  // 連結される履帯式の継手。眼はベルトの隙間へ張り出し、隣リンクの眼と異なるレーンで
  // 食い違う。
  for (const z of [-0.55, 0.55]) {
    g.add(axisZCylinder(0.125, 0.44, edgeX + 0.07, 0, z, true));
    const web = new THREE.Mesh(new THREE.BoxGeometry(0.20, 0.08, 0.40), magPlateMat);
    web.position.set(edgeX - 0.02, -0.10, z);
    g.add(web);
  }
  g.add(axisZCylinder(0.125, 0.56, -edgeX - 0.07, 0, 0, true));
  const web = new THREE.Mesh(new THREE.BoxGeometry(0.20, 0.08, 0.52), magPlateMat);
  web.position.set(-edgeX + 0.02, -0.10, 0);
  g.add(web);
  // ヒンジピンと両端の頭
  const pin = axisZCylinder(0.05, 1.62, edgeX + 0.07, 0, 0);
  pin.material = magRecessMat;
  g.add(pin);
  for (const sz of [-1, 1]) {
    const cap = axisZCylinder(0.085, 0.05, edgeX + 0.07, 0, sz * 0.79);
    cap.material = magRecessMat;
    g.add(cap);
  }
  // 給弾爪が掛かる押し出し受け(+X 面の下寄り)
  const lug = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.22, 0.15), magPlateMat);
  lug.position.set(edgeX + 0.025, -0.30, 0.36);
  g.add(lug);

  // === 給弾口(+Z): 上下のフィードリップと端タブ、送り喉 ===
  for (const sy of [-1, 1]) {
    const lip = new THREE.Mesh(new THREE.BoxGeometry(MAG_WIDTH * 0.92, 0.055, 0.20), magPlateMat);
    lip.rotation.x = -sy * 0.30;
    lip.position.set(0, sy * (MAG_THICKNESS / 2 - 0.10), faceZ + 0.02);
    g.add(lip);
  }
  for (const sx of [-1, 1]) {
    const tab = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.34, 0.16), magPlateMat);
    tab.position.set(sx * (MAG_WIDTH / 2 - 0.075), 0, faceZ + 0.01);
    g.add(tab);
  }
  const throat = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.10, 0.20), magPlateMat);
  throat.position.set(0, 0.36, faceZ + 0.01);
  g.add(throat);

  // === 底部(-Z): バックバーと、弾列を給弾口へ押すフォロワ・スプリング ===
  const backBar = new THREE.Mesh(new THREE.BoxGeometry(MAG_WIDTH * 0.88, 0.10, 0.06), magPlateMat);
  backBar.position.set(0, 0, -faceZ + 0.03);
  g.add(backBar);
  const follower = new THREE.Mesh(
    new THREE.BoxGeometry(MAG_WIDTH * 0.88, MAG_THICKNESS * 0.80, 0.055),
    magPlateMat,
  );
  follower.position.set(0, 0, -faceZ + 0.16);
  g.add(follower);
  for (const x of [-0.6, 0, 0.6]) {
    g.add(axisZCylinder(0.045, 0.10, x, 0, -faceZ + 0.09));
  }

  // === 切込み・段差でシルエットに厚みを出す ===
  // 上下面: 前後方向に走る溝(くぼみを外側に出っ張る溝で近似)
  for (const sy of [-1, 1]) {
    const groove = new THREE.Mesh(
      new THREE.BoxGeometry(MAG_WIDTH * 0.55, 0.06, MAG_DEPTH * 0.80),
      magRecessMat,
    );
    groove.position.set(0, sy * (MAG_THICKNESS / 2 + 0.03), 0);
    g.add(groove);

    // 前後の段付きリブ(ショルダー)
    for (const sz of [-0.85, 0.85]) {
      const rib = new THREE.Mesh(
        new THREE.BoxGeometry(MAG_WIDTH * 0.80, 0.07, 0.12),
        magPlateMat,
      );
      rib.position.set(0, sy * (MAG_THICKNESS / 2 + 0.035), sz);
      g.add(rib);
    }

    // プレート長辺のリベット列
    for (const sx of [-1, 1]) {
      for (let i = 0; i < 5; i++) {
        const rivet = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.03, 8), magPlateMat);
        rivet.position.set(sx * (MAG_WIDTH / 2 - 0.14), sy * (MAG_THICKNESS / 2 + 0.008), -0.8 + i * 0.4);
        g.add(rivet);
      }
    }
  }

  // 前後面: 縦方向の段差ライン
  for (const sz of [-1, 1]) {
    for (const sx of [-1, 1]) {
      const ledge = new THREE.Mesh(
        new THREE.BoxGeometry(0.10, MAG_THICKNESS * 0.70, 0.07),
        magRecessMat,
      );
      ledge.position.set(sx * (MAG_WIDTH / 2 - 0.30), 0, sz * (MAG_DEPTH / 2 + 0.02));
      g.add(ledge);
    }
  }

  // 弾(実弾: ボトルネックの薬室部 + 弾体)。給弾口側が弾先。
  for (let iy = 0; iy < MAG_ROWS; iy++) {
    for (let ix = 0; ix < MAG_COLS; ix++) {
      const x = (ix - (MAG_COLS - 1) / 2) * (MAG_WIDTH / (MAG_COLS * 1.1));
      const y = (iy - (MAG_ROWS - 1) / 2) * (MAG_THICKNESS * 0.216);

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
