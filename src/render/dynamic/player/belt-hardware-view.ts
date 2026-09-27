// マガジン列の背面ケーブルと、隣り合う箱を結ぶ首振り継手を同期する。
import * as THREE from 'three/webgpu';
import { markLitOpaque, markShadowCaster } from '../../pipeline/lit-layer';
import { markSharedResources } from '../baked-model';
import type { BeltNodes } from './belt-view';

const CABLE_MATERIAL = new THREE.MeshStandardMaterial({ color: 0x171c20, roughness: 0.88 });
const BELLOWS_MATERIAL = new THREE.MeshStandardMaterial({ color: 0x101417, roughness: 0.94 });
const JOINT_MATERIAL = new THREE.MeshStandardMaterial({ color: 0x9ba2a8, metalness: 1, roughness: 0.4 });
const COLLAR_MATERIAL = new THREE.MeshStandardMaterial({ color: 0x737b82, metalness: 1, roughness: 0.5 });
const YOKE_MATERIAL = new THREE.MeshStandardMaterial({ color: 0x68747d, roughness: 0.58 });
const CLAMP_MATERIAL = new THREE.MeshStandardMaterial({ color: 0xaab0b5, metalness: 1, roughness: 0.48 });

const CABLE_GEOMETRY = new THREE.TubeGeometry(new THREE.CatmullRomCurve3([
  new THREE.Vector3(-1.17, 1.14, -0.46),
  new THREE.Vector3(-0.60, 1.17, -0.46),
  new THREE.Vector3(0, 1.14, -0.46),
  new THREE.Vector3(0.60, 1.17, -0.46),
  new THREE.Vector3(1.17, 1.14, -0.46),
]), 18, 0.065, 8, false);
const FLEX_CABLE_GEOMETRY = new THREE.TubeGeometry(new THREE.CatmullRomCurve3([
  new THREE.Vector3(-0.29, 1.14, -0.46),
  new THREE.Vector3(-0.15, 1.07, -0.52),
  new THREE.Vector3(0, 1.05, -0.54),
  new THREE.Vector3(0.15, 1.07, -0.52),
  new THREE.Vector3(0.29, 1.14, -0.46),
]), 16, 0.064, 8, false);
const CLAMP_GEOMETRY = new THREE.BoxGeometry(0.12, 0.17, 0.18);
const BELLOWS_RING_GEOMETRY = new THREE.TorusGeometry(0.10, 0.022, 6, 12);
const SWIVEL_BALL_GEOMETRY = new THREE.SphereGeometry(0.23, 14, 10);
const SWIVEL_RING_GEOMETRY = new THREE.TorusGeometry(0.215, 0.032, 8, 16);
const SWIVEL_PIN_GEOMETRY = new THREE.CylinderGeometry(0.075, 0.075, 0.52, 10);
const SWIVEL_COLLAR_GEOMETRY = new THREE.CylinderGeometry(0.145, 0.145, 0.11, 12);
const YOKE_GEOMETRY = new THREE.BoxGeometry(0.16, 0.46, 0.23);
const YOKE_RAIL_GEOMETRY = new THREE.BoxGeometry(0.20, 0.085, 0.23);

// ベルトの各リンクへ載せる、外装クランプ付きの伝送ケーブルを作る。
function cableRun(): THREE.Group {
  const group = new THREE.Group();
  group.add(new THREE.Mesh(CABLE_GEOMETRY, CABLE_MATERIAL));
  for (const x of [-1.12, 1.12]) {
    const clamp = new THREE.Mesh(CLAMP_GEOMETRY, CLAMP_MATERIAL);
    clamp.position.set(x, 1.12, -0.46);
    group.add(clamp);
  }
  markBeltHardware(group);
  return group;
}

