// ShipModuleCatalog の寸法から、メートル単位・長手軸 +Z の module model を組み立てる。
// 実在の宇宙船（ISS、ソユーズ、ジェミニ、マーキュリー、HTV、実在のロケットエンジン、SRB）の
// ディテール（リブ、配管、断熱材、ハンドレール、窓枠、ベル曲線ノズル、分離モーター等）を取り入れ、
// 説得力と一貫性のある形状を生成する。
// module と semantic anchor は Group/Object3D に置き、exporter の mesh 統合で境界が消えないようにする。
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSourceModules } from '../compile-source.mjs';
import { F0_ALUMINIUM, F0_BURNT_STEEL, F0_STEEL, std } from './materials.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const glbDir = join(__dirname, '..', '..', 'assets-src', 'ship-modules');

function loadGlbScene(filename) {
  const glbPath = join(glbDir, filename);
  if (!existsSync(glbPath)) return Promise.resolve(null);
  const buf = readFileSync(glbPath);
  const arrayBuf = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const loader = new GLTFLoader();
  return new Promise((resolve) => {
    loader.parse(
      arrayBuf,
      '',
      (gltf) => resolve(gltf.scene),
      (err) => {
        console.error(`Failed to parse ${glbPath}:`, err);
        resolve(null);
      },
    );
  });
}

const ROTATE_BLENDER_TO_THREE = new THREE.Matrix4().makeRotationX(Math.PI / 2);

async function applyGlbModel(root, filename) {
  const scene = await loadGlbScene(filename);
  if (!scene) return false;
  scene.traverse((child) => {
    if (child.isMesh && child.geometry) {
      child.geometry.applyMatrix4(ROTATE_BLENDER_TO_THREE);
      child.geometry.computeVertexNormals();
    }
  });
  while (scene.children.length > 0) {
    const child = scene.children[0];
    root.add(child);
  }
  return true;
}

const source = loadSourceModules(['game/ship/ship-module-catalog', 'physics/player-shape']);
const { SHIP_MODULE_CATALOG } = source.shipModuleCatalog;
const {
  RADIATOR_FOLD_COUNT,
  RADIATOR_PANEL_WIDTH,
  RADIATOR_SEGMENT_LENGTH,
  SOLAR_PANEL_COUNT,
  SOLAR_PANEL_SPAN,
  SOLAR_PANEL_WIDTH,
} = source.playerShape;
source.dispose();

const materials = {
  hull: std(0xb8c5d2, { metalness: 0.72, roughness: 0.48 }),
  hullDark: std(0x4a525e, { metalness: 0.85, roughness: 0.42 }),
  rim: std(F0_STEEL, { metalness: 1, roughness: 0.28 }),
  dark: std(F0_BURNT_STEEL, { metalness: 1, roughness: 0.5 }),
  window: std(0x0a1c2d, { metalness: 0.05, roughness: 0.15 }),
  windowFrame: std(0x353b44, { metalness: 0.8, roughness: 0.35 }),
  tankMain: std(0xc7d3de, { metalness: 0.68, roughness: 0.42 }),
  tankRcs: std(0x4a8296, { metalness: 0.58, roughness: 0.46 }),
  armor: std(0x626c7a, { metalness: 0.9, roughness: 0.38 }),
  radiator: std(0xe4e9ee, { metalness: 0.28, roughness: 0.86 }),
  solar: std(0x163f91, { metalness: 0.18, roughness: 0.44 }),
  dock: std(0xd58b37, { metalness: 0.82, roughness: 0.4 }),
  mliGold: std(0xd4a843, { metalness: 0.85, roughness: 0.30 }),
  mliWhite: std(0xecf0f5, { metalness: 0.0, roughness: 0.75 }),
  heatshield: std(0x2d241d, { metalness: 0.0, roughness: 0.88 }),
  pipe: std(F0_ALUMINIUM, { metalness: 1, roughness: 0.35 }),
  pipeDark: std(0x5a6370, { metalness: 0.9, roughness: 0.42 }),
  handrail: std(0xe5a924, { metalness: 0.1, roughness: 0.35 }),
  nozzleBell: std(F0_BURNT_STEEL, { metalness: 1, roughness: 0.45 }),
  nozzleStiffener: std(F0_STEEL, { metalness: 1, roughness: 0.32 }),
  nozzleThroat: std(0x3e3630, { metalness: 0.85, roughness: 0.55 }),
};

function axialMesh(geometry, material, z = 0, name = '') {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.rotation.x = Math.PI / 2;
  mesh.position.z = z;
  mesh.name = name;
  return mesh;
}

// TorusGeometry の法線は +Z なので、円柱と同じ軸回転を加えずに配置する。
function ringMesh(geometry, material, z = 0, name = '') {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.z = z;
  mesh.name = name;
  return mesh;
}

function boxMesh(geometry, material, x = 0, y = 0, z = 0, rotX = 0, rotY = 0, rotZ = 0, name = '') {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(x, y, z);
  if (rotX || rotY || rotZ) mesh.rotation.set(rotX, rotY, rotZ);
  mesh.name = name;
  return mesh;
}

function anchor(parent, name, x, y, z, direction = null) {
  const node = new THREE.Object3D();
  node.name = `anchor:${name}`;
  node.userData = { semanticAnchor: name };
  node.position.set(x, y, z);
  if (direction !== null) {
    node.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), direction.clone().normalize());
  }
  parent.add(node);
  return node;
}

function connectionAnchors(root, definition) {
  anchor(root, 'connection:aft', 0, 0, -definition.length / 2, new THREE.Vector3(0, 0, -1));
  anchor(root, 'connection:forward', 0, 0, definition.length / 2, new THREE.Vector3(0, 0, 1));
  if (definition.kind !== 'cockpit' && definition.kind !== 'tank') return;
  for (const [name, direction] of [
    ['side:+x', new THREE.Vector3(1, 0, 0)],
    ['side:-x', new THREE.Vector3(-1, 0, 0)],
    ['side:+y', new THREE.Vector3(0, 1, 0)],
    ['side:-y', new THREE.Vector3(0, -1, 0)],
  ]) anchor(root, `connection:${name}`, direction.x * 3, direction.y * 3, 0, direction);
}

