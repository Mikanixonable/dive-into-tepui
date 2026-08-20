import { MenuItem } from './context-menu';

export type MenuAction =
  | 'focus'
  | 'navTarget'
  | 'targetPrimary'
  | 'targetSecondary'
  | 'warp'
  | 'addNode'
  | 'activate'
  | 'deactivate'
  | 'planExecCycle'
  | 'duplicate'
  | 'delete'
  | 'cancel'
  | 'openObjectPlacer'
  | 'openBaseOperations'
  | 'openAssembly'
  | 'openSettings'
  | 'dock'
  | 'undock'
  | 'storeInBase'
  | 'transferResources';

// 共通メニュー項目ファクトリ。shortcut は KeyboardEvent.code — OverlayManager.dispatchShortcut
// が Input のエッジキューから受け取る値と同じ表記にする。
export const MenuCommon = {
  cancel: (): MenuItem<MenuAction> => ({ label: 'キャンセル', act: 'cancel', shortcut: 'Escape' }),
  focus: (): MenuItem<MenuAction> => ({ label: 'フォーカスを移動', act: 'focus', shortcut: 'KeyF' }),
  warp: (): MenuItem<MenuAction> => ({ label: 'この位置まで時間を加速', act: 'warp', shortcut: 'KeyW' }),
  addNode: (): MenuItem<MenuAction> => ({ label: 'ここにノードを追加', act: 'addNode', shortcut: 'KeyN' }),
  deleteNode: (): MenuItem<MenuAction> => ({ label: 'ノードを削除', act: 'delete', shortcut: 'Delete' }),
  duplicate: (): MenuItem<MenuAction> => ({ label: '複製', act: 'duplicate' }),
  navTarget: (isTarget: boolean): MenuItem<MenuAction> => ({
    label: isTarget ? '航法ターゲット解除' : '航法ターゲットに設定',
    act: 'navTarget',
    shortcut: 'KeyT',
  }),
  targetPrimary: (isTarget: boolean): MenuItem<MenuAction> => ({
    label: isTarget ? 'ターゲット解除' : 'ターゲットに設定',
    act: 'targetPrimary',
  }),
  targetSecondary: (isTarget: boolean): MenuItem<MenuAction> => ({
    label: isTarget ? '第二ターゲット解除' : '第二ターゲットに設定',
    act: 'targetSecondary',
  }),
  dock: (): MenuItem<MenuAction> => ({ label: 'ドッキング', act: 'dock' }),
  undock: (): MenuItem<MenuAction> => ({ label: 'ドッキング解除', act: 'undock' }),
  storeInBase: (): MenuItem<MenuAction> => ({ label: '基地に収納', act: 'storeInBase' }),
  transferResources: (): MenuItem<MenuAction> => ({ label: '物資・電力の融通', act: 'transferResources' }),
};
