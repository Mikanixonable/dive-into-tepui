// 戦闘ビュー専用のフレーム処理と遷移フック(ViewFrame の具象)。呼ぶ位置と順序は
// Game / ViewManager が持つ。
import { KEY_MAPPING as K } from '../../input/key-mapping';
import { pickCombatEntityAtPoint } from '../pickable/combat-pick';
import { PlanGuide } from '../plan/plan-guide';
import type { Input } from '../../input/input';
import type { Hud } from '../hud/hud';
import type { SimSpeedManager } from '../dynamic/sim-speed-manager';
import type { TouchControls } from '../hud/touch-controls';
import type { CameraSystem } from '../camera/camera-system';
import type { DynamicSystem } from '../dynamic/dynamic-system';
import type { ObjectWindows } from '../pickable/object-windows';
import type { CelestialMarkers } from '../marker/celestial-markers';
import type { MarkerManager } from '../marker/marker-manager';
import type { Targeter } from '../targeter';
import type { ActiveControllableController } from '../active-controllable-controller';
import type { DockingGuide } from '../docking/docking-guide';
import type { PlanPath } from '../plan/plan-path';
import type { UiSfx } from '../../audio/sfx/ui-sfx';
import type { CelestialSystem } from '../celestial/celestial-system';
import type { DisplayWindow } from '../display-window-manager';
import type { FloatingOrigin } from '../camera/floating-origin';
import type { ViewFrame } from './view';
import type { ObjectPickable } from '../pickable/object-pickable';
import type { PerfCounts } from '../perf-counts';

export class CombatView implements ViewFrame {
  private readonly planGuide: PlanGuide;

  // 直近ノードの実行ガイドは戦闘ビューにいる間しか出さないので、受け取った材料から
  // ここで組んで持つ。
  public constructor(
    private readonly input: Input,
    private readonly cameraSystem: CameraSystem,
    private readonly targeter: Targeter,
    private readonly objectWindows: ObjectWindows,
    private readonly dynamicSystem: DynamicSystem,
    private readonly celestialMarkers: CelestialMarkers,
    private readonly touchControls: TouchControls | null,
    private readonly activePlayers: ActiveControllableController,
    private readonly dockingGuide: DockingGuide,
    private readonly planPath: PlanPath,
    private readonly celestialSystem: CelestialSystem,
    private readonly simSpeedManager: SimSpeedManager,
    private readonly hud: Hud,
    uiSfx: UiSfx,
    markerManager: MarkerManager,
  ) {
    this.planGuide = new PlanGuide(hud, uiSfx, markerManager);
  }

  public readonly pickables: readonly ObjectPickable[] = [];
  public readonly visibilityPolicy = null;

  public perfCounts(): Pick<PerfCounts, 'mapMode' | 'mapItems' | 'mapLabels'> {
    return { mapMode: false, mapItems: 0, mapLabels: 0 };
  }

  // 戦闘ビューは操作対象(艦または基地)が必要。
  public canEnter(): boolean {
    return this.activePlayers.currentControllable !== null;
  }

  public onEnter(): void {}

  // 戦闘専用の表示物を畳む。
  public onLeave(): void {
    this.dockingGuide.hide();
  }

  // 計画キー: [Del] は計画全体の破棄、[N] は直近ノードへの自動ワープのトグル。
  public handleInput(input: Input, _dt: number, simTime: number): void {
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
  // 右クリックは実体に当たればそのプロパティウィンドウを、外れれば空域メニューを開く。
  public handlePointer(simTime: number): void {
    const player = this.activePlayers.current;
    if (!player) return;
    const project = this.cameraSystem.activeCameraProjection;
    const combatTargets = this.dynamicSystem.getCombatTargets(player);
    this.targeter.handleTargetSelectKey(this.input, combatTargets, project);
    this.input.takeRightClicks((p) => {
      const hit = pickCombatEntityAtPoint(
        this.dynamicSystem, this.cameraSystem.activeViewpoint, project, p.x, p.y);
      if (hit) this.objectWindows.open(p.x, p.y, hit, simTime);
      else this.objectWindows.openEmptySpaceMenu(p.x, p.y, simTime);
      return true;
    });
  }

  // 直近ノードの消化・接近通知を進める。
  public update(displayWindow: DisplayWindow): void {
    this.planGuide.update(
      this.activePlayers.current, displayWindow.simTime, this.celestialSystem.celestialMotions,
    );
  }

  // 天体ラベルはマップ専用の表示なので、戦闘ビューの間は畳んでおく。
  public syncLabels(): void {
    this.celestialMarkers.hideLabels();
  }

  // 戦闘ビュー専用の常設表示(タッチのモードボタン・ノード実行ガイド・ドッキングガイド)。
  public syncPanels(displayWindow: DisplayWindow, fo: FloatingOrigin): void {
    const player = this.activePlayers.current;
    if (player) {
      this.touchControls?.syncModeButtons(
        player.rcsDamp, player.fineAttitude, player.progradeHold,
        (key) => player.throttle.isThrustLatched(key),
      );
    }
    const project = this.cameraSystem.activeCameraProjection;
    this.planGuide.sync(player, displayWindow.simTime, project, this.planPath);
    this.dockingGuide.sync(player, fo, project);
  }

  public dispose(): void {}
}
