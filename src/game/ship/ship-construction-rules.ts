// 建造の接続候補と、選択した部品をその候補へ置けるかを判定する純粋な規則。
import { LOCAL_UP, Q_IDENTITY, qFromAxisAngle } from '../../math/quat';
import { v3, type Vec3 } from '../../math/vec3';
import type { ShipAssembly, ModuleTransform } from './ship-assembly';
import { sideMountTransform } from './ship-assembly-transform';
import type { SideSlot } from './ship-assembly-types';
import type { ShipModuleDefinition } from './ship-module-definition';
import type { ConstructionMount, ConstructionSlotKind, ConstructionSlotState } from './ship-construction-types';

const SIDE_DIRECTIONS: Readonly<Record<Exclude<ConstructionMount, 'axial'>, Vec3>> = {
  'side+x': v3(1, 0, 0),
  'side-x': v3(-1, 0, 0),
  'side+y': v3(0, 1, 0),
  'side-y': v3(0, -1, 0),
};

const SIDE_MOUNTS: readonly Exclude<ConstructionMount, 'axial'>[] = [
  'side+x', 'side-x', 'side+y', 'side-y',
];

const SIDE_KINDS = new Set(['dock', 'docking_port', 'solar_panel', 'radiator']);

function toSideSlot(mount: Exclude<ConstructionMount, 'axial'>): SideSlot {
  return `side:${mount.slice(4)}` as SideSlot;
}

export interface ConstructionSlot {
  readonly id: string;
  readonly parentId: string;
  readonly mount: ConstructionMount;
  readonly kind: ConstructionSlotKind;
  readonly label: string;
  readonly direction: Vec3;
}

export interface ConstructionPlacement {
  readonly valid: boolean;
  readonly reason: string | null;
  readonly parentId: string;
  readonly transform: ModuleTransform;
  readonly kind: ConstructionSlotKind;
}

// axial は親 id に依存しない安定した選択キー、side は親と方向の組み合わせにする。
export function constructionSlotId(parentId: string, mount: ConstructionMount): string {
  return mount === 'axial' ? 'axial' : `${parentId}:${mount}`;
}

// HUDの候補一覧に出す短い接続先ラベルを組む。
export function constructionSlotLabel(parentId: string, mount: ConstructionMount): string {
  if (mount === 'axial') return '軸方向 / 末尾';
  const direction = mount.slice('side'.length).replace('+', '＋').replace('-', '−');
  return `${parentId} / 側面 ${direction}`;
}

// side 専用の規則へ分岐する呼び手が、型を狭めるために使う。
export function isSideMount(mount: ConstructionMount): mount is Exclude<ConstructionMount, 'axial'> {
  return mount !== 'axial';
}

// 建造枝の親候補を走査し、末尾の軸接続と全ての空きサイド接続を列挙する。
export function enumerateConstructionSlots(
  assembly: ShipAssembly, parentIds: readonly string[], axialTailId: string,
): readonly ConstructionSlot[] {
  const tailDefinition = assembly.definition(axialTailId);
  const isDockTail = tailDefinition?.kind === 'dock' || tailDefinition?.kind === 'docking_port';
  const slots: ConstructionSlot[] = [{
    id: constructionSlotId(axialTailId, 'axial'), parentId: axialTailId, mount: 'axial', kind: 'axial',
    label: constructionSlotLabel(axialTailId, 'axial'),
    direction: isDockTail ? v3(0, 0, 1) : v3(0, 0, -1),
  }];
  for (const parentId of parentIds) {
    const definition = assembly.definition(parentId);
    if (definition?.kind !== 'cockpit' && definition?.kind !== 'tank') continue;
    for (const mount of SIDE_MOUNTS) {
      const direction = SIDE_DIRECTIONS[mount];
      if (sideSlotOccupied(assembly, parentId, direction)) continue;
      slots.push({
        id: constructionSlotId(parentId, mount), parentId, mount, kind: 'side',
        label: constructionSlotLabel(parentId, mount), direction,
      });
    }
  }
  return slots;
}

// 選んだ定義を候補へ置いたときの transform と妥当性を、表示から独立して判定する。
export function placementForSlot(
  assembly: ShipAssembly, slot: ConstructionSlot, definition: ShipModuleDefinition,
): ConstructionPlacement {
  const parentDefinition = assembly.definition(slot.parentId);
  if (parentDefinition === null) {
    return invalidPlacement(slot, '接続先の部品が存在しません');
  }
  const side = isSideMount(slot.mount);
  const isDockParent = !side && (parentDefinition.kind === 'dock' || parentDefinition.kind === 'docking_port');
  const transform: ModuleTransform = side
    ? sideMountTransform(parentDefinition, definition, toSideSlot(slot.mount))
    : isDockParent
      ? {
        position: v3(0, 0, (parentDefinition.length + definition.length) / 2),
        rotation: qFromAxisAngle(LOCAL_UP, Math.PI),
      }
      : {
        position: v3(0, 0, -(parentDefinition.length / 2 + definition.length / 2)),
        rotation: Q_IDENTITY,
      };
  let reason: string | null = null;
  if (side && (parentDefinition.kind !== 'cockpit' && parentDefinition.kind !== 'tank')) {
    reason = '側面部品は cockpit または tank にだけ取り付けられます';
  } else if (side && !SIDE_KINDS.has(definition.kind)) {
    reason = '選択した部品は側面に取り付けられません';
  } else if (side && sideSlotOccupied(assembly, slot.parentId, slot.direction)) {
    reason = '選択した側面スロットは使用中です';
  } else if (!side && (definition.kind === 'radiator' || definition.kind === 'solar_panel')) {
    reason = '選択した部品は側面スロット専用です';
  }
  return { valid: reason === null, reason, parentId: slot.parentId, transform, kind: slot.kind };
}

// child transform の方向を接続方向へ射影し、同じ親・同じ面の重複だけを拒否する。
export function sideSlotOccupied(assembly: ShipAssembly, parentId: string, direction: Vec3): boolean {
  return assembly.graph.some(edge => edge.parentId === parentId && edge.kind === 'side'
    && edge.childTransform.position.x * direction.x
      + edge.childTransform.position.y * direction.y
      + edge.childTransform.position.z * direction.z > 0);
}

// 幾何情報をHUDへ渡さず、候補の選択状態だけを表示型へ写す。
export function slotState(slot: ConstructionSlot, placement: ConstructionPlacement): ConstructionSlotState {
  return {
    id: slot.id, parentId: slot.parentId, mount: slot.mount, kind: slot.kind, label: slot.label,
    valid: placement.valid, reason: placement.reason,
  };
}

// 親が消えた保存ドラフトも一覧から無言で落とさず、無効候補として説明できるようにする。
function invalidPlacement(slot: ConstructionSlot, reason: string): ConstructionPlacement {
  return {
    valid: false, reason, parentId: slot.parentId,
    transform: { position: v3(), rotation: Q_IDENTITY }, kind: slot.kind,
  };
}