// 球面軸受と蛇腹状ケーブル継手を組み、隣接する箱の端部金具を加える。
function swivelJoint(): THREE.Group {
  const group = new THREE.Group();
  const bellows = new THREE.Mesh(FLEX_CABLE_GEOMETRY, BELLOWS_MATERIAL);
  group.add(bellows);
  for (const x of [-0.20, -0.10, 0, 0.10, 0.20]) {
    const ring = new THREE.Mesh(BELLOWS_RING_GEOMETRY, COLLAR_MATERIAL);
    ring.rotation.y = Math.PI / 2;
    ring.position.set(x, 1.14, -0.46);
    group.add(ring);
  }

  // 球面部は箱の前端へ少し張り出し、箱の間隔が狭くても回転部を読める。
  const ball = new THREE.Mesh(SWIVEL_BALL_GEOMETRY, JOINT_MATERIAL);
  ball.position.set(0, 0.72, 1.08);
  group.add(ball);
  const pivotRing = new THREE.Mesh(SWIVEL_RING_GEOMETRY, YOKE_MATERIAL);
  pivotRing.rotation.y = Math.PI / 2;
  pivotRing.position.set(0, 0.72, 1.08);
  group.add(pivotRing);
  const pin = new THREE.Mesh(SWIVEL_PIN_GEOMETRY, COLLAR_MATERIAL);
  pin.rotation.z = Math.PI / 2;
  pin.position.set(0, 0.72, 1.08);
  group.add(pin);
  for (const x of [-0.31, 0.31]) {
    const collar = new THREE.Mesh(SWIVEL_COLLAR_GEOMETRY, COLLAR_MATERIAL);
    collar.rotation.z = Math.PI / 2;
    collar.position.set(x, 0.72, 1.08);
    group.add(collar);

    const yoke = new THREE.Mesh(YOKE_GEOMETRY, YOKE_MATERIAL);
    yoke.position.set(x, 0.72, 1.08);
    group.add(yoke);
    for (const y of [0.52, 0.92]) {
      const rail = new THREE.Mesh(YOKE_RAIL_GEOMETRY, YOKE_MATERIAL);
      rail.position.set(x, y, 1.08);
      group.add(rail);
    }
  }
  markBeltHardware(group);
  return group;
}

// 標準材質を照明・影の経路へ載せ、全個体で共有する GPU 資源として印す。
function markBeltHardware(root: THREE.Object3D): void {
  markLitOpaque(root);
  markShadowCaster(root);
  markSharedResources(root);
}

// リンクごとのケーブルと節点ごとの首振り継手を、既存のマガジン姿勢に合わせる。
export class BeltHardwareView {
  private readonly cableRuns: THREE.Group[] = [];
  private readonly joints: THREE.Group[] = [];

  // root の子としてリンク数ぶんのケーブルと、隣接リンク数ぶんの継手を組む。
  public constructor(root: THREE.Object3D, linkCount: number) {
    for (let i = 0; i < linkCount; i++) {
      const run = cableRun();
      root.add(run);
      this.cableRuns.push(run);
    }
    for (let i = 0; i < Math.max(0, linkCount - 1); i++) {
      const joint = swivelJoint();
      root.add(joint);
      this.joints.push(joint);
    }
  }

  // 表示中の箱だけへケーブルと継手を合わせ、消費済みリンクの金具を隠す。
  public sync(magsLeft: number, nodes: BeltNodes, links: readonly THREE.Group[]): void {
    const visibleCount = Math.min(magsLeft, links.length);
    for (let i = 0; i < this.cableRuns.length; i++) {
      const cable = this.cableRuns[i]!;
      const link = links[i]!;
      cable.visible = link.visible;
      cable.position.copy(link.position);
      cable.quaternion.copy(link.quaternion);
    }
    for (let i = 0; i < this.joints.length; i++) {
      const joint = this.joints[i]!;
      const before = links[i]!;
      const after = links[i + 1]!;
      const position = nodes.positions[i]!;
      joint.visible = i + 1 < visibleCount;
      joint.position.set(position.x, position.y, position.z);
      joint.quaternion.copy(before.quaternion).slerp(after.quaternion, 0.5);
    }
  }
}
