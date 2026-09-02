// 被選択物が起動できる操作と、項目のラベル・可否を決めるために要る現在の操作状態を差し出す口。
import type { KinematicState } from '../../physics/kinematic-state';
import type { View } from '../view';
import type { Base } from '../dynamic/dynamic-entity/base';
import type { DynamicEntity } from '../dynamic/dynamic-entity/dynamic-entity';
import type { DynamicEntityKind } from '../dynamic/dynamic-entity/entity-kind';
import type { Player } from '../player/player';
import type { ObjectPickable } from './object-pickable';

// 操作中の自艦から見た、その対象とのドッキング状態。
export type DockState = 'docked' | 'dockable' | 'none';

export interface ObjectCommands {
  // 画面へ通知を出す。
  hint(text: string): void;
  // マップの注視点を id へ移し、name で通知する。
  focus(id: string, name: string): void;
  // target のプロパティウィンドウを (clientX, clientY) へ開く。
  openProperties(target: ObjectPickable, clientX: number, clientY: number): void;
  // 基地を選択状態にする。
  selectBase(base: Base): void;
  // その基地のプロパティウィンドウが抱えている基地パネルを開閉する。
  toggleBasePanel(base: Base): void;
  // 航法ターゲットを設定・解除する。
  toggleNavTarget(id: string, name: string): void;
  // 時刻 t まで時間を加速する。既に通過していれば通知だけ出す。
  warpTo(t: number): void;
  // 時刻 t の計画軌道へノードを置く。
  addNodeAt(t: number): void;
  // 操作対象の自艦を切り替える。null で未操作へ戻す。
  setActivePlayer(ship: Player | null): void;
  // 自艦を世界から取り除く。
  removePlayer(ship: Player): void;
  // 操作対象の基地を切り替える。null で未操作へ戻す。
  setControlledBase(base: Base | null): void;
  // 基地を世界から取り除き、その基地を指していた操作対象・ドッキング先も外す。
  removeBase(base: Base): void;
  // 操作中の自艦を target へドッキングさせる。
  dock(target: DynamicEntity): void;
  // 操作中の自艦のドッキングを解除する。
  undock(): void;
  // 操作中の自艦と target の間で物資・電力を融通するダイアログを開く。
  transferResources(target: Player): void;
  // state の軌道要素をプリセットした物体配置パネルを、kind の種類で開く。
  duplicate(kind: DynamicEntityKind, state: KinematicState): void;
  // 現在のフォーカスを基準天体の初期値として物体配置パネルを開く。
  openObjectPlacer(): void;
  openSettings(): void;

  // 操作中の自艦。未操作なら null。
  readonly activePlayer: Player | null;
  // 操作中の基地。未操作なら null。
  readonly controlledBase: Base | null;
  // 物体の配置・複製を許すステージか。
  readonly canAuthor: boolean;
  // 軌道計画の実行を持つステージか。
  readonly executesPlans: boolean;
  // 現在のビュー。
  readonly view: View;
  isNavTarget(id: string): boolean;
  // 航法ターゲットに設定できるか。軌道面が定まらない対象では false。
  canNavTarget(id: string, simTime: number): boolean;
  dockState(target: DynamicEntity): DockState;
  // その基地のプロパティウィンドウが基地パネルを展開しているか。
  isBasePanelExpanded(base: Base): boolean;
}