// ISS風 EVA ハンドレール（手すりバー + 2つの端部支柱）
function addHandrail(group, x, y, z, length = 0.5, rotZ = 0, rotX = 0) {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  if (rotX || rotZ) g.rotation.set(rotX, 0, rotZ);
  // バー
  const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, length, 8), materials.handrail);
  g.add(bar);
  // 両端ポスト
  const postGeo = new THREE.BoxGeometry(0.035, 0.035, 0.06);
  for (const sy of [-1, 1]) {
    const post = new THREE.Mesh(postGeo, materials.rim);
    post.position.set(0, sy * (length / 2 - 0.02), -0.03);
    g.add(post);
  }
  group.add(g);
}

// ------------------------------------------------------------- コックピット
// ソユーズ降下モジュール風テーパー + ジェミニ風台形窓 + ISS風外壁リブ・MLI断熱材
function buildCockpit(root, definition) {
  const radius = definition.diameter / 2; // 3.0m
  const halfLen = definition.length / 2;  // 1.5m

  // 1. 後端接続リング & アブレーションヒートシールド基部 (z = -1.5m 〜 -1.2m)
  root.add(ringMesh(new THREE.TorusGeometry(radius * 0.94, 0.08, 8, 32), materials.rim, -halfLen + 0.08, 'end-ring'));
  root.add(axialMesh(new THREE.CylinderGeometry(radius * 0.99, radius * 0.96, 0.28, 32), materials.heatshield, -halfLen + 0.14, 'heatshield-base'));
  root.add(axialMesh(new THREE.CylinderGeometry(radius, radius, 0.12, 32), materials.hullDark, -halfLen + 0.28, 'aft-flange'));

  // 2. 与圧キャビン主胴体 (z = -1.2m 〜 +0.2m): 円筒 + MLI/ウィップルシールドパネル
  const cabinLen = 1.4;
  root.add(axialMesh(new THREE.CylinderGeometry(radius * 0.985, radius * 0.985, cabinLen, 32), materials.hull, -0.5, 'cabin-body'));

  // MLI断熱材パネル & ウィップルシールド帯 (交互に配置して実在の宇宙ステーションモジュールの質感)
  const panelCount = 12;
  const panelArc = (Math.PI * 2) / panelCount;
  for (let i = 0; i < panelCount; i++) {
    const angle = i * panelArc;
    const mat = (i % 3 === 0) ? materials.mliGold : (i % 3 === 1) ? materials.mliWhite : materials.hull;
    const panelGeo = new THREE.BoxGeometry(0.72, 1.25, 0.04);
    const px = Math.cos(angle) * (radius * 0.988);
    const py = Math.sin(angle) * (radius * 0.988);
    root.add(boxMesh(panelGeo, mat, px, py, -0.5, 0, 0, angle + Math.PI / 2, 'hull-panel'));
  }

  // 3. 前方テーパーショルダー (z = +0.2m 〜 +1.2m): ソユーズ/ジェミニ風の絞り形状
  const taperLen = 1.0;
  const taperGeo = new THREE.CylinderGeometry(radius * 0.76, radius * 0.985, taperLen, 32);
  root.add(axialMesh(taperGeo, materials.hull, 0.7, 'taper-shoulder'));

  // ショルダー部の構造リブ (縦ストリンガー)
  for (let i = 0; i < 8; i++) {
    const angle = (i * Math.PI) / 4;
    const ribGeo = new THREE.BoxGeometry(0.04, taperLen * 0.95, 0.05);
    const midR = radius * 0.88;
    const rx = Math.cos(angle) * midR;
    const ry = Math.sin(angle) * midR;
    root.add(boxMesh(ribGeo, materials.hullDark, rx, ry, 0.7, Math.PI / 2, 0, angle + Math.PI / 2, 'shoulder-rib'));
  }

  // 4. 前端ドッキングカラー & ハッチ (z = +1.2m 〜 +1.5m)
  const collarR = radius * 0.72;
  root.add(axialMesh(new THREE.CylinderGeometry(collarR, collarR, 0.3, 32), materials.hullDark, 1.35, 'docking-collar'));
  root.add(ringMesh(new THREE.TorusGeometry(collarR * 0.94, 0.07, 8, 32), materials.rim, halfLen - 0.08, 'end-ring'));
  // ハッチ面
  root.add(axialMesh(new THREE.CylinderGeometry(collarR * 0.75, collarR * 0.75, 0.04, 24), materials.rim, halfLen - 0.02, 'hatch-cover'));

  // 5. ジェミニ風 前方クルー窓（2連の傾斜・台形風ビューポート）
  for (const sx of [-1, 1]) {
    // 窓枠ベゼル
    const frameGeo = new THREE.BoxGeometry(0.68, 0.52, 0.12);
    const wx = sx * 0.65;
    const wy = 1.75;
    const wz = 0.85;
    // ショルダー傾斜に合わせて回転
    root.add(boxMesh(frameGeo, materials.windowFrame, wx, wy, wz, -0.26, sx * 0.12, 0, 'window-frame'));
    // ガラス面
    const glassGeo = new THREE.BoxGeometry(0.56, 0.40, 0.06);
    root.add(boxMesh(glassGeo, materials.window, wx, wy + 0.02, wz + 0.04, -0.26, sx * 0.12, 0, 'cockpit-window'));
  }

  // 天頂ランデブー用ビューポート (アポロ/ソユーズ風の上部観察窓)
  root.add(boxMesh(new THREE.CylinderGeometry(0.24, 0.24, 0.08, 16), materials.windowFrame, 0, 2.45, 0.45, Math.PI / 2 + 0.22, 0, 0, 'overhead-window-frame'));
  root.add(boxMesh(new THREE.CylinderGeometry(0.19, 0.19, 0.05, 16), materials.window, 0, 2.47, 0.46, Math.PI / 2 + 0.22, 0, 0, 'overhead-window'));

  // 側面光学照準・観察窓 (ソユーズのペリスコープポート風)
  for (const sx of [-1, 1]) {
    root.add(boxMesh(new THREE.CylinderGeometry(0.18, 0.18, 0.08, 16), materials.rim, sx * 2.92, 0, -0.2, 0, 0, Math.PI / 2, 'side-port-frame'));
    root.add(boxMesh(new THREE.CylinderGeometry(0.13, 0.13, 0.06, 16), materials.window, sx * 2.95, 0, -0.2, 0, 0, Math.PI / 2, 'side-port'));
  }

  // 6. 姿勢制御スラスターブリスター (前方ショルダー部の4箇所に埋め込み)
  for (const [bx, by] of [[-1, 1], [1, 1], [-1, -1], [1, -1]]) {
    const blisterGeo = new THREE.BoxGeometry(0.28, 0.28, 0.24);
    const bDist = radius * 0.82;
    const ang = Math.atan2(by, bx);
    root.add(boxMesh(blisterGeo, materials.dark, Math.cos(ang) * bDist, Math.sin(ang) * bDist, 0.72, 0, 0, ang, 'rcs-blister'));
    // マイクロノズル
    const miniNozzle = axialMesh(new THREE.ConeGeometry(0.04, 0.08, 8, 1, true), materials.nozzleBell, 0.86, 'mini-nozzle');
    miniNozzle.position.set(Math.cos(ang) * (bDist + 0.08), Math.sin(ang) * (bDist + 0.08), 0.72);
    miniNozzle.rotation.z = ang - Math.PI / 2;
    root.add(miniNozzle);
  }

  // 7. ISS風 EVA 安全ハンドレール
  // 前方ハッチ周囲
  addHandrail(root, -0.75, 1.2, 1.25, 0.45, Math.PI / 4, -0.25);
  addHandrail(root, 0.75, 1.2, 1.25, 0.45, -Math.PI / 4, -0.25);
  addHandrail(root, 0, 1.6, 1.35, 0.5, Math.PI / 2, -0.25);
  // 背部ユーティリティライン沿い
  addHandrail(root, 0.18, 2.94, -0.8, 0.5, 0, 0);
  addHandrail(root, 0.18, 2.94, -0.2, 0.5, 0, 0);

  // 8. ユーティリティ配管・ケーブルレースウェイ（背部・腹部）
  const racewayGeo = new THREE.BoxGeometry(0.16, 0.07, cabinLen * 0.96);
  root.add(boxMesh(racewayGeo, materials.hullDark, 0, radius * 0.99, -0.5, 0, 0, 0, 'dorsal-raceway'));
  root.add(boxMesh(racewayGeo, materials.hullDark, 0, -radius * 0.99, -0.5, 0, 0, 0, 'ventral-raceway'));

  // 9. スタートラッカー / 光学センサーハウジング
  for (const sx of [-1, 1]) {
    const tracker = axialMesh(new THREE.CylinderGeometry(0.08, 0.12, 0.22, 12), materials.dark, 0.85, 'star-tracker');
    tracker.position.set(sx * 1.2, 2.0, 0.7);
    tracker.rotation.x = Math.PI / 2 - 0.4;
    tracker.rotation.y = sx * 0.25;
    root.add(tracker);
  }

  // 10. 側面の結合サポートパッド
  for (const [name, dir] of [
    ['side:+x', new THREE.Vector3(1, 0, 0)],
    ['side:-x', new THREE.Vector3(-1, 0, 0)],
    ['side:+y', new THREE.Vector3(0, 1, 0)],
    ['side:-y', new THREE.Vector3(0, -1, 0)],
  ]) {
    const pad = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 0.08, 16), materials.rim);
    pad.name = `support-pad:${name}`;
    pad.position.set(dir.x * (radius - 0.02), dir.y * (radius - 0.02), 0);
    if (dir.x !== 0) pad.rotation.z = Math.PI / 2;
    root.add(pad);
  }
}

