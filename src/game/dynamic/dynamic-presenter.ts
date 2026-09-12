// エンティティ状態を renderer/view へ同期するための狭いゲーム側ポート。THREE や HUD/DOM の
// 実体を状態所有者へ注入せず、同一フレームの表示入力だけを渡す。

import type { Attitude } from '../../physics/attitude';
import type { KinematicState } from '../../physics/kinematic-state';

// View が表示同期に必要とする、エンティティ側の状態スナップショット。
export interface EntityPresentationState {
  readonly id: string;
  readonly state: KinematicState;
  readonly attitude: Attitude;
  readonly alive: boolean;
}

// 表示資源を所有する renderer/view へ渡す同期ポート。ゲーム状態の更新や寿命判定は行わない。
export interface DynamicPresenter {
  present(entity: EntityPresentationState): void;
  remove(id: string): void;
}
