// マガジン列の背面ケーブルと、隣り合う箱を結ぶ首振り継手を同期する。
import * as THREE from 'three/webgpu';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { markLitOpaque, markShadowCaster } from '../../pipeline/lit-layer';
import { markSharedResources } from '../baked-model';
import { MAG_PLANAR_SCALE } from '../../../physics/player-shape';
import type { BeltNodes } from './belt-view';

const CABLE_MATERIAL = new THREE.MeshStandardMaterial({ color: 0x24282c, roughness: 0.72 });
const BELLOWS_MATERIAL = new THREE.MeshStandardMaterial({ color: 0x1d2226, roughness: 0.82 });
const BELLOWS_RIB_MATERIAL = new THREE.MeshStandardMaterial({ color: 0x343a40, metalness: 0.24, roughness: 0.78 });
const PIN_MATERIAL = new THREE.MeshStandardMaterial({ color: 0xa5abb1, metalness: 1, roughness: 0.38 });
const COLLAR_MATERIAL = new THREE.MeshStandardMaterial({ color: 0x737b82, metalness: 1, roughness: 0.5 });
const RIDGE_MATERIAL = new THREE.MeshStandardMaterial({ color: 0x737b82, metalness: 1, roughness: 0.44 });
const MOUNT_MATERIAL = new THREE.MeshStandardMaterial({ color: 0x777f87, metalness: 1, roughness: 0.46 });
const CLAMP_MATERIAL = new THREE.MeshStandardMaterial({ color: 0xaab0b5, metalness: 1, roughness: 0.48 });

const CABLE_GEOMETRY = new THREE.TubeGeometry(new THREE.CatmullRomCurve3([
  new THREE.Vector3(-1.17, 1.14, -0.46),
  new THREE.Vector3(-0.60, 1.17, -0.46),
  new THREE.Vector3(0, 1.14, -0.46),
  new THREE.Vector3(0.60, 1.17, -0.46),
  new THREE.Vector3(1.17, 1.14, -0.46),
]), 18, 0.105, 10, false);
const FLEX_CABLE_CURVE = new THREE.CatmullRomCurve3([
  new THREE.Vector3(-0.36, 1.14, -0.46),
  new THREE.Vector3(-0.28, 1.14, -0.46),
  new THREE.Vector3(-0.17, 1.28, -0.50),
  new THREE.Vector3(-0.08, 1.39, -0.53),
  new THREE.Vector3(0, 1.44, -0.54),
  new THREE.Vector3(0.08, 1.39, -0.53),
  new THREE.Vector3(0.17, 1.28, -0.50),
  new THREE.Vector3(0.28, 1.14, -0.46),
  new THREE.Vector3(0.36, 1.14, -0.46),
]);
const FLEX_CABLE_GEOMETRY = new THREE.TubeGeometry(FLEX_CABLE_CURVE, 24, 0.105, 10, false);
const CLAMP_GEOMETRY = new RoundedBoxGeometry(0.18, 0.26, 0.32, 0.045, 1);
const BELLOWS_RING_GEOMETRY = new THREE.TorusGeometry(0.12, 0.022, 8, 16);
const GIMBAL_BLOCK_GEOMETRY = new RoundedBoxGeometry(0.34, 0.30, 0.30, 0.05, 1);
const YAW_RIDGE_GEOMETRY = new RoundedBoxGeometry(0.50, 0.20, 0.34, 0.045, 1);
const PITCH_RIDGE_GEOMETRY = new RoundedBoxGeometry(0.24, 0.44, 0.20, 0.04, 1);
const YAW_ROD_GEOMETRY = new THREE.CylinderGeometry(0.105, 0.105, 0.86, 14);
const PITCH_ROD_GEOMETRY = new THREE.CylinderGeometry(0.09, 0.09, 0.38, 14);
const ROD_COLLAR_GEOMETRY = new THREE.CylinderGeometry(0.18, 0.18, 0.12, 12);
const PIN_HEAD_GEOMETRY = new THREE.CylinderGeometry(0.17, 0.17, 0.12, 12);

// 角を落とした板金輪郭を、奥行きのある左右非対称な継手プレートへ押し出す。
function mountPlateGeometry(points: readonly [number, number][]): THREE.ExtrudeGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(points[0]![0], points[0]![1]);
  for (const [x, y] of points.slice(1)) shape.lineTo(x, y);
  shape.closePath();
  return new THREE.ExtrudeGeometry(shape, {
    depth: 0.36,
    bevelEnabled: true,
    bevelSegments: 2,
    bevelThickness: 0.045,
    bevelSize: 0.035,
    steps: 1,
  });
}