// ------------------------------------------------------------- 燃料タンク
// ISS/HTV風の区画構造 + 配管・ケーブルトレイ + 帯フレーム (tank-band保持)
// 主燃料タンクは平端面・大径配管、RCSタンクは球形ドーム端面・マニホールド配管
function buildTank(root, definition) {
  const radius = definition.diameter / 2; // 3.0m
  const isRcs = definition.abilities.fuelKind === 'rcs';
  const isCombat = definition.id === 'tank-combat-main';
  const primaryMat = isCombat ? materials.armor : isRcs ? materials.tankRcs : materials.tankMain;
  const halfLen = definition.length / 2;

  // 1. 主圧力殻円筒
  const bodyLen = definition.length - 0.16;
  root.add(axialMesh(
    new THREE.CylinderGeometry(radius * 0.985, radius * 0.985, bodyLen, 32, Math.max(1, Math.ceil(definition.length / 3))),
    primaryMat, 0, 'body',
  ));

  // 2. 両端リング (契約維持)
  for (const z of [-halfLen + 0.08, halfLen - 0.08]) {
    root.add(ringMesh(new THREE.TorusGeometry(radius * 0.94, 0.08, 8, 32), materials.rim, z, 'end-ring'));
  }

  // 3. タンクバンド (契約テスト 'ship module asset: tank band は船体軸と同じ +Z 法線を持つ' に完全準拠)
  for (let z = -halfLen + 1.5; z < halfLen; z += 3) {
    root.add(ringMesh(new THREE.TorusGeometry(radius * 1.01, 0.07, 8, 32), materials.rim, z, 'tank-band'));

    // バンド補強ガセット (外周の補強金具)
    for (let i = 0; i < 6; i++) {
      const ang = (i * Math.PI) / 3;
      const gusset = boxMesh(new THREE.BoxGeometry(0.08, 0.14, 0.22), materials.dark,
        Math.cos(ang) * (radius * 0.99), Math.sin(ang) * (radius * 0.99), z, 0, 0, ang);
      root.add(gusset);
    }
  }

  // 4. 端面形状（主燃料とRCSの視覚的区別を強化）
  if (isRcs) {
    // RCSタンク: 突出した球形ドーム端面（高圧ガスタンクの暗示）
    for (const sz of [-1, 1]) {
      const domeZ = sz * (halfLen - 0.18);
      const domeGeo = new THREE.SphereGeometry(radius * 0.72, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2);
      const dome = new THREE.Mesh(domeGeo, materials.tankRcs);
      dome.position.z = domeZ;
      if (sz < 0) dome.rotation.x = Math.PI;
      root.add(dome);

      // マニホールドブロック & バルブ
      const valveBox = boxMesh(new THREE.BoxGeometry(0.35, 0.25, 0.16), materials.dark, 0, 0, sz * (halfLen - 0.04), 0, 0, 0, 'rcs-manifold');
      root.add(valveBox);
    }
  } else {
    // 主燃料タンク: 平端面 + 中央フィードインターフェース
    for (const sz of [-1, 1]) {
      const bulkhead = axialMesh(new THREE.CylinderGeometry(radius * 0.88, radius * 0.88, 0.06, 24), materials.hullDark, sz * (halfLen - 0.06), 'tank-bulkhead');
      root.add(bulkhead);
      const collar = axialMesh(new THREE.CylinderGeometry(0.45, 0.45, 0.12, 16), materials.rim, sz * (halfLen - 0.02), 'feed-collar');
      root.add(collar);
    }
  }

  // 5. 外壁ウィップルシールドパネル帯（ISSモジュール風の構造分割）
  const segmentCount = Math.max(1, Math.round(definition.length / 3));
  const segmentLen = definition.length / segmentCount;
  for (let s = 0; s < segmentCount; s++) {
    const centerZ = -halfLen + segmentLen * (s + 0.5);
    // パネルライン溝リング
    if (s > 0) {
      root.add(ringMesh(new THREE.TorusGeometry(radius * 0.985, 0.03, 6, 24), materials.dark, -halfLen + segmentLen * s, 'panel-groove'));
    }
    // 外壁の断熱パネルパッチ
    for (const ang of [Math.PI / 6, 5 * Math.PI / 6, 7 * Math.PI / 6, 11 * Math.PI / 6]) {
      const px = Math.cos(ang) * (radius * 0.99);
      const py = Math.sin(ang) * (radius * 0.99);
      const patchMat = (s % 2 === 0) ? materials.mliWhite : materials.hull;
      root.add(boxMesh(new THREE.BoxGeometry(0.85, 0.03, segmentLen * 0.78), patchMat, px, py, centerZ, 0, 0, ang, 'shield-patch'));
    }
  }

  // 6. 配管・ケーブルトレイ
  // 主配管 (低温推進剤ライン: 直径0.22m、側面に沿って全長に走る)
  const pipeLen = definition.length - 0.6;
  const pipeR = isRcs ? 0.06 : 0.11;
  const pipeMat = isRcs ? materials.pipeDark : materials.pipe;
  const pipeX = radius * 0.96;
  const pipeY = 0;
  const mainPipe = axialMesh(new THREE.CylinderGeometry(pipeR, pipeR, pipeLen, 16), pipeMat, 0, 'main-feedline');
  mainPipe.position.x = pipeX;
  mainPipe.position.y = pipeY;
  root.add(mainPipe);

  // 配管クランプブラケット（1.5m間隔）
  for (let z = -halfLen + 0.75; z < halfLen; z += 1.5) {
    const bracket = boxMesh(new THREE.BoxGeometry(0.14, 0.12, 0.12), materials.dark, pipeX - 0.04, pipeY, z, 0, 0, 0, 'pipe-clamp');
    root.add(bracket);
    // 配管ベローズ（伸縮継手）
    root.add(ringMesh(new THREE.TorusGeometry(pipeR * 1.3, 0.025, 6, 16), materials.rim, z, 'pipe-bellows'));
  }

  // 補助ライン (加圧ヘリウムライン / 電気レースウェイ)
  const subPipe = axialMesh(new THREE.CylinderGeometry(0.045, 0.045, pipeLen, 12), materials.pipe, 0, 'pressurization-line');
  subPipe.position.x = -radius * 0.96;
  subPipe.position.y = 0;
  root.add(subPipe);

  // 7. ISS風 EVA ハンドレール (上面 +Y に沿って1.5m間隔で配置)
  for (let z = -halfLen + 1.0; z < halfLen - 0.5; z += 1.5) {
    addHandrail(root, 0.25, radius * 0.99, z, 0.6, 0, 0);
  }

  // 8. 側面の結合サポートパッド
  for (const [name, dir] of [
    ['side:+x', new THREE.Vector3(1, 0, 0)],
    ['side:-x', new THREE.Vector3(-1, 0, 0)],
    ['side:+y', new THREE.Vector3(0, 1, 0)],
    ['side:-y', new THREE.Vector3(0, -1, 0)],
  ]) {
    const pad = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 0.08, 16), materials.rim);
    pad.name = `support-pad:${name}`;
    pad.position.set(dir.x * (radius - 0.02), dir.y * (radius - 0.02), 0);
    if (dir.x !== 0) pad.rotation.z = Math.PI / 2;
    root.add(pad);
  }

  // 9. 戦闘用装甲タンク専用ディテール（装甲カバー・強化バンド）
  if (isCombat) {
    const conduitArmor = boxMesh(new THREE.BoxGeometry(0.28, 0.22, pipeLen * 0.98), materials.armor, pipeX + 0.02, pipeY, 0, 0, 0, 0, 'pipe-armor');
    root.add(conduitArmor);
  }
}

