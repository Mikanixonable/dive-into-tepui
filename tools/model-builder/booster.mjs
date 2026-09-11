// 再使用可能な一段ブースターと、段間カバーのモデル。機体の長手方向をローカル Z 軸とし、機首(前端)が
// +Z、ノズル(船尾)が -Z で、前端カプラーのおおよその面を z=0 に置く。段間カバーは別モデルにし、
// 被せる段にだけ足す。
import * as THREE from 'three';
import { importTsDataModule } from '../compile-source.mjs';
import { std } from './materials.mjs';

const {
  BOOSTER_INTERSTAGE_BOLT_Z,
  BOOSTER_INTERSTAGE_COVER_RADIUS,
  BOOSTER_INTERSTAGE_COVER_SEGMENTS,
  BOOSTER_INTERSTAGE_COVER_Z,
  BOOSTER_STAGE_DIMENSIONS,
} = await importTsDataModule('src/physics/booster-stage-shape.ts');

// 段間カバーのパネル1枚の寸法 [m](径方向の厚み・周方向の幅・長手方向の長さ)。
const BOOSTER_INTERSTAGE_COVER_PANEL_RADIAL = 0.18;
const BOOSTER_INTERSTAGE_COVER_PANEL_TANGENTIAL = 0.72;
const BOOSTER_INTERSTAGE_COVER_LENGTH = 1.66;

// 円筒・円錐・円環の軸を長手方向(ローカル Z)へ寝かせて parent の z へ置く。
function addAxialMesh(parent, geometry, material, z, name) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.rotation.x = Math.PI / 2;
  mesh.position.z = z;
  mesh.name = name;
  parent.add(mesh);
}

export function buildBoosterStage() {
  const g = new THREE.Group();
  g.name = 'booster-stage';

  const tankMaterial = std(0x6c7785, { roughness: 0.48, metalness: 0.72 });
  const metalMaterial = std(0xb5c0ca, { roughness: 0.3, metalness: 1 });
  const darkMetalMaterial = std(0xd9702e, { roughness: 0.58, metalness: 0.9 });
  const gasketMaterial = std(0xa64e1e, { roughness: 0.7, metalness: 0.35 });
  const hotMaterial = std(0x49332d, { emissive: 0x32140e, emissiveIntensity: 0.5, roughness: 0.65, metalness: 0.85 });

  // 円筒タンク本体と、圧力容器であることを側面から読ませる溶接/補強バンド。
  const { tankRadius, tankLength } = BOOSTER_STAGE_DIMENSIONS;
  addAxialMesh(g, new THREE.CylinderGeometry(tankRadius, tankRadius, tankLength, 20, 2), tankMaterial, -3.03, 'tank');
  for (const z of [-1.08, -3.03, -4.98]) {
    addAxialMesh(g, new THREE.TorusGeometry(1.285, 0.055, 8, 20), metalMaterial, z, `tank-band-${z}`);
  }

  // 前端カプラーリング。中央の暗い面と外周リング、六本のボルトで段間接続面として識別させる。
  const frontCoupler = new THREE.Object3D();
  frontCoupler.position.z = BOOSTER_STAGE_DIMENSIONS.frontCouplerZ;
  frontCoupler.name = 'front-coupler';
  g.add(frontCoupler);
  addAxialMesh(frontCoupler, new THREE.CylinderGeometry(1.52, 1.52, 0.28, 20), metalMaterial, 0, 'flange');
  addAxialMesh(frontCoupler, new THREE.CylinderGeometry(1.18, 1.18, 0.1, 20), gasketMaterial, 0.16, 'socket');
  addAxialMesh(frontCoupler, new THREE.TorusGeometry(1.31, 0.095, 8, 20), metalMaterial, 0.17, 'outer-ring');
  addAxialMesh(frontCoupler, new THREE.TorusGeometry(1.08, 0.06, 8, 20), gasketMaterial, 0.2, 'inner-ring');
  const boltGeometry = new THREE.CylinderGeometry(0.075, 0.075, 0.16, 8);
  for (let i = 0; i < 6; i++) {
    const angle = i * Math.PI / 3;
    const bolt = new THREE.Mesh(boltGeometry, darkMetalMaterial);
    bolt.rotation.x = Math.PI / 2;
    bolt.position.set(Math.cos(angle) * 1.36, Math.sin(angle) * 1.36, 0.2);
    bolt.name = `coupler-bolt-${i}`;
    frontCoupler.add(bolt);
  }

  // 後端デカプラーリング。前端より太いフランジで、分離面をタンクとノズルの境界として見せる。
  const aftDecoupler = new THREE.Object3D();
  aftDecoupler.position.z = BOOSTER_STAGE_DIMENSIONS.aftDecouplerZ;
  aftDecoupler.name = 'aft-decoupler';
  g.add(aftDecoupler);
  addAxialMesh(aftDecoupler, new THREE.CylinderGeometry(1.49, 1.49, 0.34, 20), metalMaterial, 0, 'flange');
  addAxialMesh(aftDecoupler, new THREE.CylinderGeometry(1.28, 1.28, 0.13, 20), gasketMaterial, -0.2, 'gasket');
  addAxialMesh(aftDecoupler, new THREE.TorusGeometry(1.4, 0.1, 8, 20), metalMaterial, -0.2, 'outer-ring');
  addAxialMesh(aftDecoupler, new THREE.TorusGeometry(1.18, 0.06, 8, 20), gasketMaterial, 0.02, 'inner-ring');

  // 後端ベルノズル。ConeGeometry の底面が船尾側へ来るので、船尾へ向かって広がる。
  const nozzle = new THREE.Object3D();
  nozzle.position.z = -6.0;
  nozzle.name = 'aft-nozzle';
  g.add(nozzle);
  addAxialMesh(nozzle, new THREE.CylinderGeometry(0.94, 0.94, 0.38, 18), darkMetalMaterial, 0, 'mount');
  addAxialMesh(nozzle, new THREE.ConeGeometry(0.88, 1.62, 24, 1, false), hotMaterial, -1.0, 'bell');
  addAxialMesh(nozzle, new THREE.ConeGeometry(0.67, 1.5, 24, 1, true), gasketMaterial, -1.03, 'inner-bell');
  addAxialMesh(nozzle, new THREE.TorusGeometry(1.28, 0.1, 8, 20), metalMaterial, -1.79, 'exit-ring');
  addAxialMesh(nozzle, new THREE.CylinderGeometry(0.52, 0.52, 0.12, 18), gasketMaterial, -1.83, 'exit-aperture');

  // 四枚の小さな安定フィン。後方から見たときもブースターの向きを読みやすくする。
  const finGeometry = new THREE.BoxGeometry(0.12, 0.82, 1.25);
  for (let i = 0; i < 4; i++) {
    const angle = i * Math.PI / 2;
    const fin = new THREE.Mesh(finGeometry, darkMetalMaterial);
    fin.position.set(Math.cos(angle) * 1.05, Math.sin(angle) * 1.05, -6.75);
    fin.rotation.z = angle;
    fin.name = `aft-fin-${i}`;
    g.add(fin);
  }
  return g;
}

