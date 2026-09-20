// 建造モードのゲーム状態とHUDの間で共有する、不変な表示語彙。

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