// ------------------------------------------------------------- 主推進器 (Thruster)
// RL-10 / RS-25 / RD-180 風のベル曲線ノズル（放物線輪郭）+ ジンバル機構 + ターボポンプ排気管
function buildThruster(root, definition) {
  const radius = definition.diameter / 2; // 3.0m
  const halfLen = definition.length / 2;  // 0.5m

  // 1. 推力構造外郭シリンダー (z = -0.5m 〜 +0.5m)
  root.add(axialMesh(new THREE.CylinderGeometry(radius, radius, definition.length, 32, 1), materials.hullDark, 0, 'body'));
  for (const z of [-halfLen + 0.08, halfLen - 0.08]) {
    root.add(ringMesh(new THREE.TorusGeometry(radius * 0.94, 0.08, 8, 32), materials.rim, z, 'end-ring'));
  }

  // 2. 後部スラストコーンアダプター & 放射熱シールドバッフル
  const adapterGeo = new THREE.CylinderGeometry(radius * 0.95, radius * 0.65, 0.45, 24);
  root.add(axialMesh(adapterGeo, materials.hullDark, -0.25, 'thrust-adapter'));
  // 耐熱シールド板
  const baffle = axialMesh(new THREE.CylinderGeometry(radius * 0.64, radius * 0.64, 0.06, 24), materials.heatshield, -0.48, 'heat-baffle');
  root.add(baffle);

  // 3. 燃焼室 & インジェクターヘッド
  const chamberDome = axialMesh(new THREE.SphereGeometry(0.62, 16, 12, 0, Math.PI * 2, 0, Math.PI / 2), materials.nozzleThroat, -0.32, 'chamber-dome');
  root.add(chamberDome);
  // 推進剤供給トロイダルマニホールド（燃料・酸化剤リング）
  root.add(ringMesh(new THREE.TorusGeometry(0.68, 0.06, 8, 24), materials.pipe, -0.38, 'fuel-manifold'));
  root.add(ringMesh(new THREE.TorusGeometry(0.78, 0.05, 8, 24), materials.pipe, -0.44, 'lox-manifold'));

  // 4. 実在ロケットエンジンのベル曲線ノズル（放物線ラオ輪郭・肉厚ソリッド）
  // スロート: z = -0.58m (r = 0.44m) 〜 出口: z = -1.82m (r = 1.80m)
  const nozzlePts = [];
  const throatZ = -0.58;
  const exitZ = -1.82;
  const throatR = 0.44;
  const exitR = 1.80;
  const steps = 10;
  // 外壁 (スロート → 出口)
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const r = throatR + (exitR - throatR) * Math.sqrt(t);
    const z = throatZ + (exitZ - throatZ) * t;
    nozzlePts.push(new THREE.Vector2(r, z));
  }
  // 出口リップ
  nozzlePts.push(new THREE.Vector2(exitR - 0.06, exitZ));
  // 内壁 (出口 → スロート)
  for (let i = steps; i >= 0; i--) {
    const t = i / steps;
    const r = (throatR - 0.05) + ((exitR - 0.06) - (throatR - 0.05)) * Math.sqrt(t);
    const z = throatZ + (exitZ - throatZ) * t;
    nozzlePts.push(new THREE.Vector2(r, z));
  }
  nozzlePts.push(nozzlePts[0].clone());

  const bellGeo = new THREE.LatheGeometry(nozzlePts, 32);
  bellGeo.computeVertexNormals();
  const bell = axialMesh(bellGeo, materials.nozzleBell, 0, 'thrust-bell');
  root.add(bell);

  // 5. ノズル補強バンド（外周のフープ補強リング・冷却チューブバンド）
  for (const bz of [-0.95, -1.25, -1.55, -1.75]) {
    const t = (bz - throatZ) / (exitZ - throatZ);
    const br = throatR + (exitR - throatR) * Math.sqrt(t) + 0.015;
    root.add(ringMesh(new THREE.TorusGeometry(br, 0.035, 6, 24), materials.nozzleStiffener, bz, 'nozzle-stiffener'));
  }

  // 6. ジンバルアクチュエーター（推力偏向ピストンシリンダー2基）
  for (const sx of [-1, 1]) {
    const gAct = new THREE.Group();
    // シリンダー部
    const cyl = axialMesh(new THREE.CylinderGeometry(0.06, 0.06, 0.55, 12), materials.rim, -0.45);
    gAct.add(cyl);
    // ピストンロッド
    const rod = axialMesh(new THREE.CylinderGeometry(0.035, 0.035, 0.35, 8), materials.pipe, -0.7);
    gAct.add(rod);
    // ブラケット
    const bracket = boxMesh(new THREE.BoxGeometry(0.12, 0.15, 0.12), materials.dark, 0, 0, -0.22);
    gAct.add(bracket);

    gAct.position.set(sx * 1.05, 0.6, 0);
    gAct.rotation.z = -sx * 0.32;
    gAct.rotation.x = -0.22;
    root.add(gAct);
  }

  // 7. ターボポンプ機械部 & 排気ダクト
  const turbopump = boxMesh(new THREE.BoxGeometry(0.38, 0.45, 0.42), materials.dark, -0.85, -0.65, -0.62, 0, 0, 0.3, 'turbopump');
  root.add(turbopump);
  // 排気ダクトパイプ (ノズル側面に沿って伸びる)
  const exhaustDuct = axialMesh(new THREE.CylinderGeometry(0.09, 0.13, 1.15, 12), materials.pipeDark, -1.25, 'turbine-exhaust');
  exhaustDuct.position.set(-1.05, -0.75, 0);
  exhaustDuct.rotation.x = Math.PI / 2 + 0.18;
  root.add(exhaustDuct);

  // 8. スラストアンカー (ノズル出口位置)
  anchor(root, 'thrust', 0, 0, -1.85, new THREE.Vector3(0, 0, -1));
}

