// 戦闘ビュー専用のフレーム処理と遷移フック(ViewFrame の具象)。
import { KEY_MAPPING as K } from '../../input/key-mapping';
import type { CelestialBody } from '../../physics/celestial-body';
import { pickCombatEntityAtPoint } from '../pickable/combat-pick';
import { PlanGuide } from '../plan/plan-guide';
import type { Input } from '../../input/input';
import type { Notifier } from '../../hud/notifier';
import type { SimSpeedManager } from '../dynamic/sim-speed-manager';
import type { TouchControls } from '../hud/touch-controls';
import type { CameraSystem } from '../camera/camera-system';
import type { Viewport } from '../../render/viewport';
import type { EntityRoster } from '../dynamic/entity-roster';
import type { ObjectWindows } from '../pickable/object-windows';
import type { MarkerSlots } from '../marker/marker-slots';
import type { Targeter } from '../targeter';
import type { ControlSelection } from '../control-selection';
import type { PlanPath } from '../plan/plan-path';
import type { UiSfx } from '../../audio/sfx/ui-sfx';

import type { DisplayWindow } from '../display-window-manager';
import type { CameraFrame } from '../../render/camera/camera-frame';
import type { ViewFrame } from './view-frame';
import type { ObjectPickable } from '../pickable/object-pickable';
import type { PerfCounts } from '../perf-counts';
import type { CelestialLabelHiding } from '../marker/celestial-label-hiding';

export class CombatView implements ViewFrame {
  private readonly planGuide: PlanGuide;

  // 直近ノードの実行ガイドを、受け取った材料から組んで持つ。
  public constructor(
    private readonly input: Input,
    private readonly cameraSystem: CameraSystem,
    private readonly targeter: Targeter,
    private readonly objectWindows: ObjectWindows,
    private readonly roster: EntityRoster,
    private readonly celestialLabels: CelestialLabelHiding,
    private readonly touchControls: TouchControls | null,
    private readonly controlSelection: ControlSelection,
    private readonly planPath: PlanPath,
    private readonly celestialBodies: readonly CelestialBody[],
    private readonly simSpeedManager: SimSpeedManager,
    private readonly notifier: Notifier,
    uiSfx: UiSfx,
    markers: MarkerSlots,
  ) {
    this.planGuide = new PlanGuide(notifier, uiSfx, markers);
  }

  public readonly pickables: readonly ObjectPickable[] = [];
  public readonly visibilityPolicy = null;
  public readonly planEditor = null;

  // マップの計測値は、戦闘ビューでは常に 0。
  public perfCounts(): Pick<PerfCounts, 'mapMode' | 'mapItems' | 'mapLabels'> {
    return { mapMode: false, mapItems: 0, mapLabels: 0 };
  }

  // 戦闘ビューは操作対象(艦または基地)が必要。
  public canEnter(): boolean {
    return this.controlSelection.current !== null;
  }

  public onEnter(): void {}

  public onLeave(): void {}

  // 計画キー: [Del] は計画全体の破棄、[N] は直近ノードへの自動ワープのトグル。
  public handleInput(input: Input, _dt: number, simTime: number): void {
    if (input.takeKey(K.deleteNode)) this.clearPlan();
    if (input.takeKey(K.autoWarpToNode)) {
      const plan = this.controlSelection.current?.plan;
      this.simSpeedManager.toggleAutoWarpToFirstNode(plan?.firstNode(), simTime);
    }
  }

  // 確定済みのマニューバ計画を破棄し、進行中の自動ワープも解く。
  private clearPlan(): void {
    const plan = this.controlSelection.current?.plan;
    if (!plan || plan.nodes.length <= 0) return;
    plan.clear();
    this.simSpeedManager.cancelAutoWarp();
    this.notifier.hint('マニューバ計画を破棄');
  }

  // 照準キーと右クリックを配る。操作対象がいなければ照準先が無いので何もしない。
  public handlePointer(simTime: number, viewport: Viewport): void {
    const controlled = this.controlSelection.current;
    if (!controlled) return;
    const project = this.cameraSystem.activeProjection(viewport);
    this.targeter.handleTargetSelectKey(this.input, controlled, project, viewport);
    // 右クリックは実体に当たればそのプロパティウィンドウを、外れれば空域メニューを開く。
    this.input.takeRightClicks((p) => {
      const hit = pickCombatEntityAtPoint(
        this.roster, this.cameraSystem.activeViewpoint, project, p.x, p.y, viewport);
      if (hit) this.objectWindows.open(p.x, p.y, hit, simTime);
      else this.objectWindows.openEmptySpaceMenu(p.x, p.y, simTime);
      return true;
    });
  }

  // 直近ノードの消化・接近通知を進める。
  public update(displayWindow: DisplayWindow): void {
    this.planGuide.update(
      this.controlSelection.current, displayWindow.simTime, this.celestialBodies,
    );
  }

  // 天体ラベルはマップ専用の表示なので、戦闘ビューの間は畳んでおく。
  public syncLabels(): void {
    this.celestialLabels.hideLabels();
  }

  // 戦闘ビュー専用の常設表示(タッチのモードボタン・ノード実行ガイド)。
  public syncPanels(displayWindow: DisplayWindow, camera: CameraFrame): void {
    const controlled = this.controlSelection.current;
    if (controlled) {
      this.touchControls?.syncModeButtons(
        controlled.throttle.rcsDamp, controlled.fineAttitude, controlled.throttle.progradeHold,
        (key) => controlled.throttle.isThrustLatched(key),
      );
    }
    this.planGuide.sync(controlled, displayWindow.simTime, camera.project, this.planPath);
  }

  public dispose(): void {}
}
