// 金属の敵機のモデル。アクセント色を差し替える材質には userData.role = 'accent' を付ける。
import * as THREE from 'three';
import { F0_STEEL, std } from './materials.mjs';

// 敵機: 基本(未着色)版を書き出す。アクセントカラーは実行時にマテリアルをクローンして差し替える。
export function buildEnemyShip() {
  const accent = 0xff4a3d; // プレースホルダ(実行時に上書きされる)
  const g = new THREE.Group();

  const core = new THREE.Mesh(new THREE.OctahedronGeometry(1.5, 0), std(0x4a4f58));
  core.scale.set(0.8, 0.8, 1.4);
  g.add(core);

  const ringMat = std(F0_STEEL, { metalness: 1, roughness: 0.5 });
  const ring = new THREE.Mesh(new THREE.TorusGeometry(1.6, 0.18, 4, 8), ringMat);
  g.add(ring);

  const finMat = std(accent, { roughness: 0.5 });
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

// ------------------------------------------------------------- ステージ0 敵機

export function buildStage0EnemyA() {
  const accent = 0x3dc6ff;
  const g = new THREE.Group();

  const core = new THREE.Mesh(new THREE.IcosahedronGeometry(1.2, 0), std(0x4a4f58));
  g.add(core);

  const ligandMat = std(accent, { roughness: 0.4 });
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

  const ringMat = std(F0_STEEL, { metalness: 1, roughness: 0.5 });
  const ring1 = new THREE.Mesh(new THREE.TorusGeometry(2.2, 0.1, 4, 12), ringMat);
  ring1.rotation.x = Math.PI / 2;
  g.add(ring1);
  const ring2 = new THREE.Mesh(new THREE.TorusGeometry(2.2, 0.1, 4, 12), ringMat);
  ring2.rotation.y = Math.PI / 2;
  g.add(ring2);

  return g;
}

export function buildStage0EnemyB() {
  const accent = 0x3dc6ff;
  const g = new THREE.Group();

  const core = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.5, 0.6, 8), std(0x4a4f58));
  core.rotation.x = Math.PI / 2;
  g.add(core);

  const ligandMat = std(accent, { roughness: 0.4 });
  ligandMat.userData = { role: 'accent' };

  const ring = new THREE.Mesh(new THREE.TorusGeometry(2.5, 0.2, 8, 16), std(F0_STEEL, { metalness: 1, roughness: 0.5 }));
  g.add(ring);

  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    const pod = new THREE.Mesh(new THREE.SphereGeometry(0.7, 8, 8), ligandMat);
    pod.position.set(Math.cos(a) * 2.5, Math.sin(a) * 2.5, 0);
    g.add(pod);
  }

  return g;
}

export function buildStage0EnemyC() {
  const accent = 0x3dc6ff;
  const g = new THREE.Group();

  const core = new THREE.Mesh(new THREE.TetrahedronGeometry(1.8, 0), std(0x4a4f58));
  g.add(core);

  const ligandMat = std(accent, { roughness: 0.4 });
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