// ------------------------------------------------------------- ブースター (Booster)
// スペースシャトルSRB / SLSブースター風の段構造 + ノーズコーン + 分離モーター + スカート
function buildBooster(root, definition) {
  const radius = definition.diameter / 2; // 3.0m
  const halfLen = definition.length / 2;  // 3.0m

  // 1. 前方オジーブ / ノーズコーン (z = +1.5m 〜 +3.0m)
  // 直径6mから先端カラー（直径3.7m）へ滑らかに絞る
  const noseLen = 1.5;
  const noseGeo = new THREE.CylinderGeometry(radius * 0.62, radius, noseLen, 32);
  root.add(axialMesh(noseGeo, materials.tankMain, 2.25, 'nose-cone'));
  root.add(ringMesh(new THREE.TorusGeometry(radius * 0.62, 0.08, 8, 24), materials.rim, halfLen - 0.08, 'end-ring'));

  // 前方ステージング分離モーター（4方向の小径ノズルブリスター）
  for (let i = 0; i < 4; i++) {
    const ang = (i * Math.PI) / 2 + Math.PI / 4;
    const sepGeo = new THREE.BoxGeometry(0.24, 0.35, 0.32);
    const bx = Math.cos(ang) * (radius * 0.72);
    const by = Math.sin(ang) * (radius * 0.72);
    root.add(boxMesh(sepGeo, materials.dark, bx, by, 2.4, 0, 0, ang, 'sep-motor-pod'));
    // 分離ノズル（外側かつ前方に傾斜）
    const sepNozzle = axialMesh(new THREE.ConeGeometry(0.065, 0.14, 8, 1, true), materials.nozzleBell, 2.52, 'sep-nozzle');
    sepNozzle.position.set(bx * 1.08, by * 1.08, 2.42);
    sepNozzle.rotation.x = Math.PI / 2 - 0.45;
    sepNozzle.rotation.z = ang - Math.PI / 2;
    root.add(sepNozzle);
  }

  // 2. 固体ロケットモーター段セグメント胴体 (z = -1.8m 〜 +1.5m)
  const motorLen = 3.3;
  root.add(axialMesh(new THREE.CylinderGeometry(radius, radius, motorLen, 32), materials.tankMain, -0.15, 'body'));

  // ケーシング段継手（フィールドジョイント帯・ピン留め構造リング）
  for (const jz of [-0.95, 0.45]) {
    root.add(ringMesh(new THREE.TorusGeometry(radius * 1.015, 0.08, 8, 32), materials.rim, jz, 'field-joint'));
    // ジョイント留め具
    for (let i = 0; i < 8; i++) {
      const ang = (i * Math.PI) / 4;
      const pin = boxMesh(new THREE.BoxGeometry(0.06, 0.12, 0.18), materials.dark,
        Math.cos(ang) * (radius * 0.995), Math.sin(ang) * (radius * 0.995), jz, 0, 0, ang);
      root.add(pin);
    }
  }

  // システムズトンネル（電気・点火ケーブルを保護する全長ダクト）
  const tunnelGeo = new THREE.BoxGeometry(0.18, 0.09, definition.length * 0.85);
  root.add(boxMesh(tunnelGeo, materials.hullDark, radius * 0.98, 0, -0.2, 0, 0, 0, 'systems-tunnel'));

  // 3. 後部スカート（末広がり構造リング & ホールドダウンポスト座）(z = -3.0m 〜 -1.8m)
  const skirtLen = 1.2;
  const skirtGeo = new THREE.CylinderGeometry(radius, radius * 1.055, skirtLen, 32);
  root.add(axialMesh(skirtGeo, materials.hullDark, -2.4, 'aft-skirt'));
  root.add(ringMesh(new THREE.TorusGeometry(radius * 1.055, 0.10, 8, 32), materials.rim, -halfLen + 0.08, 'end-ring'));

  // ホールドダウンブラケット / TVCアクチュエーターフェアリング（4箇所）
  for (let i = 0; i < 4; i++) {
    const ang = (i * Math.PI) / 2;
    const fairing = boxMesh(new THREE.BoxGeometry(0.35, 0.48, 0.85), materials.dark,
      Math.cos(ang) * (radius * 1.02), Math.sin(ang) * (radius * 1.02), -2.45, 0, 0, ang, 'tvc-fairing');
    root.add(fairing);
  }

  // 4. 重固体ロケットノズルベル
  const bNozzlePts = [];
  const bThroatZ = -2.85;
  const bExitZ = -4.35;
  const bThroatR = 0.62;
  const bExitR = 1.95;
  const bSteps = 10;
  for (let i = 0; i <= bSteps; i++) {
    const t = i / bSteps;
    const r = bThroatR + (bExitR - bThroatR) * Math.sqrt(t);
    const z = bThroatZ + (bExitZ - bThroatZ) * t;
    bNozzlePts.push(new THREE.Vector2(r, z));
  }
  bNozzlePts.push(new THREE.Vector2(bExitR - 0.07, bExitZ));
  for (let i = bSteps; i >= 0; i--) {
    const t = i / bSteps;
    const r = (bThroatR - 0.06) + ((bExitR - 0.07) - (bThroatR - 0.06)) * Math.sqrt(t);
    const z = bThroatZ + (bExitZ - bThroatZ) * t;
    bNozzlePts.push(new THREE.Vector2(r, z));
  }
  bNozzlePts.push(bNozzlePts[0].clone());

  const bBellGeo = new THREE.LatheGeometry(bNozzlePts, 32);
  bBellGeo.computeVertexNormals();
  const bBell = axialMesh(bBellGeo, materials.nozzleBell, 0, 'thrust-bell');
  root.add(bBell);

  // ノズル補強バンド
  for (const bz of [-3.3, -3.7, -4.1]) {
    const t = (bz - bThroatZ) / (bExitZ - bThroatZ);
    const br = bThroatR + (bExitR - bThroatR) * Math.sqrt(t) + 0.02;
    root.add(ringMesh(new THREE.TorusGeometry(br, 0.04, 6, 24), materials.nozzleStiffener, bz, 'booster-nozzle-band'));
  }

  // 5. スラストアンカー
  anchor(root, 'thrust', 0, 0, -4.38, new THREE.Vector3(0, 0, -1));
}

