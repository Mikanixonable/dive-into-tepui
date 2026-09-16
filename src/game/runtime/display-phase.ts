import type { Input } from '../../input/input';
import type { Viewport } from '../../render/viewport';
import type { CameraSystem } from '../camera/camera-system';
import type { Controllable } from '../dynamic/dynamic-entity/controllable';
import type { DynamicSystem } from '../dynamic/dynamic-system';
import type { CelestialSystem } from '../celestial/celestial-system';
import type { DisplayWindowManager } from '../display-window-manager';
import type { EntityLineManager } from '../lines/entity-line-manager';
import type { PlanDisplay } from '../plan/plan-display';
import type { Predictor } from '../dynamic/predictor';
import type { FrameAnchors } from '../frame-anchors';
import type { EquatorNodeManager } from '../marker/equator-node-manager';
import type { Targeter } from '../targeter';
import type { ViewManager } from '../view/view-manager';
import type { Hud } from '../hud/hud';
import type { NavTarget } from '../nav-target';
import type { MapDisplayToggles } from '../map/display-toggles';
import type { RunSetting } from '../run-setting';
import { MapVisibilityPolicy } from '../map/visibility-policy';
import type { FrameSections } from '../frame-sections';
import { SECTION } from '../frame-sections';
import type { ApproachTargetSource } from '../hud/orbit/orbit-analysis-data';
import { aliveCombatTarget } from '../dynamic/dynamic-entity/combat-target';

// 表示時刻窓を確定し、予測・カメラ・ビュー候補を同じ窓へそろえる表示フェーズ。
export class DisplayPhase {
  public constructor(
    private readonly input: Input,
    private readonly sections: FrameSections,
    private readonly hud: Hud,
    private readonly displayWindowManager: DisplayWindowManager,
    private readonly dynamicSystem: DynamicSystem,
    private readonly celestialSystem: CelestialSystem,
    private readonly frameAnchors: FrameAnchors,
    private readonly planDisplay: PlanDisplay,
    private readonly predictor: Predictor,
    private readonly equatorNodes: EquatorNodeManager,
    private readonly cameraSystem: CameraSystem,
    private readonly viewManager: ViewManager,
    private readonly targeter: Targeter,
    private readonly entityLines: EntityLineManager,
    private readonly navTarget: NavTarget,
    private readonly mapDisplay: RunSetting<MapDisplayToggles>,
    private readonly isPaused: () => boolean,
  ) {}

  // 表示窓 → 計画/予測/交点 → カメラ → ビュー候補 → ポインタの順に更新する。
  public update(active: Controllable | null, dt: number, viewport: Viewport): void {
    const displayWindow = this.displayWindowManager.resolve(this.dynamicSystem.simTime, active);
    this.dynamicSystem.requestHistoryDuration(displayWindow.pastDuration);
    const view = this.viewManager.current;
    const canDisplayFuture = !this.displayWindowManager.forceCurrent;

    this.frameAnchors.update(displayWindow.displayTime);
    this.sections.enter(SECTION.plan);
    this.planDisplay.update(displayWindow, this.frameAnchors, view);
    this.sections.exit(SECTION.plan);

    const analysisTarget = this.resolveOrbitAnalysisTarget();
    this.hud.updateAnalysisReaders({
      entity: active,
      targetEntity: analysisTarget?.kind === 'entity' ? analysisTarget.entity : null,
    });

    this.sections.enter(SECTION.predict);
    this.predictor.update(
      this.dynamicSystem.simTime, this.dynamicSystem.lastSimDt,
      active?.motion ?? null, displayWindow.duration,
      canDisplayFuture, this.planDisplay.growableArcs(),
    );
    this.sections.exit(SECTION.predict);

    this.sections.enter(SECTION.plan);
    const equatorVisibility = this.cameraSystem.view === 'map'
      ? new MapVisibilityPolicy(
        this.celestialSystem, this.mapDisplay.current,
      )
      : null;
    this.equatorNodes.update({
      displayTime: displayWindow.displayTime,
      celestialBodies: this.celestialSystem,
      frameAnchors: this.frameAnchors,
      paths: this.planDisplay,
    }, active, equatorVisibility);
    this.sections.exit(SECTION.plan);

    this.sections.enter(SECTION.camera);
    this.cameraSystem.update(
      displayWindow.displayTime, this.input, dt, this.viewManager.activeView.pickables,
      this.frameAnchors, active, viewport,
    );
    this.sections.exit(SECTION.camera);

    this.sections.enter(SECTION.mapPick);
    this.viewManager.activeView.update(displayWindow);
    this.sections.exit(SECTION.mapPick);

    this.sections.enter(SECTION.pointer);
    if (!this.isPaused() && !this.hud.overlayManager.isInputGated()) {
      this.viewManager.activeView.handlePointer(this.dynamicSystem.simTime, viewport);
    }
    this.sections.exit(SECTION.pointer);

    this.entityLines.updatePredictionReaders(
      active,
      this.targeter.aliveTarget,
      this.viewManager.current,
      displayWindow,
      this.viewManager.activeView.visibilityPolicy,
    );
  }

  private resolveOrbitAnalysisTarget(): ApproachTargetSource | null {
    const id = this.navTarget.id;
    if (id === null) return null;
    const body = this.celestialSystem.find(id)?.motion;
    if (body !== undefined) return { kind: 'celestialBody', body };
    const entity = aliveCombatTarget(this.dynamicSystem.all(), id);
    return entity ? { kind: 'entity', entity } : null;
  }
}
