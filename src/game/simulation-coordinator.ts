import type { Input } from '../input/input';
import type { ControlSelection } from './control-selection';
import type { DynamicSystem } from './dynamic/dynamic-system';
import type { SimSpeedManager } from './dynamic/sim-speed-manager';
import type { FlashEffects } from './vfx/flash-effects';
import type { Stage } from './stages/stage';
import type { Targeter } from './targeter';
import { SECTION } from './frame-sections';
import type { FrameSections } from './frame-sections';

// ステージ・指令・積分・一過性演出を、1フレームの順序どおりに前進させる。
export class SimulationCoordinator {
  constructor(
    private readonly activeStage: Stage,
    private readonly simSpeedManager: SimSpeedManager,
    private readonly dynamicSystem: DynamicSystem,
    private readonly targeter: Targeter,
    private readonly controlSelection: ControlSelection,
    private readonly flashEffects: FlashEffects,
    private readonly input: Input,
    private readonly sections: FrameSections,
  ) {}

  // ポーズ中と決着後は積分を止める。その他の個体は残骸・弾の先端時刻も進め続ける。
  update(dt: number, isPaused: boolean): void {
    if (isPaused || !this.activeStage.isPlaying) return;

    // このフレームで使う倍率を最初に一度だけ確定する。燃料消費・操作ゲート・積分が
    // 自動ワープの段階変更を跨いで別の倍率を読むと、同じ区間を表さなくなる。
    this.simSpeedManager.update(this.dynamicSystem.simTime);
    const simDt = dt * this.simSpeedManager.simSpeed;
    const canShipAct = this.simSpeedManager.canShipAct;
    const canEngage = this.simSpeedManager.canEngage;
    const controlled = this.controlSelection.current;
    // 台本が世界を編集してから、その顔ぶれで1フレーム進める。湧いた個体もこのフレームの
    // 指令決定と積分に乗る。
    this.sections.enter(SECTION.stage);
    this.activeStage.update(dt, this.dynamicSystem.simTime, this.simSpeedManager);
    this.sections.exit(SECTION.stage);
    this.dynamicSystem.update(
      controlled, this.input, canShipAct, dt, simDt, canEngage, this.activeStage);

    this.targeter.updateBoardMarks(dt, controlled);
    this.controlSelection.reclaimDead();

    this.sections.enter(SECTION.effects);
    this.flashEffects.update(dt, this.dynamicSystem.simTime);
    this.sections.exit(SECTION.effects);
  }
}
