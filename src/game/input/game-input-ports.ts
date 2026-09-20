// ゲーム画面の入力ポートの表: どの単発キーをどの持ち主へ渡すかと、その有効条件。表の並びが
// 優先順位になる。
import { KEY_MAPPING as K } from '../../input/key-mapping';
import { simSpeedCommands } from '../dynamic/sim-speed-commands';
import { viewCommands } from '../viewer/view-commands';
import { gameCommand } from './game-commands';
import type { GameInputPort } from './game-input-router';
import type { PilotInput } from './pilot-input';
import type { Hud } from '../hud/hud';
import type { PauseMenu } from '../../hud/windows/pause-menu';
import type { CameraSystem } from '../camera/camera-system';
import type { ViewManager } from '../view/view-manager';
import type { Targeter } from '../targeter';
import type { CommandQueue } from '../command-queue';
import type { SimSpeedManager } from '../dynamic/sim-speed-manager';
import type { ViewSelection } from '../viewer/view-selection';
import type { Controllable } from '../dynamic/dynamic-entity/controllable';

// ゲーム全体ではなく、単発キーの解釈に必要な進行の読み取り口だけを渡す。
export interface GameInputSource {
  readonly commands: CommandQueue;
  readonly simSpeedManager: SimSpeedManager;
  readonly view: ViewSelection;
  readonly activeControllable: Controllable | null;
  readonly stageIsPlaying: boolean;
}

// 画面・カメラ・ターゲット・時間加速・ビューの単発キーを受ける口。
export function gameInputPorts(
  source: GameInputSource, hud: Hud, pauseMenu: PauseMenu,
  cameraSystem: CameraSystem, viewManager: ViewManager, targeter: Targeter,
  constructionActive: () => boolean,
): readonly GameInputPort[] {
  const speedCommands = simSpeedCommands(source.commands, source.simSpeedManager);
  const viewSelectionCommands = viewCommands(source.commands, source.view);
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
      isEnabled: () => !constructionActive(),
      commands: [gameCommand(K.help.code, K.help)],
      handleCommand: command => hud.handleCommand(command.id),
    },
    {
      feature: 'camera-command',
      isEnabled: () => !constructionActive(),
      commands: [gameCommand(K.followAttitudeToggle.code, K.followAttitudeToggle)],
      handleCommand: command => cameraSystem.handleCommand(command.id),
    },
    {
      feature: 'target-command',
      isEnabled: () => !overlays.isGamePaused()
        && !overlays.isInputGated()
        && !constructionActive()
        && viewManager.current === 'combat'
        && source.activeControllable !== null,
      commands: [gameCommand(K.targetSelect.code, K.targetSelect)],
      handleCommand: () => targeter.requestTargetSelect(),
    },
    {
      feature: 'game-speed',
      isEnabled: () => !overlays.isInputGated() && !constructionActive(),
      commands: [
        gameCommand(K.warpSlower.code, K.warpSlower),
        gameCommand(K.warpFaster.code, K.warpFaster),
      ],
      handleCommand: command => speedCommands.shift(command.id === K.warpSlower.code ? -1 : 1),
    },
    {
      feature: 'view',
      isEnabled: () => !overlays.isInputGated() && !constructionActive(),
      commands: [gameCommand(K.toggleMapMode.code, K.toggleMapMode)],
      handleCommand: () => viewSelectionCommands.toggle(),
    },
    {
      feature: 'active-view',
      isEnabled: () => !overlays.isInputGated() && !constructionActive(),
      commands: [
        gameCommand(K.deleteNode.code, K.deleteNode),
        gameCommand(K.autoWarpToNode.code, K.autoWarpToNode),
      ],
      handleCommand: command => viewManager.activeView.handleCommand(command.id),
    },
  ];
}

// 操作対象の操作量と命令を受ける口。命令の口は、命令を適用できないフレームには閉じて他の受け手へ
// 回す。ワープ倍率による可否は、このフレームの倍率が進行の位相の先頭で確定するので適用の側で見る。
export function pilotInputPorts(
  pilotInput: PilotInput, source: GameInputSource, hud: Hud, constructionActive: () => boolean,
): readonly GameInputPort[] {
  return [
    pilotInput.actionPortWith(() => !hud.overlayManager.isInputGated() && !constructionActive()),
    pilotInput.commandPort(
      () => !hud.overlayManager.isGamePaused() && !constructionActive()
        && source.stageIsPlaying && source.activeControllable !== null,
    ),
  ];
}
