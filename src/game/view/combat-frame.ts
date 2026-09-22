// 戦闘ビュー専用のフレーム処理と遷移フック(ViewFrame の具象)。
import { pickCombatEntityAtPoint } from '../pickable/combat-pick';
import type { PlanGuide } from '../plan/plan-guide';
import type { Input } from '../../input/input';
import type { TouchControls } from '../hud/touch-controls';
import type { EntityRoster } from '../dynamic/entity-roster';
import type { ObjectWindows } from '../pickable/object-windows';
import type { Targeter } from '../targeter';
import type { ControlSelection } from '../control-selection';
import type { PlanPath } from '../plan/plan-path';

import type { DisplayWindow } from '../display-window-manager';
import type { CameraFrame } from '../../render/camera/camera-frame';
import type { ViewFrame } from './view-frame';
import type { ObjectPickable } from '../pickable/object-pickable';
import { objectPickableOf } from '../pickable/object-pickable';
import type { PerfCounts } from '../perf-counts';
import type { CelestialMarkers } from '../marker/celestial-markers';

export class CombatFrame implements ViewFrame {
  public constructor(
    private readonly input: Input,
    private readonly targeter: Targeter,
    private readonly objectWindows: ObjectWindows,
    private readonly roster: EntityRoster,
    private readonly celestialMarkers: CelestialMarkers,
    private readonly touchControls: TouchControls | null,
    private readonly controlSelection: ControlSelection,
    private readonly planPath: PlanPath,
    private readonly planGuide: PlanGuide,
  ) {}

  public readonly pickables: readonly ObjectPickable[] = [];
  public readonly visibilityPolicy = null;
  public readonly planEditor = null;

  // マップの計測値は、戦闘ビューでは常に 0。
  public perfCounts(): Pick<PerfCounts, 'mapMode' | 'mapItems' | 'mapLabels'> {
    return { mapMode: false, mapItems: 0, mapLabels: 0 };
  }

  public onEnter(): void {}

  public onLeave(): void {}

  public handleCommand(): void {}

  public updateActions(): void {}

  // 照準キーと右クリック入力をルーティングする。操作対象がいなければ照準先が無いので何もしない。
  public handlePointer(camera: CameraFrame): void {
    const controlled = this.controlSelection.current;
    if (!controlled) return;
    this.targeter.handleTargetSelect(controlled, camera.project, camera.viewport);
    // 右クリックは実体に当たればそのプロパティウィンドウを、外れれば空域メニューを開く。
    this.input.takeRightClicks((p) => {
      const hit = pickCombatEntityAtPoint(
        this.roster, camera.viewpoint, camera.project, p.x, p.y, camera.viewport);
      const inspected = hit ? objectPickableOf(hit) : null;
      if (inspected) this.objectWindows.open(p.x, p.y, inspected);
      else this.objectWindows.openEmptySpaceMenu(p.x, p.y);
      return true;
    });
  }

  public update(): void {}

  // 天体ラベルはマップ専用の表示なので、戦闘ビューの間は畳んでおく。
  public syncLabels(_displayWindow: DisplayWindow, _camera: CameraFrame, nowMs: number): void {
    this.celestialMarkers.hideLabels(nowMs);
  }

  // 戦闘ビュー専用の常設表示(タッチのモードボタン・ノード実行ガイド)。
  public syncPanels(displayWindow: DisplayWindow, camera: CameraFrame, nowMs: number): void {
    const controlled = this.controlSelection.current;
    if (controlled) {
      this.touchControls?.syncModeButtons(
        controlled.throttle.rcsDamp, controlled.fineAttitude, controlled.throttle.progradeHold,
        (key) => controlled.throttle.isThrustLatched(key),
      );
    }
    this.planGuide.sync(controlled, displayWindow.simTime, camera, this.planPath, nowMs);
  }

  public dispose(): void {}
}
