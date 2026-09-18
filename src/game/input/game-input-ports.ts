// ゲーム画面の入力ポートの表: どの単発キーをどの持ち主へ渡すかと、その有効条件。表の並びが
// 優先順位になる。
import { KEY_MAPPING as K } from '../../input/key-mapping';
import { simSpeedCommands } from '../dynamic/sim-speed-commands';
import { viewCommands } from '../viewer/view-commands';
import { gameCommand } from './game-commands';
import type { GameInputPort } from './game-input-router';
import type { PilotInput } from './pilot-input';
import type { Game } from '../game';
import type { Hud } from '../hud/hud';
import type { PauseMenu } from '../../hud/windows/pause-menu';
import type { CameraSystem } from '../camera/camera-system';
import type { ViewManager } from '../view/view-manager';
import type { Targeter } from '../targeter';

// 画面・カメラ・ターゲット・時間加速・ビューの単発キーを受ける口。
export function gameInputPorts(
  game: Game, hud: Hud, pauseMenu: PauseMenu,
  cameraSystem: CameraSystem, viewManager: ViewManager, targeter: Targeter,
): readonly GameInputPort[] {
  const speedCommands = simSpeedCommands(game.commands, game.simSpeedManager);
  const viewSelectionCommands = viewCommands(game.commands, game.viewer.view);
  const overlays = hud.overlayManager;
  // 一時停止メニュー・窓のショートカット・ヘルプを先に取り、ゲームの操作はモーダルが入力を塞ぐ間は閉じる。
  return [
    {
      feature: 'pause',
      commands: [gameCommand(K.pauseMenu.code, K.pauseMenu)],
      handleCommand: () => {
        if (!overlays.closeTopmostOnEscape()) pauseMenu.toggle(true);
      },
    },
    {
      feature: 'overlay-shortcut',
      handlePressed: code => overlays.dispatchShortcut(code),
    },
    {
      feature: 'hud',
      commands: [gameCommand(K.help.code, K.help)],
      handleCommand: command => hud.handleCommand(command.id),
    },
    {
      feature: 'camera-command',
      commands: [gameCommand(K.followAttitudeToggle.code, K.followAttitudeToggle)],
      handleCommand: command => cameraSystem.handleCommand(command.id),
    },
    {
      feature: 'target-command',
      isEnabled: () => !overlays.isGamePaused()
        && !overlays.isInputGated()
        && viewManager.current === 'combat'
        && game.activeControllable !== null,
      commands: [gameCommand(K.targetSelect.code, K.targetSelect)],
      handleCommand: () => targeter.requestTargetSelect(),
    },
    {
      feature: 'game-speed',
      isEnabled: () => !overlays.isInputGated(),
      commands: [
        gameCommand(K.warpSlower.code, K.warpSlower),
        gameCommand(K.warpFaster.code, K.warpFaster),
      ],
      handleCommand: command => speedCommands.handleCommand(command.id),
    },
    {
      feature: 'view',
      isEnabled: () => !overlays.isInputGated(),
      commands: [gameCommand(K.toggleMapMode.code, K.toggleMapMode)],
      handleCommand: () => viewSelectionCommands.toggle(),
    },
    {
      feature: 'active-view',
      isEnabled: () => !overlays.isInputGated(),
      commands: [
        gameCommand(K.deleteNode.code, K.deleteNode),
        gameCommand(K.autoWarpToNode.code, K.autoWarpToNode),
      ],
      handleCommand: command => viewManager.activeView.handleCommand(command.id, game.simTime),
    },
  ];
}

// 操作対象の操作量と命令を受ける口。押下エッジを拾う口は、命令を適用できないフレームには閉じて
// 他の受け手へ回す。ワープ倍率で決まる可否だけはここで見ない — このフレームの倍率は進行の位相の
// 先頭で確定するので、適用の側で見る。
export function pilotInputPorts(pilotInput: PilotInput, game: Game, hud: Hud): readonly GameInputPort[] {
  return [
    pilotInput.actionPort,
    pilotInput.commandPort(
      () => !hud.overlayManager.isGamePaused() && game.activeStage.isPlaying && game.activeControllable !== null,
    ),
  ];
}
