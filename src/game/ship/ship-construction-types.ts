// 建造モードのゲーム状態とHUDの間で共有する、不変な表示語彙。
import type { ShipAssembly } from './ship-assembly';
import type { AxialFace, ModuleOrientation } from './ship-assembly-transform';
import type { SideSlot } from './ship-assembly-types';

export type ConstructionRole = 'ship' | 'base' | 'material';

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

// 取り付け先一覧の1行。内部識別子は表示に出さず、説明はラベルと理由だけで組む。
export interface ConstructionTargetState {
  readonly id: string;
  readonly label: string;
  readonly valid: boolean;
  readonly reason: string | null;
}

// 直近に成功した編集の記録。操作音と差し込みの動きが読む。通し番号は単調増加。
export type ConstructionOperationKind = 'place' | 'move' | 'remove' | 'rotate' | 'restore';

export interface ConstructionOperationRecord {
  readonly kind: ConstructionOperationKind;
  readonly moduleIds: readonly string[];
  readonly sequence: number;
}

// 直近に拒まれた操作の記録。拒否音が読む。
export interface ConstructionDeniedRecord {
  readonly reason: string;
  readonly sequence: number;
}

// 取り消し履歴の表示用の写し。名前の列と現在位置、取り消し・やり直しの可否。
export interface ConstructionHistoryView {
  readonly names: readonly string[];
  readonly position: number;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
}

// 手に持っているものの表示用の写し。catalogId はカタログ由来のときだけ定義 id を持つ。
export interface ShipConstructionHeldView {
  readonly name: string;
  readonly catalogId: string | null;
  readonly orientation: ModuleOrientation;
  readonly symmetry: ConstructionSymmetry;
}

// 選択中の配置済みモジュールの表示用の写し。canEdit は撤去・付け替え・回転を受け付けるか。
export interface ShipConstructionSelectionView {
  readonly name: string;
  readonly canEdit: boolean;
}

export interface ShipConstructionPanelModel {
  readonly visible: boolean;
  readonly shipName: string;
  readonly held: ShipConstructionHeldView | null;
  readonly selection: ShipConstructionSelectionView | null;
  readonly moduleCount: number;
  readonly totalMass: number;
  readonly hp: number;
  readonly maxHp: number;
  readonly capabilities: ConstructionCapabilities;
  // 指している取り付け先へ手持ちを置いたときの適用後の見積り。無ければ null。
  readonly preview: ConstructionPreview | null;
  readonly role: ConstructionRole;
  readonly warning: string | null;
  readonly pointedTargetId: string | null;
  readonly targets: readonly ConstructionTargetState[];
  readonly history: ConstructionHistoryView;
  readonly canPlace: boolean;
  readonly canRemove: boolean;
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

// 閉じた建造パネルへ同期する、表示資源を持たない空のmodel。
export function hiddenShipConstructionModel(): ShipConstructionPanelModel {
  return {
    visible: false, shipName: '—', held: null, selection: null,
    moduleCount: 0, totalMass: 0, hp: 0, maxHp: 0,
    capabilities: { thrust: 0, mainFuel: 0, rcsFuel: 0, power: 0, radiation: 0 }, preview: null,
    role: 'material', warning: null, pointedTargetId: null, targets: [],
    history: { names: [], position: 0, canUndo: false, canRedo: false },
    canPlace: false, canRemove: false,
  };
}
