// エンティティの状態を UI へ渡すためのゲーム側の読み取り契約。DOM や HUD のウィジェットを
// 保持せず、表示する値と対象へ返す操作だけをゲームの境界で定義する。

import type { DynamicEntityKind } from '../dynamic/dynamic-entity/entity-kind';

// プロパティウィンドウへ渡すゲーム側の一行。描画側の PropertyRow とは意図的に分離する。
export interface EntityInspectionPropertyRow {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  readonly collapsible?: boolean;
  readonly group?: string;
}

// エンティティへ返すメニュー操作の語彙。ラベルや DOM のイベントではなく、ゲームの意図を表す。
export type EntityInspectionAction =
  | 'focus'
  | 'target'
  | 'warp'
  | 'addNode'
  | 'activate'
  | 'deactivate'
  | 'planExecCycle'
  | 'toggleTrajectoryLine'
  | 'duplicate'
  | 'delete'
  | 'cancel'
  | 'openObjectPlacer'
  | 'openSettings'
  | 'deployPart'
  | 'stowPart';

// メニュー描画に必要なゲーム側の宣言。ContextMenu の項目型を持ち込まない。
export interface EntityInspectionMenuItem {
  readonly action?: EntityInspectionAction;
  readonly label: string;
  readonly type?: 'item' | 'header';
  readonly shortcut?: string;
  readonly selected?: boolean;
  readonly keepOpen?: boolean;
  readonly subLabel?: string;
}

// ある時点で対象を検査した結果。UI はこの値を描画するだけで、エンティティを保持しない。
export interface EntityInspectionSnapshot {
  readonly id: string;
  readonly name: string;
  readonly kind: DynamicEntityKind | null;
  readonly propertyRows: readonly EntityInspectionPropertyRow[];
  readonly menuItems: readonly EntityInspectionMenuItem[];
}

// 被選択エンティティが提供する最小の検査ポート。操作の実装はアダプター側が保持し、UI へ
// サービスロケーターや PropertyWindow/ContextMenu の実体を注入しない。
export interface EntityInspectionPort {
  readInspection(): EntityInspectionSnapshot;
  executeMenuAction(action: EntityInspectionAction): void;
  readonly rename: ((name: string) => void) | null;
}
