// 破片のモデル。
// 形状ごとに固定サイズ(size=1)で書き出し、実行時に scale と material.color で個体差を付ける。
import * as THREE from 'three';
import { std } from './materials.mjs';

export function buildDebrisChunk() {
  const tetra = new THREE.TetrahedronGeometry(1, 0);
  return new THREE.Mesh(tetra, std(0x3c4149, { roughness: 0.8 }));
}

export function buildDebrisPanel() {
  const geo = new THREE.BoxGeometry(1, 1, 1);
  return new THREE.Mesh(geo, std(0x3c4149, { roughness: 0.8 }));
}

export function buildDebrisRod() {
  const geo = new THREE.CylinderGeometry(0.1, 0.13, 1, 5);
  return new THREE.Mesh(geo, std(0x3c4149, { roughness: 0.8 }));
}
