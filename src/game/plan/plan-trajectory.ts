// 操作対象の計画折れ線表示の駆動(両ビュー共通)。どの計画をいつ描くかを決めて PlanDisplay へ
// 流し込み、計画パス上の操作対象の赤道交点と、予測へ伸ばす計画区間の弧を答える。
import type * as THREE from 'three/webgpu';
import type { MarkerManager } from '../marker/marker-manager';
import type { CelestialSystem } from '../celestial/celestial-system';
import type { CameraSystem } from '../camera/camera-system';
import type { FloatingOrigin } from '../camera/floating-origin';
import type { ActivePlayerController } from '../active-controllable-controller';
import type { WorldView } from '../view-manager';
import type { FrameAnchorSource } from '../../physics/frame';
import type { PredictedArc } from '../dynamic/predicted-arc';
import type { PerfCounts } from '../../perf-meter';
import { DisplayDurationSource, PlanData } from './plan';
import { PlanDisplay } from './plan-display';
import { DisplayWindow, timeLabelSettingOf } from '../display-window-manager';

export class PlanTrajectory {
  readonly planDisplay: PlanDisplay;

  constructor(
    scene: THREE.Scene,
    private readonly markerManager: MarkerManager,
    private readonly celestialSystem: CelestialSystem,
    displayDuration: DisplayDurationSource,
    private readonly activePlayers: ActivePlayerController,
  ) {
    this.planDisplay = new PlanDisplay(scene, markerManager, celestialSystem, displayDuration);
  }

  // 計画折れ線を再積分し、ゴースト位置・アプシスアイコン・操作対象の赤道交点を求め直す。
  // 折れ線は戦闘ビューでも描く — 計画どおりに機体を動かすのは戦闘ビューだから。
  update(displayWindow: DisplayWindow, frameAnchors: FrameAnchorSource, view: WorldView): void {
    const ship = this.activePlayers.currentControllable;
    this.planDisplay.update(
      this.displayedPlan(view), displayWindow, this.celestialSystem, ship, frameAnchors,
    );
    this.updateEquatorNodes(displayWindow, frameAnchors);
  }

  // 操作対象の赤道交点マーカーを、いま描かれている計画の折れ線の上で求め直す。折れ線が
  // 出ていない間は現在の軌道要素から求める。
  private updateEquatorNodes(displayWindow: DisplayWindow, frameAnchors: FrameAnchorSource): void {
    const ship = this.activePlayers.currentControllable;
    if (!ship) return;
    const timeLabel = timeLabelSettingOf(displayWindow);
    ship.ensureEquatorNodes(this.markerManager).updateOnPath(
      displayWindow.frame, displayWindow.displayTime, this.celestialSystem, frameAnchors,
      ship.state, this.planDisplay.path.displayedSamples(), timeLabel,
    );
  }

  // 計画折れ線と付随マーカーを同期する。
  sync(cameraSystem: CameraSystem, fo: FloatingOrigin): void {
    if (this.displayedPlan(cameraSystem.worldView) !== null) {
      this.planDisplay.sync(
        fo, cameraSystem.activeCameraProjection, cameraSystem.activeCameraScale,
        cameraSystem.worldView, cameraSystem.activeCameraPos, cameraSystem.activeCamera,
      );
    } else {
      this.planDisplay.hide();
    }
  }

  // Predictor の予算パスへ渡す、このフレーム owned な計画区間の弧。表示していない計画の弧は
  // 伸ばさない。
  growableArcs(view: WorldView): readonly PredictedArc[] {
    return this.displayedPlan(view) === null ? [] : this.planDisplay.path.growableArcs();
  }

  // 負荷確認ウィンドウが読む、直近フレームに作り直した計画区間の本数。
  perfCounts(): Pick<PerfCounts, 'planArcs'> {
    return { planArcs: this.planDisplay.path.lastRebuiltArcs };
  }

  dispose(): void {
    this.planDisplay.dispose();
  }

  // このフレームに出す折れ線の材料。出す価値のある折れ線が無ければ null — ノードの無い計画は
  // 操作対象の現在軌道そのものなので、ノードを置ける編集中(マップビュー)だけ出す。
  private displayedPlan(view: WorldView): PlanData | null {
    const ship = this.activePlayers.currentControllable;
    if (ship === null) return null;
    if (view !== 'map' && ship.plan.nodes.length === 0) return null;
    return ship.plan.displayData(ship.state);
  }
}
