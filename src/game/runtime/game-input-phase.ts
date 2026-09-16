import type { Input } from '../../input/input';
import type { Controllable } from '../dynamic/dynamic-entity/controllable';
import type { EntityRegistry } from '../dynamic/entity-registry';
import type { GameInputPort, GameInputRouter } from '../input/game-input-router';
import { gameCommand } from '../input/game-commands';
import { KEY_MAPPING as K } from '../../input/key-mapping';
import type { Hud } from '../hud/hud';
import type { ViewManager } from '../view/view-manager';

const CONTROLLABLE_COMMANDS = [
  K.thrustForward, K.thrustBackward, K.thrustLeft, K.thrustRight, K.thrustUp, K.thrustDown,
  K.rcsDampToggle, K.progradeReset, K.fineAttitudeToggle, K.progradeHoldToggle,
  K.throttleLow, K.throttleMid, K.throttleHigh, K.throttleMax,
  K.boosterDecouple, K.boosterIgnitionToggle,
  K.radiatorDeployLeft, K.radiatorDeployRight, K.solarDeployLeft, K.solarDeployRight,
  K.reload,
].map((binding) => gameCommand(binding.code, binding));

// raw input の更新、ゲーム入力の優先配分、ビューの連続操作を1つの入力フェーズへ束ねる。
export class GameInputPhase {
  public constructor(
    private readonly input: Input,
    private readonly router: GameInputRouter,
    private readonly hud: Hud,
    private readonly viewManager: ViewManager,
  ) {}

  // 1フレームの入力snapshotを確定し、単発操作と連続操作を配る。
  public update(dt: number): void {
    this.input.update();
    this.router.beginFrame();
    this.router.route();
    if (this.hud.overlayManager.isInputGated()) return;
    // マップの Δv 編集はプレイヤーの入力edgeより先に押下中キーを確保する。
    this.viewManager.activeView.updateActions(this.input, dt);
  }

  // Game 更新後のLauncher・snapshot等へ、同じフレームの未消費edgeを配る。
  public routeAdditional(ports: readonly GameInputPort[]): void {
    this.router.routeAdditional(ports);
  }

  // 自律推力の更新後、現在の操作対象へ単発入力を配る。
  public routeControllableInput(
    active: Controllable | null, registry: EntityRegistry, operable: boolean,
  ): void {
    if (!active || !operable) return;
    this.router.routeAdditional([{
      feature: 'controllable',
      commands: CONTROLLABLE_COMMANDS,
      handleCommand: command => active.handleInputCommand(command.id, registry),
    }]);
  }
}
