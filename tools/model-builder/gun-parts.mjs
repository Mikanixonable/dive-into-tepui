// 機関砲の弾薬と消耗部品のモデル — 実弾入りのマガジンと薬莢。
import * as THREE from 'three';
import { importTsDataModule } from '../compile-source.mjs';
import { F0_ALUMINIUM, F0_BRASS, F0_BURNT_STEEL, F0_STEEL, std } from './materials.mjs';

const { MAG_THICKNESS, MAG_WIDTH, MAG_BELT_PITCH } = await importTsDataModule('src/physics/player-shape.ts');
const { MAG_ROUNDS } = await importTsDataModule('src/game/player/ammo-spec.ts');

const CARTRIDGE_COUNT = 3;
const ROUNDS_PER_CARTRIDGE = 8;
if (MAG_ROUNDS !== CARTRIDGE_COUNT * ROUNDS_PER_CARTRIDGE) {
  throw new Error('MAG_ROUNDS must match the 3 × 8 cartridge layout');
}

// 薬莢輪郭の縮尺。排出表示が長手方向だけ2倍するため、ここでは径を0.2倍、長さを0.2倍し、
// 表示とマガジン内で同じ最終形状になるようマガジン側も長手方向を2倍する。
const CASING_RADIUS_SCALE = 0.2;
const CASING_LENGTH_SCALE = 0.2;
const CASING_PROFILE = [
  new THREE.Vector2(0.000 * CASING_RADIUS_SCALE, -0.56 * CASING_LENGTH_SCALE),
  new THREE.Vector2(0.330 * CASING_RADIUS_SCALE, -0.56 * CASING_LENGTH_SCALE),
  new THREE.Vector2(0.330 * CASING_RADIUS_SCALE, -0.47 * CASING_LENGTH_SCALE),
  new THREE.Vector2(0.230 * CASING_RADIUS_SCALE, -0.47 * CASING_LENGTH_SCALE),
  new THREE.Vector2(0.230 * CASING_RADIUS_SCALE, -0.38 * CASING_LENGTH_SCALE),
  new THREE.Vector2(0.305 * CASING_RADIUS_SCALE, -0.35 * CASING_LENGTH_SCALE),
  new THREE.Vector2(0.300 * CASING_RADIUS_SCALE,  0.18 * CASING_LENGTH_SCALE),
  new THREE.Vector2(0.175 * CASING_RADIUS_SCALE,  0.34 * CASING_LENGTH_SCALE),
  new THREE.Vector2(0.148 * CASING_RADIUS_SCALE,  0.42 * CASING_LENGTH_SCALE),
  new THREE.Vector2(0.148 * CASING_RADIUS_SCALE,  0.54 * CASING_LENGTH_SCALE),
  new THREE.Vector2(0.115 * CASING_RADIUS_SCALE,  0.54 * CASING_LENGTH_SCALE),
];

const magPlateMat = std(F0_STEEL, { metalness: 1, roughness: 0.42 });
const magRecessMat = std(F0_BURNT_STEEL, { metalness: 1, roughness: 0.48 });
const cartridgeMat = std(F0_ALUMINIUM, { metalness: 1, roughness: 0.38 });
const magRoundMat = std(F0_BRASS, { metalness: 1, roughness: 0.32 });
const magTipMat = std(F0_ALUMINIUM, { metalness: 1, roughness: 0.36 });
const magCaseGeo = new THREE.LatheGeometry(CASING_PROFILE, 12);
const magProjProfile = [
  new THREE.Vector2(0.000, -0.006),
  new THREE.Vector2(0.019, -0.006),
  new THREE.Vector2(0.019,  0.072),
  new THREE.Vector2(0.014,  0.100),
  new THREE.Vector2(0.007,  0.116),
  new THREE.Vector2(0.000,  0.122),
];
const magProjGeo = new THREE.LatheGeometry(magProjProfile, 12);

function taggedMesh(geometry, material, role) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.userData = { role };
  return mesh;
}

function box(parent, size, position, material, role) {
  const mesh = taggedMesh(new THREE.BoxGeometry(...size), material, role);
  mesh.position.set(...position);
  parent.add(mesh);
  return mesh;
}

