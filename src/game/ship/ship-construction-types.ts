// 建造モードのゲーム状態とHUDの間で共有する、不変な表示語彙。
import type { ShipAssembly } from './ship-assembly';
import type { AxialFace } from './ship-assembly-transform';
import type { SideSlot } from './ship-assembly-types';

export type ConstructionMount = 'axial' | 'side+x' | 'side-x' | 'side+y' | 'side-y';
export type ConstructionSlotKind = 'axial' | 'side';
export type ConstructionRole = 'ship' | 'base' | 'material';

export interface ConstructionSlotState {
  readonly id: string;
  readonly parentId: string;
  readonly mount: ConstructionMount;
  readonly kind: ConstructionSlotKind;
  readonly label: string;
  readonly valid: boolean;
  readonly reason: string | null;
}

export interface ConstructionCapabilities {
  readonly thrust: number;
  readonly mainFuel: number;
  readonly rcsFuel: number;
  readonly power: number;
  readonly radiation: number;
}

export interface ConstructionPreview {
  readonly mass: number;
  readonly maxHp: number;
  readonly capabilities: ConstructionCapabilities;
}

export interface ShipConstructionPanelModel {
  readonly visible: boolean;
  readonly shipName: string;
  readonly dockLabel: string;
  readonly moduleCount: number;
  readonly totalMass: number;
  readonly hp: number;
  readonly maxHp: number;
  readonly capabilities: ConstructionCapabilities;
  readonly preview: ConstructionPreview | null;
  readonly role: ConstructionRole;
  readonly warning: string | null;
  readonly selectedDefinitionId: string;
  readonly selectedModuleName: string;
  readonly selectedSlotId: string;
  readonly slots: readonly ConstructionSlotState[];
  readonly canPlace: boolean;
  readonly canRemove: boolean;
  readonly canFinish: boolean;
}

export interface ConstructionConfirmationRequest {
  readonly title: string;
  readonly message: string;
  readonly confirmLabel: string;
  readonly destructive?: boolean;
}

export interface ConstructionConfirmationPort {
  request(request: ConstructionConfirmationRequest, onResult: (confirmed: boolean) => void): void;
  close(): void;
}

// 建造で手持ちのものを置ける取り付け先。空いている軸方向の面、空いている側面スロット、
// 軸方向に隣り合う2モジュールの継ぎ目の3種。
export type ConstructionTarget =
  | { readonly kind: 'axial-face'; readonly parentId: string; readonly face: AxialFace }
  | { readonly kind: 'side-slot'; readonly parentId: string; readonly slot: SideSlot }
  | { readonly kind: 'joint'; readonly connectionId: string };

// 建造で手に持っているもの。カタログの定義、配置済みモジュールの先端部(付け替え)、
// 先端部の写し(複製・設計図)の3種。写しは根が取り付けるモジュールになる。
export type ConstructionHeld =
  | { readonly kind: 'catalog'; readonly definitionId: string }
  | { readonly kind: 'piece'; readonly moduleId: string }
  | { readonly kind: 'copy'; readonly piece: ShipAssembly };

// 側面へ新しく置くときの対称数。1 は指した位置だけ、2 は対向する2位置、4 は全4位置。
export type ConstructionSymmetry = 1 | 2 | 4;

// 閉じた建造パネルへ同期する、表示資源を持たない空のmodel。
export function hiddenShipConstructionModel(): ShipConstructionPanelModel {
  return {
    visible: false, shipName: '—', dockLabel: '—', moduleCount: 0, totalMass: 0, hp: 0, maxHp: 0,
    capabilities: { thrust: 0, mainFuel: 0, rcsFuel: 0, power: 0, radiation: 0 }, preview: null,
    role: 'material', warning: null, selectedDefinitionId: 'cockpit-standard',
    selectedModuleName: 'コックピット', selectedSlotId: 'axial', slots: [],
    canPlace: false, canRemove: false, canFinish: false,
  };
}