// ------------------------------------------------------------- RCS スラスター
function buildRcs(root, definition) {
  const radius = definition.diameter / 2;
  const halfLen = definition.length / 2;

  // 胴体リング
  root.add(axialMesh(new THREE.CylinderGeometry(radius, radius, definition.length, 32, 1), materials.dark, 0, 'body'));
  for (const z of [-halfLen + 0.08, halfLen - 0.08]) {
    root.add(ringMesh(new THREE.TorusGeometry(radius * 0.94, 0.08, 8, 24), materials.rim, z, 'end-ring'));
  }

  // 4方向のRCSクアッドポッド
  for (const direction of [
    new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0),
    new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, -1, 0),
  ]) {
    const ang = Math.atan2(direction.y, direction.x);
    // ポッド基部ブロック
    const pod = boxMesh(new THREE.BoxGeometry(0.38, 0.38, 0.45), materials.dark,
      direction.x * (radius - 0.05), direction.y * (radius - 0.05), definition.length * 0.35, 0, 0, ang, 'rcs-pod');
    root.add(pod);

    // 主噴射ノズル (外向き)
    const mainNozzle = axialMesh(new THREE.ConeGeometry(0.09, 0.22, 12, 1, true), materials.nozzleBell, 0, 'rcs-nozzle');
    mainNozzle.position.set(direction.x * (radius + 0.15), direction.y * (radius + 0.15), definition.length * 0.35);
    mainNozzle.rotation.z = ang - Math.PI / 2;
    root.add(mainNozzle);

    // 軸方向補助ノズル (+Z / -Z)
    for (const sz of [-1, 1]) {
      const axNozzle = axialMesh(new THREE.ConeGeometry(0.05, 0.12, 8, 1, true), materials.nozzleBell,
        definition.length * 0.35 + sz * 0.18, 'rcs-axial-nozzle');
      axNozzle.position.set(direction.x * (radius + 0.06), direction.y * (radius + 0.06), definition.length * 0.35 + sz * 0.18);
      if (sz < 0) axNozzle.rotation.x = -Math.PI / 2;
      root.add(axNozzle);
    }

    // アンカー登録
    anchor(
      root, `rcs:${direction.x},${direction.y}`,
      direction.x * radius, direction.y * radius, definition.length * 0.35, direction,
    );
  }

  anchor(root, 'rcs:roll:+', radius, 0, 0, new THREE.Vector3(0, -1, 0));
  anchor(root, 'rcs:roll:-', radius, 0, 0, new THREE.Vector3(0, 1, 0));
}

