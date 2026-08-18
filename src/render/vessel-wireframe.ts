// 機体のツリーとカプセルの線画。外皮メッシュが未完成の段階で、形状から導いた物理量が意図どおりかを
// 目で確かめるためのもの。機体の renderObject の子として一度だけ組み、以後は機体と一緒に動く。
import * as THREE from 'three/webgpu';
import type { VesselTree } from '../game/vessel/tree';
import { nodeById, circumradius } from '../game/vessel/tree';
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

function edgeLine(from: Vec3, to: Vec3, edgeId: string, kind: string, color: number): THREE.Line {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    from.x, from.y, from.z, to.x, to.y, to.z,
  ], 3));
  const line = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color, linewidth: 2 }));
  line.userData.assemblyEdgeId = edgeId;
  line.userData.edgeKind = kind;
  line.userData.ownsGeometry = true;
  line.userData.ownsMaterial = true;
  return line;
}

// ツリーのエッジを直線で、カプセルを軸と両端の円で描く。
export function buildVesselWireframe(
  tree: VesselTree, capsules: readonly HullCapsule[],
): THREE.Object3D {
  const capsuleVertices: number[] = [];
  for (const capsule of capsules) {
    const axis = norm(sub(capsule.b, capsule.a));
    push(capsuleVertices, capsule.a, capsule.b);
    pushRing(capsuleVertices, capsule.a, axis, capsule.radius);
    pushRing(capsuleVertices, capsule.b, axis, capsule.radius);
  }

  const group = new THREE.Group();
  const topology = new THREE.Group();
  topology.userData.assemblyTopology = true;
  for (const edge of tree.edges) {
    const color = edge.kind.kind === 'decoupler' ? 0xff6a00 : edge.kind.kind === 'truss' ? 0x687482 : TREE_COLOR;
    topology.add(edgeLine(nodeById(tree, edge.a).pos, nodeById(tree, edge.b).pos, edge.id, edge.kind.kind, color));
  }
  for (const node of tree.nodes) {
    const marker = new THREE.Mesh(
      new THREE.SphereGeometry(Math.max(0.04, circumradius(node.section) * 0.06), 8, 4),
      new THREE.MeshBasicMaterial({ color: 0xd8dce2 }),
    );
    marker.position.set(node.pos.x, node.pos.y, node.pos.z);
    marker.userData.assemblyNodeId = node.id;
    marker.userData.ownsGeometry = true;
    marker.userData.ownsMaterial = true;
    topology.add(marker);
  }
  group.add(topology, lines(capsuleVertices, CAPSULE_COLOR));
  return group;
}
