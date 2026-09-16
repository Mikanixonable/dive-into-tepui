import type { Input } from '../../input/input';
import type { FrameSections } from '../frame-sections';
import { SECTION } from '../frame-sections';
import type { Controllable } from '../dynamic/dynamic-entity/controllable';
import type { DynamicSystem } from '../dynamic/dynamic-system';
import type { SimSpeedManager } from '../dynamic/sim-speed-manager';
import type { Targeter } from '../targeter';
import type { ControlSelection } from '../control-selection';
import type { Stage } from '../stages/stage';
import type { FlashEffects } from '../vfx/flash-effects';

type RouteControllableInput = (
  active: Controllable | null, registry: DynamicSystem, operable: boolean,
) => void;

// シミュレーション時刻を進める順序を所有する。表示時刻や描画同期はここへ入れない。
export class SimulationPhase {
  public constructor(
    private readonly input: Input,
    private readonly sections: FrameSections,
    private readonly activeStage: Stage,
    private readonly simSpeedManager: SimSpeedManager,
    private readonly dynamicSystem: DynamicSystem,
    private readonly targeter: Targeter,
    private readonly controlSelection: ControlSelection,
    private readonly flashEffects: FlashEffects,
    private readonly routeControllableInput: RouteControllableInput,
  ) {}

  // ステージ → 指令決定 → 積分 → エフェクトの順に1フレーム進める。
  public update(dt: number, active: Controllable | null): void {
    // このフレームで使う倍率を最初に一度だけ確定する。燃料消費・操作ゲート・積分が
    // 自動ワープの段階変更を跨いで別の倍率を読むと、同じ区間を表さなくなる。
    this.simSpeedManager.update(this.dynamicSystem.simTime);
    const simDt = dt * this.simSpeedManager.simSpeed;
    const canShipAct = this.simSpeedManager.canShipAct;
    const canEngage = this.simSpeedManager.canEngage;
    // 台本が世界を編集してから、そのフレームの顔ぶれで指令と積分を行う。
    this.sections.enter(SECTION.stage);
    this.activeStage.update(dt, this.dynamicSystem.simTime, this.simSpeedManager);
    this.sections.exit(SECTION.stage);
    this.dynamicSystem.update(
      active, this.input, canShipAct, dt, simDt, canEngage, this.activeStage, this.activeStage.stageRules,
      () => this.routeControllableInput(active, this.dynamicSystem, canShipAct),
    );

    this.targeter.updateBoardMarks(dt, active);
    this.controlSelection.reclaimDead();

    this.sections.enter(SECTION.effects);
    this.flashEffects.update(dt, this.dynamicSystem.simTime);
    this.sections.exit(SECTION.effects);
  }
}
