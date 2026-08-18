// 機体のツリーとカプセルの線画。外皮メッシュが未完成の段階で、形状から導いた物理量が意図どおりかを
// 目で確かめるためのもの。機体の renderObject の子として一度だけ組み、以後は機体と一緒に動く。
import * as THREE from 'three/webgpu';
import type { VesselTree } from '../game/vessel/tree';
import { nodeById } from '../game/vessel/tree';
import type { HullCapsule } from '../game/vessel/collision-shape';
import { Vec3, add, cross, norm, scale, sub, v3 } from '../physics/vec3';

const TREE_COLOR = 0x40c0ff;
const CAPSULE_COLOR = 0xffa040;
const RING_SEGMENTS = 16;

function push(into: number[], from: Vec3, to: Vec3): void {
  into.push(from.x, from.y, from.z, to.x, to.y, to.z);
}

// 中心 center・法線 axis・半径 radius の円を線分列として足す。
function pushRing(into: number[], center: Vec3, axis: Vec3, radius: number): void {
  const reference = Math.abs(axis.y) > 0.99 ? v3(0, 0, 1) : v3(0, 1, 0);
  const x = norm(cross(reference, axis));
  const y = cross(axis, x);
  const at = (angle: number): Vec3 => add(
    center, add(scale(x, radius * Math.cos(angle)), scale(y, radius * Math.sin(angle))));
  for (let i = 0; i < RING_SEGMENTS; i++) {
    push(into, at((i / RING_SEGMENTS) * 2 * Math.PI), at(((i + 1) / RING_SEGMENTS) * 2 * Math.PI));
  }
}

function lines(vertices: readonly number[], color: number): THREE.LineSegments {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(Array.from(vertices), 3));
  const mesh = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color }));
  mesh.userData.ownsGeometry = true;
  mesh.userData.ownsMaterial = true;
  return mesh;
}

// ツリーのエッジを直線で、カプセルを軸と両端の円で描く。
export function buildVesselWireframe(
  tree: VesselTree, capsules: readonly HullCapsule[],
): THREE.Object3D {
  const treeVertices: number[] = [];
  for (const edge of tree.edges) push(treeVertices, nodeById(tree, edge.a).pos, nodeById(tree, edge.b).pos);

  const capsuleVertices: number[] = [];
  for (const capsule of capsules) {
    const axis = norm(sub(capsule.b, capsule.a));
    push(capsuleVertices, capsule.a, capsule.b);
    pushRing(capsuleVertices, capsule.a, axis, capsule.radius);
    pushRing(capsuleVertices, capsule.b, axis, capsule.radius);
  }

  const group = new THREE.Group();
  group.add(lines(treeVertices, TREE_COLOR), lines(capsuleVertices, CAPSULE_COLOR));
  return group;
}
