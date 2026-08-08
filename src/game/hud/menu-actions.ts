import { MenuItem } from './context-menu';

export type MenuAction =
  | 'focus'
  | 'navTarget'
  | 'warp'
  | 'addNode'
  | 'activate'
  | 'followToggle'
  | 'delete'
  | 'cancel'
  | 'openShipPlacer'
  | 'openDock'
  | 'openObjectList'
  | 'openSettings';

// 共通メニュー項目ファクトリ
export const MenuCommon = {
  cancel: (): MenuItem<MenuAction> => ({ label: 'キャンセル', act: 'cancel', shortcut: 'Escape' }),
  focus: (): MenuItem<MenuAction> => ({ label: 'フォーカスを移動', act: 'focus', shortcut: 'f' }),
  warp: (): MenuItem<MenuAction> => ({ label: 'この位置まで時間を加速', act: 'warp', shortcut: 'w' }),
  addNode: (): MenuItem<MenuAction> => ({ label: 'ここにノードを追加', act: 'addNode', shortcut: 'n' }),
  deleteNode: (): MenuItem<MenuAction> => ({ label: 'ノードを削除', act: 'delete', shortcut: 'Delete' }),
  navTarget: (isTarget: boolean): MenuItem<MenuAction> => ({
    label: isTarget ? '航法ターゲット解除' : '航法ターゲットに設定',
    act: 'navTarget',
    shortcut: 't',
  }),
};