// ------------------------------------------------------------- 機関砲 (Weapon)
function buildWeapon(root, definition) {
  const radius = definition.diameter / 2;
  const halfLen = definition.length / 2;

  root.add(axialMesh(new THREE.CylinderGeometry(radius, radius, definition.length, 32, 1), materials.dark, 0, 'body'));
  for (const z of [-halfLen + 0.08, halfLen - 0.08]) {
    root.add(ringMesh(new THREE.TorusGeometry(radius * 0.94, 0.08, 8, 24), materials.rim, z, 'end-ring'));
  }

  // 中央機関砲基台マウント
  const mount = boxMesh(new THREE.BoxGeometry(1.9, 0.9, 0.65), materials.armor, 0, 0, halfLen + 0.15, 0, 0, 0, 'gun-mount');
  root.add(mount);

  // 左右ガトリング砲身アセンブリ
  for (const x of [-0.7, 0.7]) {
    // 砲身レシーバーハウジング
    const receiver = axialMesh(new THREE.CylinderGeometry(0.26, 0.30, 0.55, 16), materials.dark, halfLen + 0.35, 'receiver');
    receiver.position.x = x;
    root.add(receiver);

    // ガトリング多連砲身（中央バレル + 放熱スリーブ）
    const barrel = axialMesh(new THREE.CylinderGeometry(0.18, 0.23, 1.2, 16), materials.dark,
      halfLen + 0.55, 'barrel');
    barrel.position.x = x;
    root.add(barrel);

    // マズルブレーキ / 消炎器
    const muzzleBrake = axialMesh(new THREE.CylinderGeometry(0.21, 0.18, 0.18, 16), materials.rim,
      halfLen + 1.15, 'muzzle-brake');
    muzzleBrake.position.x = x;
    root.add(muzzleBrake);

    anchor(root, `muzzle:${x > 0 ? 'right' : 'left'}`, x, 0, halfLen + 1.15);
  }

  // 給弾シュートガイド
  const feedChute = boxMesh(new THREE.BoxGeometry(0.42, 0.28, 0.35), materials.dark, 0, -radius * 0.65, 0, 0, 0, 0, 'feed-chute');
  root.add(feedChute);
  anchor(root, 'belt', 0, -radius * 0.65, 0, new THREE.Vector3(1, 0, 0));
}

// ------------------------------------------------------------- 装甲 (Armor)
function buildArmor(root, definition) {
  const radius = definition.diameter / 2;
  const isCombat = definition.id === 'armor-combat';
  const halfLen = definition.length / 2;

  // 主円筒
  root.add(axialMesh(new THREE.CylinderGeometry(radius * 1.04, radius * 1.04, definition.length, 32, 1), materials.armor, 0, 'body'));
  for (const z of [-halfLen + 0.08, halfLen - 0.08]) {
    root.add(ringMesh(new THREE.TorusGeometry(radius * 0.98, 0.09, 8, 32), materials.rim, z, 'end-ring'));
  }

  // 外周複合装甲プレート（多面体傾斜装甲ブロック）
  const tileCount = isCombat ? 12 : 8;
  const tileArc = (Math.PI * 2) / tileCount;
  for (let i = 0; i < tileCount; i++) {
    const ang = i * tileArc;
    const tx = Math.cos(ang) * (radius * 1.05);
    const ty = Math.sin(ang) * (radius * 1.05);
    const tileGeo = new THREE.BoxGeometry(0.85, 0.12, definition.length * 0.88);
    const plate = boxMesh(tileGeo, isCombat ? materials.dark : materials.armor, tx, ty, 0, 0, 0, ang + Math.PI / 2, 'armor-tile');
    root.add(plate);

    // 固定用ボルトフランジ
    for (const sz of [-0.3, 0.3]) {
      const bolt = boxMesh(new THREE.BoxGeometry(0.06, 0.16, 0.08), materials.rim, tx * 1.02, ty * 1.02, sz, 0, 0, ang, 'retaining-bolt');
      root.add(bolt);
    }
  }
}

// ------------------------------------------------------------- 展開部材 (Radiator / Solar Panel)
// 契約テスト 'ship module asset: 展開部品は実寸に対応する枚数と幅を持つ' を厳密に満たす
function buildDeployablePanels(root, definition) {
  const panelMaterial = definition.kind === 'radiator' ? materials.radiator : materials.solar;
  const count = definition.kind === 'radiator' ? RADIATOR_FOLD_COUNT : SOLAR_PANEL_COUNT;
  const panelWidth = definition.kind === 'radiator' ? RADIATOR_SEGMENT_LENGTH : SOLAR_PANEL_WIDTH;
  const panelSpan = definition.kind === 'radiator' ? RADIATOR_PANEL_WIDTH : SOLAR_PANEL_SPAN;
  const panelThickness = definition.kind === 'radiator' ? 0.08 : 0.06;
  const hinge = anchor(root, 'panel-hinge', 0, 0, definition.length / 2);

  for (let index = 0; index < count; index++) {
    const panelHinge = anchor(hinge, `panel-hinge:${index}`, 0, 0, index * panelWidth);
    panelHinge.userData = {
      ...panelHinge.userData,
      panelIndex: index,
      panelKind: definition.kind,
      panelWidth,
      panelSpan,
    };
    const geo = definition.kind === 'radiator'
      ? new THREE.BoxGeometry(panelThickness, panelSpan * 0.96, panelWidth * 0.96)
      : new THREE.BoxGeometry(panelSpan * 0.96, panelThickness, panelWidth * 0.96);
    const panel = new THREE.Mesh(geo, panelMaterial);
    panel.name = index === 0 ? 'deployable-panel' : `deployable-panel:${index}`;
    panel.position.set(0, 0, panelWidth * 0.48);
    panelHinge.add(panel);
  }
}

