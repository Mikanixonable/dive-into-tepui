// 被選択物が起動できる操作と、項目のラベル・可否を決めるために要る現在の操作状態を差し出す口。
import type { KinematicState } from '../../physics/kinematic-state';
import type { Controllable } from '../dynamic/dynamic-entity/controllable';
import type { DynamicEntityKind } from '../dynamic/dynamic-entity/entity-kind';
import type { ObjectPickable } from './object-pickable';

export interface ObjectCommands {
  // 画面へ通知を出す。
  hint(text: string): void;
  // target のプロパティウィンドウを (clientX, clientY) へ開く。
  openProperties(target: ObjectPickable, clientX: number, clientY: number): void;
  // 時刻 t まで時間を加速する。既に通過していれば通知だけ出す。
  warpTo(t: number): void;
  // 時刻 t の計画軌道へノードを置く。
  addNodeAt(t: number): void;
  // 操作対象を切り替える。null で未操作へ戻す。
  setControlled(target: Controllable | null): void;
  // 操作対象になりうるものを世界から取り除き、指していた操作対象も外す。
  removeControlled(target: Controllable): void;
  // state の軌道要素をプリセットした物体配置パネルを、kind の種類で開く。
  duplicate(kind: DynamicEntityKind, state: KinematicState): void;
  // 現在のフォーカスを基準天体の初期値として物体配置パネルを開く。
  openObjectPlacer(): void;
  openSettings(): void;

  // いま操作している対象。未操作なら null。
  readonly controlled: Controllable | null;
}
