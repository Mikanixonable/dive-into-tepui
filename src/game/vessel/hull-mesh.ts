// 設計(形状ツリーと搭載要素の配置)から機体の描画オブジェクトを組み立てる。外皮は1つの
// ジオメトリに結合し、外装の搭載要素だけを取り付け位置に置く — 内装要素は外から見えない。
//
// 生成は形状が変わったときに1度だけ行う。WebGPU の RenderObject は最初の描画でジオメトリを
// 確定するので、形状が変わったときはメッシュごと作り直す(この関数を呼び直す)。
import * as THREE from 'three/webgpu';
import { markLitOpaque } from '../../render/pipeline/lit-layer';
import { buildLoftGeometry } from '../../render/hull/loft-mesh';
import type { FittingShape, PanelSide } from '../../render/hull/part-meshes';
import { buildFitting, buildRadiatorPanel, buildSolarPanel } from '../../render/hull/part-meshes';
import type { AnyPart, PartType } from '../game-entity/parts';
import type { VesselAssembly } from './assembly';
import type { HullLod } from './hull-shape';
import { hullShapeOf } from './hull-shape';
import { circumradius, mountFrame } from './tree';
import type { MountFrame } from './tree';

const HULL_COLOR = 0xb9c1cb;

// 外装要素の造形と、機体の代表寸法に対する大きさの比。ここに無い種別は外に出ない。
const FITTINGS: Partial<Record<PartType, { readonly shape: FittingShape; readonly ratio: number }>> = {
  engine: { shape: 'nozzle', ratio: 1.1 },
  weapon: { shape: 'barrel', ratio: 1.0 },
  rcs_thruster: { shape: 'thruster', ratio: 0.24 },
  communication: { shape: 'dish', ratio: 0.3 },
  heat_shield: { shape: 'shield', ratio: 0.7 },
  robot_arm: { shape: 'block', ratio: 0.4 },
  docking_port: { shape: 'block', ratio: 0.5 },
  container_coupling: { shape: 'block', ratio: 0.4 },
  combat_shield: { shape: 'block', ratio: 0.8 },
};

// 機体の代表寸法 [m]。搭載要素の造形の大きさを、機体の大小に合わせるために使う。
function hullScale(assembly: VesselAssembly): number {
  let maximum = 0;
  for (const node of assembly.tree.nodes) maximum = Math.max(maximum, circumradius(node.section));
  return maximum > 0 ? maximum : 1;
}

function applyFrame(object: THREE.Object3D, frame: MountFrame): void {
  object.position.set(frame.origin.x, frame.origin.y, frame.origin.z);
  const basis = new THREE.Matrix4().makeBasis(
    new THREE.Vector3(frame.x.x, frame.x.y, frame.x.z),
    new THREE.Vector3(frame.y.x, frame.y.y, frame.y.z),
    new THREE.Vector3(frame.z.x, frame.z.y, frame.z.z),
  );
  object.quaternion.setFromRotationMatrix(basis);
}

// 展開する板(放熱板・太陽電池パドル)の左右。蛇腹は自分のローカル +X/-X へ伸びるので、
// 機体の左右のどちら側に付いたかで側を決める。同じ側が埋まっていれば反対側へ回す。
class PanelSides {
  private readonly used = new Set<PanelSide>();

  public take(x: number): PanelSide {
    const preferred: PanelSide = x >= 0 ? 'up' : 'down';
    const side = this.used.has(preferred) ? (preferred === 'up' ? 'down' : 'up') : preferred;
    this.used.add(side);
    return side;
  }
}

// 展開する板は、蛇腹の伸縮軸(ローカル X)と放熱面の法線を radiator.ts / power.ts が船体座標系の
// ままで扱う。取り付け位置の姿勢を採ると伸縮軸がトラスの進行方向へ倒れるので、位置だけを採る。
function placePanel(part: AnyPart, frame: MountFrame, sides: PanelSides): THREE.Object3D {
  const side = sides.take(frame.origin.x);
  const panel = part.type === 'radiator' ? buildRadiatorPanel(side) : buildSolarPanel(side);
  panel.position.set(frame.origin.x, frame.origin.y, frame.origin.z);
  return panel;
}

function placeFitting(part: AnyPart, frame: MountFrame, scale: number): THREE.Object3D | null {
  const fitting = FITTINGS[part.type];
  if (!fitting) return null;
  const size = part.type === 'engine' ? part.length : fitting.ratio * scale;
  const mesh = buildFitting(fitting.shape, size);
  const holder = new THREE.Group();
  applyFrame(holder, frame);
  holder.add(mesh);
  return holder;
}

export function buildHullMesh(assembly: VesselAssembly, lod: HullLod = 'near'): THREE.Group {
  const group = new THREE.Group();

  const geometry = buildLoftGeometry(hullShapeOf(assembly.tree, lod));
  const skin = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
    color: HULL_COLOR, metalness: 0.45, roughness: 0.55, side: THREE.DoubleSide,
  }));
  skin.userData['ownsGeometry'] = true;
  skin.userData['ownsMaterial'] = true;
  group.add(skin);

  const scale = hullScale(assembly);
  const sides = new PanelSides();
  for (const placement of assembly.placements) {
    if (placement.kind !== 'external') continue;
    const frame = mountFrame(assembly.tree, placement.mount);
    const part = placement.part;
    if (part.type === 'radiator' || part.type === 'solar_panel') {
      group.add(placePanel(part, frame, sides));
      continue;
    }
    const fitting = placeFitting(part, frame, scale);
    if (fitting) group.add(fitting);
  }

  markLitOpaque(group);
  return group;
}