// 段間カバー。接続中は後ろの段のデカプラー側面を6枚のパネルで囲み、爆砕ボルトで留める。
// 部品名 `interstage-cover-panel-${i}` / `interstage-explosive-bolt-${i}` は、分離した部品を
// src/render/dynamic/booster-model.ts が引く鍵なので変えない。
export function buildBoosterInterstageCover() {
  const cover = new THREE.Group();
  cover.name = 'interstage-cover';
  const panelGeometry = new THREE.BoxGeometry(
    BOOSTER_INTERSTAGE_COVER_PANEL_RADIAL,
    BOOSTER_INTERSTAGE_COVER_PANEL_TANGENTIAL,
    BOOSTER_INTERSTAGE_COVER_LENGTH,
  );
  const panelMaterial = std(0x3d4b59, { roughness: 0.42, metalness: 0.82 });
  const boltGeometry = new THREE.CylinderGeometry(0.095, 0.095, 0.28, 8);
  const boltMaterial = std(0xe19a3e, { emissive: 0x6d260c, emissiveIntensity: 0.55, roughness: 0.38, metalness: 0.9 });

  for (let i = 0; i < BOOSTER_INTERSTAGE_COVER_SEGMENTS; i++) {
    const angle = (i * Math.PI * 2) / BOOSTER_INTERSTAGE_COVER_SEGMENTS;
    const panel = new THREE.Mesh(panelGeometry, panelMaterial);
    panel.rotation.z = angle;
    panel.position.set(
      Math.cos(angle) * BOOSTER_INTERSTAGE_COVER_RADIUS,
      Math.sin(angle) * BOOSTER_INTERSTAGE_COVER_RADIUS,
      BOOSTER_INTERSTAGE_COVER_Z,
    );
    panel.name = `interstage-cover-panel-${i}`;
    cover.add(panel);

    const bolt = new THREE.Mesh(boltGeometry, boltMaterial);
    bolt.rotation.set(Math.PI / 2, 0, angle);
    bolt.position.set(
      Math.cos(angle) * (BOOSTER_INTERSTAGE_COVER_RADIUS + 0.08),
      Math.sin(angle) * (BOOSTER_INTERSTAGE_COVER_RADIUS + 0.08),
      BOOSTER_INTERSTAGE_BOLT_Z,
    );
    bolt.name = `interstage-explosive-bolt-${i}`;
    cover.add(bolt);
  }
  return cover;
}
