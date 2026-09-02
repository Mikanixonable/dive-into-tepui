// 戦闘ビュー専用のフレーム処理と遷移フック(WorldViewFrame の具象)。呼ぶ位置と順序は
// Game / ViewManager が持つ。
import type { Input } from './input/input';
import { KEY_MAPPING as K } from './input/key-mapping';
import type { Hud } from './hud/hud';
import type { SimSpeedManager } from './dynamic/sim-speed-manager';
import type { TouchControls } from './input/touch';
import type { CameraSystem } from './camera/camera-system';
import type { DynamicSystem } from './dynamic/dynamic-system';
import type { MapContextActions } from './pickable/map-context-actions';
import type { CelestialMarkers } from './marker/celestial-markers';
import type { Targeter } from './targeter';
import type { ActiveControllableController } from './active-controllable-controller';
import type { DockingGuide } from './docking/docking-guide';
import type { PlanGuide } from './plan/plan-guide';
import type { PlanPath } from './plan/plan-path';
import type { CelestialSystem } from './celestial/celestial-system';
import type { DisplayWindow } from './display-window-manager';
import type { FloatingOrigin } from './camera/floating-origin';
import type { WorldViewFrame } from './world-view';

export class CombatView implements WorldViewFrame {
  constructor(
    private readonly input: Input,
    private readonly cameraSystem: CameraSystem,
    private readonly targeter: Targeter,
    private readonly mapActions: MapContextActions,
    private readonly dynamicSystem: DynamicSystem,
    private readonly celestialMarkers: CelestialMarkers,
    private readonly touchControls: TouchControls | null,
    private readonly activePlayers: ActiveControllableController,
    private readonly dockingGuide: DockingGuide,
    private readonly guide: PlanGuide,
    private readonly planPath: PlanPath,
    private readonly celestialSystem: CelestialSystem,
    private readonly simSpeedManager: SimSpeedManager,
    private readonly hud: Hud,
  ) {}

  // 戦闘ビューは操作対象(艦または基地)が必要。
  canEnter(): boolean {
    return this.activePlayers.currentControllable !== null;
  }

  onEnter(): void {}

  // 戦闘専用の表示物を畳む。
  onLeave(): void {
    this.dockingGuide.hide();
  }

  // 計画キー: [Del] は計画全体の破棄、[N] は直近ノードへの自動ワープのトグル。
  handleInput(input: Input, _dt: number, simTime: number): void {
    if (input.takeKey(K.deleteNode)) this.clearPlan();
    if (input.takeKey(K.autoWarpToNode)) {
      const plan = this.activePlayers.currentControllable?.plan;
      this.simSpeedManager.toggleAutoWarpToFirstNode(plan?.firstNode(), simTime);
    }
  }

  // 確定済みのマニューバ計画を破棄し、進行中の自動ワープも解く。
  private clearPlan(): void {
    const plan = this.activePlayers.currentControllable?.plan;
    if (!plan || plan.nodes.length <= 0) return;
    plan.clear();
    this.simSpeedManager.cancelAutoWarp();
    this.hud.hint('マニューバ計画を破棄');
  }

  // 照準キーと右クリックの配分。操作艦がいなければ照準先が無いので配らない。
  handlePointer(simTime: number): void {
    const player = this.activePlayers.current;
    if (!player) return;
    const project = this.cameraSystem.activeCameraProjection;
    const combatTargets = this.dynamicSystem.getCombatTargets(player);
    this.targeter.handleTargetSelectKey(this.input, combatTargets, project);
    this.mapActions.handleCombatRightClick(this.input, simTime);
  }

  // 直近ノードの消化・接近通知を進める。
  update(displayWindow: DisplayWindow): void {
    this.guide.update(
      this.activePlayers.current, displayWindow.simTime, this.celestialSystem.celestialMotions,
    );
  }

  // 天体ラベルはマップ専用の表示なので、戦闘ビューの間は畳んでおく。
  syncLabels(): void {
    this.celestialMarkers.hideLabels();
  }

  // 戦闘ビュー専用の常設表示(タッチのモードボタン・ノード実行ガイド・ドッキングガイド)。
  syncPanels(displayWindow: DisplayWindow, fo: FloatingOrigin): void {
    const player = this.activePlayers.current;
    if (player) {
      this.touchControls?.syncModeButtons(
        player.rcsDamp, player.fineAttitude, player.progradeHold,
        (key) => player.throttle.isThrustLatched(key),
      );
    }
    const project = this.cameraSystem.activeCameraProjection;
    this.guide.sync(player, displayWindow.simTime, project, this.planPath);
    this.dockingGuide.sync(player, fo, project);
  }

  dispose(): void {
    this.dockingGuide.dispose();
  }
}
