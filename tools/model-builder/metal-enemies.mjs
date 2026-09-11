// 金属の敵機のモデル。アクセント色を差し替える材質には userData.role = 'accent' を付ける。
import * as THREE from 'three';
import { F0_STEEL, std } from './materials.mjs';

// ステージ0の敵機のアクセント色。
const STAGE0_ACCENT = 0x3dc6ff;

// 基本の敵機。アクセント色はプレースホルダ。
export function buildEnemyShip() {
  const accent = 0xff4a3d; // プレースホルダ
  const g = new THREE.Group();

  // 核
  const core = new THREE.Mesh(new THREE.OctahedronGeometry(1.5, 0), std(0x4a4f58));
  core.scale.set(0.8, 0.8, 1.4);
  g.add(core);

  // 核を囲む環
  const ringMat = std(F0_STEEL, { metalness: 1, roughness: 0.5 });
  const ring = new THREE.Mesh(new THREE.TorusGeometry(1.6, 0.18, 4, 8), ringMat);
  g.add(ring);

  // 後方のアクセント色のフィン4枚
  const finMat = std(accent, { roughness: 0.5 });
  finMat.userData = { role: 'accent' };
  for (let i = 0; i < 4; i++) {
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.5, 1.1), finMat);
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    fin.position.set(Math.cos(a) * 1.7, Math.sin(a) * 1.7, -0.9);
    fin.rotation.z = a + Math.PI / 2;
    g.add(fin);
  }

  // 前方のランプ
  const lampMat = new THREE.MeshBasicMaterial({ color: accent });
  lampMat.userData = { role: 'accent' };
  const lamp = new THREE.Mesh(new THREE.OctahedronGeometry(0.45, 0), lampMat);
  lamp.position.z = 1.9;
  g.add(lamp);

  return g;
}

// ステージ0の敵機 A。正二十面体の核から6方向へ配位子が伸び、直交する2本の環が囲む。
export function buildStage0EnemyA() {
  const g = new THREE.Group();

  const core = new THREE.Mesh(new THREE.IcosahedronGeometry(1.2, 0), std(0x4a4f58));
  g.add(core);

  const ligandMat = std(STAGE0_ACCENT, { roughness: 0.4 });
  ligandMat.userData = { role: 'accent' };
  const bondMat = std(F0_STEEL, { metalness: 1, roughness: 0.5 });

  const positions = [
    new THREE.Vector3(2.2, 0, 0),
    new THREE.Vector3(-2.2, 0, 0),
    new THREE.Vector3(0, 2.2, 0),
    new THREE.Vector3(0, -2.2, 0),
    new THREE.Vector3(0, 0, 2.2),
    new THREE.Vector3(0, 0, -2.2),
  ];

  // 配位子と、それを核へ繋ぐ結合
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

  // 直交する2本の環
  const ringMat = std(F0_STEEL, { metalness: 1, roughness: 0.5 });
  const ring1 = new THREE.Mesh(new THREE.TorusGeometry(2.2, 0.1, 4, 12), ringMat);
  ring1.rotation.x = Math.PI / 2;
  g.add(ring1);
  const ring2 = new THREE.Mesh(new THREE.TorusGeometry(2.2, 0.1, 4, 12), ringMat);
  ring2.rotation.y = Math.PI / 2;
  g.add(ring2);

  return g;
}

// ステージ0の敵機 B。円盤の核を環が囲み、環の上に4つのポッドが載る。
export function buildStage0EnemyB() {
  const g = new THREE.Group();

  const core = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.5, 0.6, 8), std(0x4a4f58));
  core.rotation.x = Math.PI / 2;
  g.add(core);

  const ligandMat = std(STAGE0_ACCENT, { roughness: 0.4 });
  ligandMat.userData = { role: 'accent' };

  const ring = new THREE.Mesh(new THREE.TorusGeometry(2.5, 0.2, 8, 16), std(F0_STEEL, { metalness: 1, roughness: 0.5 }));
  g.add(ring);

  // 環の上のポッド
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    const pod = new THREE.Mesh(new THREE.SphereGeometry(0.7, 8, 8), ligandMat);
    pod.position.set(Math.cos(a) * 2.5, Math.sin(a) * 2.5, 0);
    g.add(pod);
  }

  return g;
}

// ステージ0の敵機 C。正四面体の核の各頂点の向きへ棘が伸びる。
export function buildStage0EnemyC() {
  const g = new THREE.Group();

  const core = new THREE.Mesh(new THREE.TetrahedronGeometry(1.8, 0), std(0x4a4f58));
  g.add(core);

  const ligandMat = std(STAGE0_ACCENT, { roughness: 0.4 });
  ligandMat.userData = { role: 'accent' };

  const positions = [
    new THREE.Vector3(1, 1, 1),
    new THREE.Vector3(-1, -1, 1),
    new THREE.Vector3(-1, 1, -1),
    new THREE.Vector3(1, -1, -1),
  ];

  // 外向きの棘
  for (const p of positions) {
    p.normalize().multiplyScalar(2.4);
    const spike = new THREE.Mesh(new THREE.ConeGeometry(0.5, 2.0, 4), ligandMat);
    spike.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), p.clone().normalize());
    spike.position.copy(p);
    g.add(spike);
  }

  return g;
}
