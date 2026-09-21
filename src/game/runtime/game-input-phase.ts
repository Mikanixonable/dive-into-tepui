// 生の入力をゲームの命令・操作量・ポインタ操作へ解釈する phase。入力資源そのものは表示の根が
// 所有し、この phase は既存のビュー・カメラ・建造操作へ配分する順序だけを所有する。
import { SECTION, type FrameSections } from '../frame-sections';
import type { CameraSystem } from '../camera/camera-system';
import type { Targeter } from '../targeter';
import type { ViewManager } from '../view/view-manager';
import type { ShipConstruction } from '../ship/ship-construction';
import type { Input } from '../../input/input';
import { GameInputRouter, gameInputMode, type GameInputPort } from '../input/game-input-router';
import { gameInputPorts, pilotInputPorts } from '../input/game-input-ports';
import { rawGameInputAdapter } from '../input/raw-game-input-adapter';
import { PilotInput } from '../input/pilot-input';
import type { GameInputSource } from '../input/game-input-ports';
import type { PauseMenu } from '../../hud/windows/pause-menu';
import type { PilotControls } from '../dynamic/dynamic-entity/pilot-controls';
import type { CameraFrame } from '../../render/camera/camera-frame';
import type { Viewport } from '../../render/viewport';
import type { Hud } from '../hud/hud';

export class GameInputPhase {
  private readonly inputRouter: GameInputRouter;
  private readonly pilotInput = new PilotInput();
  private readonly pilotPorts: readonly GameInputPort[];

  public constructor(
    private readonly source: GameInputSource,
    private readonly hud: Hud,
    pauseMenu: PauseMenu,
    private readonly cameraSystem: CameraSystem,
    private readonly viewManager: ViewManager,
    private readonly targeter: Targeter,
    private readonly shipConstruction: ShipConstruction,
    private readonly input: Input,
    private readonly cameraFrameOf: () => CameraFrame | null,
    private readonly sections: FrameSections,
  ) {
    this.inputRouter = new GameInputRouter(
      rawGameInputAdapter(input),
      gameInputPorts(
        source, hud, pauseMenu, this.cameraSystem, this.viewManager, this.targeter,
        () => this.shipConstruction.active,
      ),
    );
    this.pilotPorts = pilotInputPorts(this.pilotInput, source, hud, () => this.shipConstruction.active);
  }

  // このフレームの入力解釈が組んだ操作量。
  public get pilotControls(): PilotControls { return this.pilotInput.controls; }

  // 生の入力を担当モジュールへ先着順で配り、命令とこのフレームの操作量を組む。dt [s] は進行へ渡す
  // 刻み、nowMs [ms] はフレームの先頭で1度だけ読んだ実時刻。
  public interpret(dt: number, nowMs: number, viewport: Viewport): void {
    this.sections.enter(SECTION.input);
    this.input.update();
    this.handleInput(dt, nowMs, viewport);
    this.sections.exit(SECTION.input);
  }

  // フレームの残りの入力イベントを、ports の優先度順にディスパッチする。
  public routeInput(ports: readonly GameInputPort[]): void {
    this.inputRouter.routeAdditional(ports);
  }

  // 入力の担当を優先順に呼び、命令とこのフレームの操作量を組む。呼ぶ順序が優先順位になる。
  private handleInput(dt: number, nowMs: number, viewport: Viewport): void {
    const overlays = this.hud.overlayManager;
    this.inputRouter.beginFrame();
    // 連打の判定には、直前の進行が確定させたワープ倍率で艦が動けるかを渡す(CONTROLS.md)。
    this.pilotInput.beginFrame(nowMs, this.source.simSpeedManager.canShipAct);
    this.inputRouter.route();
    const inputMode = gameInputMode(
      overlays.isGamePaused(), overlays.isInputGated(), this.shipConstruction.active,
    );
    // 同じフレームの route で開いたモーダルも、ここから先のビューの操作を止める。
    if (inputMode.world) {
      // マップの Δv 編集は操作対象の解釈より先に押下中キーを確保する。
      this.viewManager.activeView.updateActions(dt);
    }
    this.inputRouter.routeAdditional(this.pilotPorts);
    if (inputMode.camera) {
      this.cameraSystem.handleInput(this.input, dt, viewport, this.source.activeControllable);
    }
    // ピッキング判定は直前の sync で確定したカメラおよび候補列に基づいて評価する — 入力解釈は本フレームの導出処理に先行して実行される。
    const cameraFrame = this.cameraFrameOf();
    if ((inputMode.world || inputMode.construction) && cameraFrame !== null) {
      this.sections.switchTo(SECTION.input, SECTION.pointer);
      if (inputMode.construction) {
        this.shipConstruction.handlePointer(this.input, this.cameraSystem, viewport);
      } else {
        this.viewManager.activeView.handlePointer(cameraFrame);
      }
      this.sections.switchTo(SECTION.pointer, SECTION.input);
    }
  }
}
