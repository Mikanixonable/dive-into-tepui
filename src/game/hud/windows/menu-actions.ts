import { MenuItem } from './context-menu';

// 右クリックメニューの操作を表す act 識別子(MenuAction)と、頻出する項目を組み立てる
// 共通ファクトリ(MenuCommon)を提供する。
export type MenuAction =
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

// shortcut には KeyboardEvent.code の表記を使う。
export const MenuCommon = {
  cancel: (): MenuItem<MenuAction> => ({ label: 'キャンセル', act: 'cancel', shortcut: 'Escape' }),
  focus: (): MenuItem<MenuAction> => ({ label: 'フォーカスを移動', act: 'focus', shortcut: 'KeyF' }),
  warp: (): MenuItem<MenuAction> => ({ label: 'この位置まで時間を加速', act: 'warp', shortcut: 'KeyW' }),
  addNode: (): MenuItem<MenuAction> => ({ label: 'ここにノードを追加', act: 'addNode', shortcut: 'KeyN' }),
  deleteNode: (): MenuItem<MenuAction> => ({ label: 'ノードを削除', act: 'delete', shortcut: 'Delete' }),
  duplicate: (): MenuItem<MenuAction> => ({ label: '複製', act: 'duplicate' }),
  target: (isTarget: boolean): MenuItem<MenuAction> => ({
    label: isTarget ? 'ターゲット解除' : 'ターゲットに設定',
    act: 'target',
    shortcut: 'KeyT',
  }),
  trajectoryLine: (on: boolean): MenuItem<MenuAction> => ({
    label: '予測線・過去線で表示', act: 'toggleTrajectoryLine', selected: on, keepOpen: true,
  }),
};
