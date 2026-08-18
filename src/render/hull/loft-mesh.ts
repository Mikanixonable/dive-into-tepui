// 外皮の三角形分割を BufferGeometry へ詰め替える。分割そのものは hull-triangles.ts にあり、
// このファイルは THREE 側の器だけを持つ。
import * as THREE from 'three/webgpu';
import type { HullShape } from './hull-triangles';
import { buildHullTriangles } from './hull-triangles';

export function buildLoftGeometry(shape: HullShape): THREE.BufferGeometry {
  const { positions, indices } = buildHullTriangles(shape);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}