// 実弾入りのマガジン。給弾口は +Z、弾は各カートリッジ内で X 方向に8発並ぶ。
// magazineFrame と cartridgeFrame の Group 境界は、排出用の空テンプレート抽出に使う。
export function buildMagazineMesh() {
  const magazine = new THREE.Group();
  const frame = new THREE.Group();
  frame.name = 'magazineFrame';
  frame.userData = { role: 'magazineFrame' };
  magazine.add(frame);

  const width = MAG_WIDTH;
  const thickness = MAG_THICKNESS;
  const depth = thickness;
  const wall = 0.035;
  const shellHeight = thickness * 0.25;

  // 外箱は薄い角形の枠とコーナーリブで構成する。
  for (const y of [-thickness / 2, thickness / 2]) {
    box(frame, [width, wall, depth], [0, y, 0], magPlateMat, 'magazineFrame');
  }
  for (const x of [-width / 2 + wall / 2, width / 2 - wall / 2]) {
    box(frame, [wall, thickness * 0.84, depth], [x, 0, 0], magPlateMat, 'magazineFrame');
  }
  // 前面の弾路を開き、四隅の柱と後面の細い横桁で箱を保つ。
  for (const x of [-width * 0.46, width * 0.46]) {
    for (const z of [-depth * 0.46, depth * 0.46]) {
      box(frame, [wall, thickness * 0.84, wall], [x, 0, z], magPlateMat, 'magazineFrame');
    }
  }
  box(frame, [width * 0.88, wall, wall], [0, -thickness * 0.38, -depth * 0.46], magPlateMat, 'magazineFrame');
  // フィード側の目印。
  for (const x of [-width * 0.38, width * 0.38]) {
    box(frame, [wall * 1.5, thickness * 0.62, wall * 2], [x, 0, depth / 2], magRecessMat, 'magazineFrame');
  }

  // ベルトの隣接マガジンと噛み合うナックル継手。片側の張り出しはピッチ余白の半分に収める。
  const hingeReach = (MAG_BELT_PITCH - width) / 2;
  const hingeX = width / 2 + hingeReach;
  for (const side of [-1, 1]) {
    const web = taggedMesh(new THREE.BoxGeometry(hingeReach * 1.3, 0.075, 0.16), magPlateMat, 'magazineFrame');
    web.position.set(side * (width / 2 + hingeReach * 0.35), 0, 0);
    frame.add(web);

    const barrel = new THREE.Mesh(
      new THREE.CylinderGeometry(0.045, 0.045, depth * 0.48, 12, 1, true),
      magPlateMat,
    );
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(side * hingeX, 0, 0);
    barrel.userData = { role: 'magazineFrame' };
    frame.add(barrel);

    const pin = new THREE.Mesh(
      new THREE.CylinderGeometry(0.018, 0.018, depth * 0.56, 10),
      magRecessMat,
    );
    pin.rotation.x = Math.PI / 2;
    pin.position.set(side * hingeX, 0, 0);
    pin.userData = { role: 'magazineFrame' };
    frame.add(pin);
    for (const z of [-depth * 0.25, depth * 0.25]) {
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.034, 0.034, 0.018, 10), magRecessMat);
      cap.rotation.x = Math.PI / 2;
      cap.position.set(side * hingeX, 0, z);
      cap.userData = { role: 'magazineFrame' };
      frame.add(cap);
    }
  }

  const cartridgeWidth = width * 0.88;
  const roundPitch = (cartridgeWidth - 0.12) / ROUNDS_PER_CARTRIDGE;
  for (let stage = 0; stage < CARTRIDGE_COUNT; stage++) {
    const cartridge = new THREE.Group();
    cartridge.name = `cartridge:${stage}`;
    cartridge.userData = { role: 'cartridgeFrame', stage };
    cartridge.position.y = (1 - stage) * shellHeight;
    magazine.add(cartridge);

    const shellRole = 'cartridgeShell';
    const cartridgeDepth = depth * 0.91;
    const rail = wall * 0.72;
    box(cartridge, [cartridgeWidth, rail, cartridgeDepth], [0, -shellHeight * 0.41, 0], cartridgeMat, shellRole);
    box(cartridge, [cartridgeWidth, rail, cartridgeDepth], [0, shellHeight * 0.41, 0], cartridgeMat, shellRole);
    for (const x of [-cartridgeWidth / 2 + rail / 2, cartridgeWidth / 2 - rail / 2]) {
      box(cartridge, [rail, shellHeight * 0.8, cartridgeDepth], [x, 0, 0], cartridgeMat, shellRole);
    }
    for (const z of [-cartridgeDepth / 2 + rail / 2, cartridgeDepth / 2 - rail / 2]) {
      box(cartridge, [cartridgeWidth - rail * 2, shellHeight * 0.8, rail], [0, 0, z], cartridgeMat, shellRole);
    }

    for (let round = 0; round < ROUNDS_PER_CARTRIDGE; round++) {
      const x = (round - (ROUNDS_PER_CARTRIDGE - 1) / 2) * roundPitch;
      const roundGroup = new THREE.Group();
      roundGroup.name = `round:${round}`;
      roundGroup.userData = { role: 'round', index: round };
      cartridge.add(roundGroup);

      const casing = taggedMesh(magCaseGeo, magRoundMat, 'roundCase');
      casing.rotation.x = Math.PI / 2;
      casing.scale.y = 2;
      casing.position.set(x, 0, -0.025);
      roundGroup.add(casing);

      // 弾頭は薬莢口から先に出る独立形状。
      const projectile = taggedMesh(magProjGeo, magTipMat, 'projectile');
      projectile.rotation.x = Math.PI / 2;
      projectile.scale.y = 2;
      projectile.position.set(x, 0, 0.105);
      roundGroup.add(projectile);
    }
  }

  return magazine;
}

// 排出薬莢は magazine 内の薬莢と同じ輪郭を使う。表示側で長手方向を2倍する。
export function buildCasingMesh() {
  const geo = new THREE.LatheGeometry(CASING_PROFILE, 12);
  const mat = new THREE.MeshStandardMaterial({
    color: F0_BRASS,
    metalness: 1,
    roughness: 0.28,
  });
  return new THREE.Mesh(geo, mat);
}
