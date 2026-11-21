// 進行後の表示時刻・座標系・カメラ材料を確定し、予測後の表示候補を更新する phase。表示の導出だけを
// 行い、同期先の DOM・GPU 資源やゲーム進行の正本は所有しない。
import type { EquatorNodeManager } from '../game/marker/equator-node-manager';
import type { CameraSystem } from '../game/camera/camera-system';
import { type DisplayWindowManager, trajectoryDemandOf } from '../game/display-window-manager';
import type { FlashPresenter } from '../game/flash-presenter';
import type { FrameAnchors } from '../game/frame-anchors';
import type { PlanDisplay } from '../game/plan/plan-display';
import type { Targeter } from '../game/targeter';
import type { ViewManager } from '../game/view/view-manager';
import { SECTION, type FrameSections } from '../game/frame-sections';
import type { CameraFrameSamples } from '../game/viewer/camera-selection';
import type { TrajectoryDemand } from '../game/dynamic/trajectory-demand';
import type { Viewport } from '../render/viewport';
import type { CelestialBodies } from '../game/celestial/celestial-bodies';
import type { Controllable } from '../game/dynamic/entity/controllable';
import type { RunEvent } from '../game/run-events';

export interface DisplayPhaseSource {
  readonly simTime: number;
  readonly activeControllable: Controllable | null;
  readonly recentEvents: readonly RunEvent[];
  readonly celestialSystem: CelestialBodies;
  readonly navTargetId: string | null;
}

export class DisplayPhase {
  public constructor(
    private readonly source: DisplayPhaseSource,
    private readonly displayWindowManager: DisplayWindowManager,
    private readonly viewManager: ViewManager,
    private readonly frameAnchors: FrameAnchors,
    private readonly cameraSystem: CameraSystem,
    private readonly flashPresenter: FlashPresenter,
    private readonly targeter: Targeter,
    private readonly planDisplay: PlanDisplay,
    private readonly equatorNodes: EquatorNodeManager,
    private readonly sections: FrameSections,
  ) {}

  // 進行の直後に、ビューの切替とこのフレームの表示窓を確定させ、座標系の錨を表示時刻へ合わせる。
  // ポーズ中も決着後も通す — 決着後も積分は進むので、飛ばすと追従対象がカメラから流れ去る。
  public resolveFrame(): void {
    this.viewManager.sync();
    const displayWindow = this.displayWindowManager.resolve(
      this.source.simTime, this.source.activeControllable, this.viewManager.current !== 'map',
    );
    this.anchorFrameAt(displayWindow.displayTime);
  }

  // 座標系の錨が天体を引く時刻 time [s] を差し込む。以降の座標系の変換はすべてこの錨を通す。
  public anchorFrameAt(time: number): void {
    this.frameAnchors.update(time);
  }

  // 錨を合わせた時刻での、視点の追従の材料。
  public cameraSamples(): CameraFrameSamples {
    return this.cameraSystem.sampleProgress(this.frameAnchors.bodiesPivot, this.frameAnchors);
  }

  // 一時エフェクト・的通過マーク・計画表示を、進行が記録した出来事と計画から表示時刻で組み直す(R5)。
  public presentProgress(): void {
    const displayWindow = this.displayWindowManager.current;
    const events = this.source.recentEvents;
    this.sections.enter(SECTION.effects);
    this.flashPresenter.present(events, displayWindow.displayTime, this.cameraSystem.zoomActive);
    this.targeter.updateBoardMarks(events, this.source.activeControllable, displayWindow.displayTime);
    this.sections.exit(SECTION.effects);
    this.sections.enter(SECTION.plan);
    this.planDisplay.update(displayWindow, this.frameAnchors, this.viewManager.current);
    this.sections.exit(SECTION.plan);
  }

  // 予測と履歴をどこまで計算してほしいかの需要(R4)。
  public trajectoryDemand(): TrajectoryDemand {
    return trajectoryDemandOf(this.displayWindowManager.current, this.planDisplay.growableArcs());
  }

  // 予測を伸ばした後の導出: 赤道交点、カメラ、選択候補をこの順に同じ時刻の状態へ更新する。
  // nowMs [ms] はフレームの実時刻。
  public update(nowMs: number, viewport: Viewport): void {
    const displayWindow = this.displayWindowManager.current;
    // 交点は計画折れ線か予測の楕円の上に置くので、両方を組み終えた後に通す。
    this.sections.enter(SECTION.plan);
    this.equatorNodes.update({
      displayTime: displayWindow.displayTime,
      celestialBodies: this.source.celestialSystem,
      frameAnchors: this.frameAnchors,
      paths: this.planDisplay,
    }, this.source.activeControllable, this.source.navTargetId, this.viewManager.current);
    this.sections.exit(SECTION.plan);
    this.sections.enter(SECTION.camera);
    this.cameraSystem.update(
      this.viewManager.activeView.pickables, this.source.activeControllable, viewport, nowMs,
    );
    this.sections.exit(SECTION.camera);
    // 候補列は遮蔽判定にカメラ位置を読むので、カメラの更新より後に組む。
    this.sections.enter(SECTION.mapPick);
    this.viewManager.activeView.update(displayWindow);
    this.sections.exit(SECTION.mapPick);
  }
}
