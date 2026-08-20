// 設計(形状ツリーと搭載要素の配置)から機体の描画オブジェクトを組み立てる。外皮は1つの
// ジオメトリに結合し、外装の搭載要素だけを取り付け位置に置く — 内装要素は外から見えない。
//
// 生成は形状が変わったときに1度だけ行う。WebGPU の RenderObject は最初の描画でジオメトリを
// 確定するので、形状が変わったときはメッシュごと作り直す(この関数を呼び直す)。
import * as THREE from 'three/webgpu';
import { markLitOpaque } from '../../render/pipeline/lit-layer';
import { buildLoftGeometry } from '../../render/hull/loft-mesh';
import type { PanelSide } from '../../render/hull/part-meshes';
import { buildFitting, buildRadiatorPanel, buildSolarPanel } from '../../render/hull/part-meshes';
import type { AnyPart } from '../game-entity/parts';
import type { VesselAssembly } from './assembly';
import { partVisualRefOf } from './part-visual';
import { FITTINGS } from './part-fittings';
import type { HullLod } from './hull-shape';
import { hullShapeOf } from './hull-shape';
import { circumradius, mountFrame } from './tree';
import type { MountFrame } from './tree';

const HULL_COLOR = 0xb9c1cb;

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
// 機体の左右のどちら側に付いたかで側を決める。同じ側が埋まっていれば反対側へ回し、両側とも
// 埋まっていれば null を返す(3枚目以降は置き場が無い — 積める上限は blueprint-validation.ts が
// 別に絞る)。
class PanelSides {
  private readonly used = new Set<PanelSide>();

  public take(x: number): PanelSide | null {
    const preferred: PanelSide = x >= 0 ? 'up' : 'down';
    const opposite: PanelSide = preferred === 'up' ? 'down' : 'up';
    const side = this.used.has(preferred) ? opposite : preferred;
    if (this.used.has(side)) return null;
    this.used.add(side);
    return side;
  }
}

// 展開する板は、蛇腹の伸縮軸(ローカル X)と放熱面の法線を radiator.ts / power.ts が船体座標系の
// ままで扱う。取り付け位置の姿勢を採ると伸縮軸がトラスの進行方向へ倒れるので、位置だけを採る。
// 置き場が無ければ何も作らない。
function placePanel(part: AnyPart, frame: MountFrame, sides: PanelSides): THREE.Object3D | null {
  const side = sides.take(frame.origin.x);
  if (side === null) return null;
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

// 内装部品は外皮の内側に隠れるが、基地のドック・倉庫・タンクなど作業台で扱う部品は
// 選択対象として位置を示す必要がある。実寸の内部モデルが無い部品は、エッジ中心の
// 半透明ブロックで表現し、確定後の物理・質量計算は既存の PartPlacement を正本にする。
function placeInternalMarker(part: AnyPart, assembly: VesselAssembly): THREE.Object3D | null {
  if (part.type === 'hull' || part.type === 'armor') return null;
  const edgeId = assembly.placements.find((placement) => placement.part.id === part.id)?.kind === 'internal'
    ? (assembly.placements.find((placement) => placement.part.id === part.id) as Extract<typeof assembly.placements[number], { kind: 'internal' }>).edgeIds[0]
    : undefined;
  if (!edgeId) return null;
  const edge = assembly.tree.edges.find((candidate) => candidate.id === edgeId);
  if (!edge) return null;
  const frame = mountFrame(assembly.tree, edge.kind.kind === 'truss'
    ? { kind: 'truss', edgeId, along: edge.length / 2, around: 0 }
    : { kind: 'surface', edgeId, along: edge.length / 2, around: 0 });
  const size = Math.max(0.25, Math.min(2.5, Math.sqrt(Math.max(0.1, part.weight)) * 0.04));
  const color = part.type === 'dock' ? 0xff6a00 : 0x687482;
  const object = new THREE.Mesh(
    new THREE.BoxGeometry(size, size, size),
    new THREE.MeshStandardMaterial({ color, metalness: 0.35, roughness: 0.65, transparent: true, opacity: 0.72 }),
  );
  applyFrame(object, frame);
  object.userData['internalPartMarker'] = true;
  object.userData['ownsGeometry'] = true;
  object.userData['ownsMaterial'] = true;
  return object;
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
  // 左右は種別ごとに数える。放熱板とパドルは別々の蛇腹なので、片方が使った側をもう片方が避ける
  // 必要は無い。
  const sides: Record<'radiator' | 'solar_panel', PanelSides> = {
    radiator: new PanelSides(), solar_panel: new PanelSides(),
  };
  for (const [placementIndex, placement] of assembly.placements.entries()) {
    const visualRef = partVisualRefOf(placement, placementIndex);
    if (placement.kind === 'internal') {
      const marker = placeInternalMarker(placement.part, assembly);
      if (marker) {
        marker.userData['partVisualRef'] = visualRef;
        group.add(marker);
      }
      continue;
    }
    const frame = mountFrame(assembly.tree, placement.mount);
    const part = placement.part;
    if (part.type === 'radiator' || part.type === 'solar_panel') {
      const panel = placePanel(part, frame, sides[part.type]);
      if (panel) {
        panel.userData['partVisualRef'] = visualRef;
        group.add(panel);
      }
      continue;
    }
    const fitting = placeFitting(part, frame, scale);
    if (fitting) {
      fitting.userData['partVisualRef'] = visualRef;
      group.add(fitting);
    }
  }

  markLitOpaque(group);
  return group;
}