const TRAILING_RECEIVER_GEOMETRY = mountPlateGeometry([
  [-0.08, 0.10], [-0.30, -0.18], [-0.47, -0.14], [-0.55, -0.02],
  [-0.55, 0.18], [-0.47, 0.36], [-0.31, 0.33], [-0.08, 0.21], [-0.14, 0.15],
]);
const LEADING_TANG_GEOMETRY = mountPlateGeometry([
  [0.08, 0.12], [0.35, -0.18], [0.52, -0.14], [0.60, -0.02],
  [0.60, 0.17], [0.52, 0.35], [0.35, 0.32], [0.08, 0.20],
]);

// ベルトの各リンクへ載せる、外装クランプ付きの伝送ケーブルを作る。
function cableRun(): THREE.Group {
  const group = new THREE.Group();
  group.scale.set(MAG_PLANAR_SCALE, 1, MAG_PLANAR_SCALE);
  group.add(new THREE.Mesh(CABLE_GEOMETRY, CABLE_MATERIAL));
  for (const x of [-1.12, 1.12]) {
    const clamp = new THREE.Mesh(CLAMP_GEOMETRY, CLAMP_MATERIAL);
    clamp.position.set(x, 1.12, -0.46);
    group.add(clamp);
  }
  markBeltHardware(group);
  return group;
}

// 直交するピン軸、二段リッジ、前後非対称の板金タングで隣接箱を結ぶ。
function swivelJoint(): THREE.Group {
  const group = new THREE.Group();
  group.scale.set(MAG_PLANAR_SCALE, 1, MAG_PLANAR_SCALE);
  const bellows = new THREE.Mesh(FLEX_CABLE_GEOMETRY, BELLOWS_MATERIAL);
  group.add(bellows);
  for (const t of [0.06, 0.12, 0.18, 0.82, 0.88, 0.94]) {
    const ring = new THREE.Mesh(BELLOWS_RING_GEOMETRY, BELLOWS_RIB_MATERIAL);
    ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), FLEX_CABLE_CURVE.getTangentAt(t));
    ring.position.copy(FLEX_CABLE_CURVE.getPointAt(t));
    group.add(ring);
  }

  // -X 側の受け金と +X 側の先細りタングで、ベルトの進行方向を形状に持たせる。
  for (const z of [-1.18, 0.72]) {
    const receiver = new THREE.Mesh(TRAILING_RECEIVER_GEOMETRY, MOUNT_MATERIAL);
    receiver.position.z = z;
    group.add(receiver);
    const tang = new THREE.Mesh(LEADING_TANG_GEOMETRY, MOUNT_MATERIAL);
    tang.position.z = z;
    group.add(tang);
  }

  // 二つの横リッジを縦ロッドが貫き、左右旋回側の軸受を作る。
  for (const y of [0.14, 0.58]) {
    const ridge = new THREE.Mesh(YAW_RIDGE_GEOMETRY, RIDGE_MATERIAL);
    ridge.position.set(0.30, y, 1.17);
    group.add(ridge);
  }
  const yawRod = new THREE.Mesh(YAW_ROD_GEOMETRY, PIN_MATERIAL);
  yawRod.position.set(0.30, 0.36, 1.17);
  group.add(yawRod);
  for (const y of [0.01, 0.71]) {
    const collar = new THREE.Mesh(ROD_COLLAR_GEOMETRY, COLLAR_MATERIAL);
    collar.position.set(0.30, y, 1.17);
    group.add(collar);
  }

  // 前後の二枚耳と横ロッドで上下首振り軸を作り、交差部を中間ブロックで受ける。
  for (const z of [1.16, 1.39]) {
    const ridge = new THREE.Mesh(PITCH_RIDGE_GEOMETRY, RIDGE_MATERIAL);
    ridge.position.set(-0.30, 0.36, z);
    group.add(ridge);
  }
  const pitchRod = new THREE.Mesh(PITCH_ROD_GEOMETRY, PIN_MATERIAL);
  pitchRod.rotation.x = Math.PI / 2;
  pitchRod.position.set(-0.30, 0.36, 1.275);
  group.add(pitchRod);
  const pitchHead = new THREE.Mesh(PIN_HEAD_GEOMETRY, COLLAR_MATERIAL);
  pitchHead.rotation.x = Math.PI / 2;
  pitchHead.position.set(-0.30, 0.36, 1.50);
  group.add(pitchHead);
  const gimbal = new THREE.Mesh(GIMBAL_BLOCK_GEOMETRY, RIDGE_MATERIAL);
  gimbal.position.set(0, 0.36, 0.73);
  group.add(gimbal);
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