// ------------------------------------------------------------- 展開部材 (Radiator / Solar Panel)
// 契約テスト 'ship module asset: 展開部品は実寸に対応する枚数と幅を持つ' を厳密に満たす
// 取り付け面から直接直立する設計—蛇腹式の円筒ハブ構造は持たない。
function buildDeployable(root, definition) {
  const halfLen = definition.length / 2;

  // 取り付けフランジ（モジュール接合面に薄い板）
  const flangeR = definition.diameter / 2 * 0.85;
  root.add(axialMesh(
    new THREE.CylinderGeometry(flangeR, flangeR, 0.12, 24, 1),
    materials.rim, halfLen - 0.06, 'deploy-flange',
  ));

  buildDeployablePanels(root, definition);
}

// ------------------------------------------------------------- ドッキング / ドック / デカプラー
// APAS-95 / CBM 風のインターフェースリング + ガイドペタル + アライメントピン (interface-ring保持)
function buildDocking(root, definition) {
  const radius = definition.diameter / 2;
  const halfLen = definition.length / 2;
  const color = definition.kind === 'dock' ? materials.dock : materials.rim;

  // 主リング円筒
  root.add(axialMesh(new THREE.CylinderGeometry(radius, radius, definition.length, 32, 1), color, 0, 'ring'));

  // インターフェースリング（契約テスト 'ship module asset: interface ring は接続面と同じ +Z 法線を持つ' に完全準拠）
  root.add(ringMesh(new THREE.TorusGeometry(radius * 0.78, radius * 0.12, 8, 32), materials.dark,
    halfLen + 0.02, 'interface-ring'));

  // APAS/CBM風 ドッキングガイドペタル（3枚の三角形爪）
  for (let i = 0; i < 3; i++) {
    const ang = (i * Math.PI * 2) / 3;
    const petal = boxMesh(new THREE.BoxGeometry(0.38, 0.18, 0.22), materials.dock,
      Math.cos(ang) * (radius * 0.76), Math.sin(ang) * (radius * 0.76), halfLen + 0.12, 0.25, 0, ang, 'guide-petal');
    root.add(petal);
  }

  // アライメントピン & ラッチストライク
  for (let i = 0; i < 6; i++) {
    const ang = (i * Math.PI) / 3 + Math.PI / 6;
    const pin = axialMesh(new THREE.CylinderGeometry(0.04, 0.04, 0.14, 8), materials.rim, halfLen + 0.08, 'alignment-pin');
    pin.position.set(Math.cos(ang) * (radius * 0.72), Math.sin(ang) * (radius * 0.72), halfLen + 0.08);
    root.add(pin);
  }

  const semantic = definition.kind === 'dock' ? 'construction-dock'
    : definition.kind === 'docking_port' ? 'docking-port' : 'decoupler';
  anchor(root, semantic, 0, 0, halfLen, new THREE.Vector3(0, 0, 1));
}

async function addKindDetails(root, definition) {
  const modelId = definition.modelId;
  const glbName = `${modelId}.glb`;

  switch (definition.kind) {
    case 'cockpit':
      if (await applyGlbModel(root, glbName)) return;
      buildCockpit(root, definition);
      break;
    case 'tank':
      if (await applyGlbModel(root, glbName)) return;
      buildTank(root, definition);
      break;
    case 'thruster':
      if (await applyGlbModel(root, glbName)) {
        anchor(root, 'thrust', 0, 0, -definition.length / 2, new THREE.Vector3(0, 0, -1));
        return;
      }
      buildThruster(root, definition);
      break;
    case 'booster':
      if (await applyGlbModel(root, glbName)) {
        anchor(root, 'thrust', 0, 0, -definition.length / 2, new THREE.Vector3(0, 0, -1));
        return;
      }
      buildBooster(root, definition);
      break;
    case 'rcs':
      if (await applyGlbModel(root, glbName)) {
        anchor(root, 'rcs:1,0', 1, 0, 0, new THREE.Vector3(1, 0, 0));
        anchor(root, 'rcs:-1,0', -1, 0, 0, new THREE.Vector3(-1, 0, 0));
        anchor(root, 'rcs:0,1', 0, 1, 0, new THREE.Vector3(0, 1, 0));
        anchor(root, 'rcs:0,-1', 0, -1, 0, new THREE.Vector3(0, -1, 0));
        anchor(root, 'rcs:roll:+', 0, 1, 0, new THREE.Vector3(1, 0, 0));
        anchor(root, 'rcs:roll:-', 0, -1, 0, new THREE.Vector3(-1, 0, 0));
        return;
      }
      buildRcs(root, definition);
      break;
    case 'weapon':
      if (await applyGlbModel(root, glbName)) {
        anchor(root, 'muzzle:left', -1.5, 0, definition.length / 2 + 0.25, new THREE.Vector3(0, 0, 1));
        anchor(root, 'muzzle:right', 1.5, 0, definition.length / 2 + 0.25, new THREE.Vector3(0, 0, 1));
        anchor(root, 'belt', 0, 0, 0);
        return;
      }
      buildWeapon(root, definition);
      break;
    case 'armor':
      if (await applyGlbModel(root, glbName)) return;
      buildArmor(root, definition);
      break;
    case 'radiator':
    case 'solar_panel': {
      const baseGlb = definition.kind === 'solar_panel' ? 'solar-panel-base.glb' : 'radiator-base.glb';
      if (await applyGlbModel(root, baseGlb)) {
        buildDeployablePanels(root, definition);
        return;
      }
      buildDeployable(root, definition);
      break;
    }
    case 'docking_port':
    case 'dock':
    case 'decoupler':
      if (await applyGlbModel(root, glbName)) {
        const semantic = definition.kind === 'dock' ? 'construction-dock'
          : definition.kind === 'docking_port' ? 'docking-port' : 'decoupler';
        anchor(root, semantic, 0, 0, definition.length / 2, new THREE.Vector3(0, 0, 1));
        return;
      }
      buildDocking(root, definition);
      break;
  }
}

async function buildModule(definition) {
  const root = new THREE.Group();
  root.name = `module:${definition.modelId}`;
  root.userData = { moduleModelId: definition.modelId, moduleKind: definition.kind };
  connectionAnchors(root, definition);
  await addKindDetails(root, definition);
  return root;
}

export async function buildShipModules() {
  const root = new THREE.Group();
  root.name = 'ship-modules';
  const modelIds = new Set();
  for (const definition of SHIP_MODULE_CATALOG.all()) {
    if (modelIds.has(definition.modelId)) continue;
    modelIds.add(definition.modelId);
    root.add(await buildModule(definition));
  }
  return root;
}
