// 破片のモデル。形状ごとに単位サイズで書き出し、個体差は scale と material.color で付ける。
import * as THREE from 'three';
import { std } from './materials.mjs';

// 四面体の塊。
export function buildDebrisChunk() {
  const tetra = new THREE.TetrahedronGeometry(1, 0);
  return new THREE.Mesh(tetra, std(0x3c4149, { roughness: 0.8 }));
}

// 単位立方体。軸ごとの scale で板にする。
export function buildDebrisPanel() {
  const geo = new THREE.BoxGeometry(1, 1, 1);
  return new THREE.Mesh(geo, std(0x3c4149, { roughness: 0.8 }));
}

// 両端の太さが違う、長さ 1 の棒。長手方向はローカル Y。
export function buildDebrisRod() {
  const geo = new THREE.CylinderGeometry(0.1, 0.13, 1, 5);
  return new THREE.Mesh(geo, std(0x3c4149, { roughness: 0.8 }));
}
