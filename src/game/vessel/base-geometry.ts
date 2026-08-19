// assemblyから導く基地のドック境界と広域衝突半径。Vessel/Three.jsを参照しない純粋な形状導出。
import { add, len, norm, scale, Vec3 } from '../../physics/vec3';
import type { BaseModulePart, DockPort, DockPart } from '../game-entity/parts';
import type { PartPlacement, VesselAssembly } from './assembly';
import { edgeById, mountFrame, type MountFrame } from './tree';
import { deriveCapsules } from './collision-shape';
import { circumradius } from './tree';

// 作業台で変化するassemblyから導いた、基地の格納境界。idは部品idとassembly内の参照位置から
// 決まり、配列の並び順やワールド座標の再計算に依存しない。
export interface DerivedBaseDockPort extends DockPort {
  readonly id: string;
  readonly source: 'base-module' | 'dock-part';
  readonly sourcePartId: string;
  readonly maxVesselSize: number;
}

export interface BaseDockingPorts {
  readonly hatch: DerivedBaseDockPort | null;
  readonly slots: readonly DerivedBaseDockPort[];
  readonly captureRelSpeed: number;
  readonly hatchCaptureDist: number;
  readonly hatchCaptureAlignment: number;
  readonly slotCaptureDist: number;
  readonly slotCaptureAlignment: number;
}

const DEFAULT_DOCK_CAPTURE_DIST = 50;
const DEFAULT_DOCK_CAPTURE_ALIGNMENT = 0.5;
const DEFAULT_DOCK_CAPTURE_REL_SPEED = 20;

interface DockAnchor {
  readonly key: string;
  readonly frame: MountFrame;
  readonly length: number;
}

function safeCapacity(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function stablePort(
  id: string,
  source: DerivedBaseDockPort['source'],
  sourcePartId: string,
  localPos: Vec3,
  localNormal: Vec3,
  maxVesselSize = Infinity,
): DerivedBaseDockPort {
  return {
    id,
    source,
    sourcePartId,
    localPos,
    // Custom saves may contain a non-unit normal. Normalize at the pure boundary so every consumer
    // gets the same alignment result and attach rotation.
    localNormal: norm(localNormal),
    maxVesselSize,
  };
}

function anchorsForDockPlacement(assembly: VesselAssembly, placement: PartPlacement): readonly DockAnchor[] {
  if (placement.kind === 'external') {
    const frame = mountFrame(assembly.tree, placement.mount);
    return [{ key: placement.mount.kind === 'port'
      ? `port:${placement.mount.nodeId}`
      : `${placement.mount.kind}:${placement.mount.edgeId}`,
    frame, length: 0 }];
  }

  const anchors: DockAnchor[] = [];
  for (const edgeId of placement.edgeIds) {
    const edge = edgeById(assembly.tree, edgeId);
    const along = edge.length / 2;
    const frame = mountFrame(assembly.tree, edge.kind.kind === 'truss'
      ? { kind: 'truss', edgeId, along, around: 0 }
      : { kind: 'surface', edgeId, along, around: 0 });
    anchors.push({ key: edgeId, frame, length: edge.length });
  }
  return anchors;
}

function dockPartPorts(assembly: VesselAssembly, placement: PartPlacement & { readonly part: DockPart }): readonly DerivedBaseDockPort[] {
  const anchors = anchorsForDockPlacement(assembly, placement);
  const capacity = safeCapacity(placement.part.capacity);
  if (anchors.length === 0 || capacity === 0) return [];

  // ポート配置は index % anchors.length のラウンドロビンなので、各アンカーの本数も
  // そのとおりに(余りを先頭のアンカーへ1つずつ)割り振る。
  const perAnchor = anchors.map((_anchor, index) =>
    Math.floor(capacity / anchors.length) + (index < capacity % anchors.length ? 1 : 0));
  const used = anchors.map(() => 0);
  const ports: DerivedBaseDockPort[] = [];
  for (let i = 0; i < capacity; i++) {
    const anchorIndex = i % anchors.length;
    const anchor = anchors[anchorIndex]!;
    const localIndex = used[anchorIndex]!++;
    const count = perAnchor[anchorIndex]!;
    const along = anchor.length > 0 ? anchor.length * (localIndex + 1) / (count + 1) : 0;
    const at = anchor.length > 0
      ? add(anchor.frame.origin, scale(anchor.frame.y, along - anchor.length / 2))
      : anchor.frame.origin;
    ports.push(stablePort(
      `dock:${placement.part.id}:${anchor.key}:${localIndex}`,
      'dock-part', placement.part.id, at, anchor.frame.z, placement.part.maxVesselSize,
    ));
  }
  return ports;
}

function baseModulePorts(module: BaseModulePart): {
  readonly hatch: DerivedBaseDockPort;
  readonly slots: readonly DerivedBaseDockPort[];
} {
  const prefix = `base-module:${module.id}`;
  return {
    hatch: stablePort(`${prefix}:hatch`, 'base-module', module.id, module.hatch.localPos, module.hatch.localNormal),
    slots: module.dockSlots
      .slice(0, safeCapacity(module.capacity))
      .map((port, index) => stablePort(
        `${prefix}:slot:${index}`, 'base-module', module.id, port.localPos, port.localNormal,
      )),
  };
}

// assemblyから基地のハッチ・スロットを導出する純粋関数。base_moduleにslotが記録されている
// 既存設計はそのまま優先し、slotが空のカスタム設計ではdock部品のedge配置を格納口へ変換する。
export function deriveBaseDockingPorts(
  assembly: VesselAssembly | null,
  module: BaseModulePart | null,
): BaseDockingPorts {
  const modulePorts = module ? baseModulePorts(module) : null;
  const dockPorts = assembly
    ? assembly.placements
      .filter((placement): placement is PartPlacement & { readonly part: DockPart } =>
        placement.part.type === 'dock' && placement.part.hp > 0)
      .flatMap((placement) => dockPartPorts(assembly, placement))
    : [];
  const slots = modulePorts && modulePorts.slots.length > 0
    ? modulePorts.slots
    : dockPorts;
  return {
    hatch: modulePorts?.hatch ?? null,
    slots,
    captureRelSpeed: module?.captureRelSpeed ?? DEFAULT_DOCK_CAPTURE_REL_SPEED,
    hatchCaptureDist: module?.hatchCaptureDist ?? DEFAULT_DOCK_CAPTURE_DIST,
    hatchCaptureAlignment: module?.hatchCaptureAlignment ?? DEFAULT_DOCK_CAPTURE_ALIGNMENT,
    slotCaptureDist: module?.slotCaptureDist ?? DEFAULT_DOCK_CAPTURE_DIST,
    slotCaptureAlignment: module?.slotCaptureAlignment ?? DEFAULT_DOCK_CAPTURE_ALIGNMENT,
  };
}

// カスタム基地の広域衝突半径。ノード断面とエッジのカプセルを含め、assemblyの外側を必ず覆う。
export function baseAssemblyCollisionRadius(assembly: VesselAssembly): number {
  let radius = 0;
  for (const node of assembly.tree.nodes) radius = Math.max(radius, len(node.pos) + circumradius(node.section));
  for (const capsule of deriveCapsules(assembly.tree)) {
    radius = Math.max(radius, len(capsule.a) + capsule.radius, len(capsule.b) + capsule.radius);
  }
  return Math.max(radius, 1);
}
