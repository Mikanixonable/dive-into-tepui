import { MenuItem } from './context-menu';

export type MenuAction =
  | 'focus'
  | 'target'
  | 'warp'
  | 'addNode'
  | 'activate'
  | 'deactivate'
  | 'activateBase'
  | 'deactivateBase'
  | 'planExecCycle'
  | 'toggleTrajectoryLine'
  | 'duplicate'
  | 'delete'
  | 'cancel'
  | 'openObjectPlacer'
  | 'openDock'
  | 'openSettings'
  | 'dock'
  | 'undock'
  | 'storeInBase'
  | 'transferResources'
  | 'deployPart'
  | 'stowPart';

// 共通メニュー項目ファクトリ。shortcut は KeyboardEvent.code — OverlayManager.dispatchShortcut
// が Input のエッジキューから受け取る値と同じ表記にする。
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
  dock: (): MenuItem<MenuAction> => ({ label: 'ドッキング', act: 'dock' }),
  undock: (): MenuItem<MenuAction> => ({ label: 'ドッキング解除', act: 'undock' }),
  storeInBase: (): MenuItem<MenuAction> => ({ label: '基地に収納', act: 'storeInBase' }),
  transferResources: (): MenuItem<MenuAction> => ({ label: '物資・電力の融通', act: 'transferResources' }),
};
