import type * as THREE from 'three/webgpu';
import type { GraphicsSettingsData } from '../../render/graphics-settings';
import type { RenderStyle } from '../../render/render-style';
import type { Viewport } from '../../render/viewport';
import type { GpuTimingSink } from '../../render/gpu-timings';
import type { CameraFrame } from '../../render/camera/camera-frame';
import type { CameraView } from '../../render/camera/camera-view';
import type { CelestialGridVisibility } from '../../render/celestial-grid';
import type { Hud } from '../hud/hud';
import type { Stage } from '../stages/stage';
import type { Controllable } from '../dynamic/dynamic-entity/controllable';
import type { DynamicSystem } from '../dynamic/dynamic-system';
import type { CelestialSystem } from '../celestial/celestial-system';
import type { CameraSystem } from '../camera/camera-system';
import type { ViewManager } from '../view/view-manager';
import type { EquatorNodeManager } from '../marker/equator-node-manager';
import type { FlashEffectsView } from '../../render/vfx/flash-effects-view';
import type { Targeter } from '../targeter';
import type { NavTarget } from '../nav-target';
import type { ObjectWindows } from '../pickable/object-windows';
import type { PlanDisplay } from '../plan/plan-display';
import type { EntityLineManager } from '../lines/entity-line-manager';
import type { FrameAnchors } from '../frame-anchors';
import type { DisplayWindowManager } from '../display-window-manager';
import type { SimSpeedManager } from '../dynamic/sim-speed-manager';
import type { MarkerManager } from '../marker/marker-manager';
import type { ViewBadge } from '../hud/view-badge';
import type { FlashEffects } from '../vfx/flash-effects';
import type { CelestialMarkers } from '../marker/celestial-markers';
import type { WorldSfx } from '../../audio/sfx/world-sfx';
import type { ViewOptionsControl } from '../hud/panels/view-options-control';
import type { RunSetting } from '../run-setting';
import type { MapDisplayToggles } from '../map/display-toggles';
import type { OrbitGuideSettings } from '../celestial/orbit-guide/orbit-guide-settings';
import type { OrbitReferenceSelector } from '../orbit-reference';
import type { ApproachTargetSource } from '../hud/orbit/orbit-analysis-data';
import type { OrbitAnalysisViewModel } from '../hud/orbit/orbit-analysis-window';
import type { TopBarViewModel } from '../hud/panels/top-bar';
import type { OrbitPanelViewModel } from '../hud/orbit/orbit-panel';
import type { VesselPanelViewModel } from '../hud/panels/vessel-panel';
import type { TargetPanelViewModel } from '../hud/panels/target-panel';
import { enemiesPanelView } from '../hud/panels/enemies-panel-data';
import { orbitInfo, relativeInfo } from '../orbit-info';
import { aliveCombatTarget } from '../dynamic/dynamic-entity/combat-target';
import { ProteinEnemy } from '../dynamic/dynamic-entity/protein-enemy';
import { MAX_DYN_PRESSURE } from '../player/aero-load';
import { MAX_HULL_TEMP } from '../dynamic/dynamic-entity/ship';
import { SIM_SPEED_LEVELS } from '../dynamic/sim-speed-manager';
import { timeLabelSettingOf } from '../display-window-manager';
import { syncControlledLoopSfx } from '../controlled-loop-sfx';

// sync の順序と、ゲーム状態から各表示入力を組む責務を所有する。
export class PresentationPhase {
  private cameraFrame: CameraFrame | null = null;

  public constructor(
    private readonly renderer: THREE.WebGPURenderer,
    private readonly gpu: GpuTimingSink,
    private readonly cameraView: CameraView,
    private readonly hud: Hud,
    private readonly activeStage: Stage,
    private readonly celestialSystem: CelestialSystem,
    private readonly dynamicSystem: DynamicSystem,
    private readonly cameraSystem: CameraSystem,
    private readonly viewManager: ViewManager,
    private readonly viewOptions: ViewOptionsControl,
    private readonly mapDisplay: RunSetting<MapDisplayToggles>,
    private readonly grid: RunSetting<CelestialGridVisibility>,
    private readonly orbitGuide: RunSetting<OrbitGuideSettings>,
    private readonly orbitReference: OrbitReferenceSelector,
    private readonly equatorNodes: EquatorNodeManager,
    private readonly frameAnchors: FrameAnchors,
    private readonly worldSfx: WorldSfx,
    private readonly flashEffectsView: FlashEffectsView,
    private readonly targeter: Targeter,
    private readonly navTarget: NavTarget,
    private readonly objectWindows: ObjectWindows,
    private readonly planDisplay: PlanDisplay,
    private readonly entityLines: EntityLineManager,
    private readonly displayWindowManager: DisplayWindowManager,
    private readonly simSpeedManager: SimSpeedManager,
    private readonly markerManager: MarkerManager,
    private readonly viewBadge: ViewBadge,
    private readonly flashEffects: FlashEffects,
    private readonly celestialMarkers: CelestialMarkers,
    private readonly activeControllable: () => Controllable | null,
    private readonly isPaused: () => boolean,
  ) {}

  public get currentCameraFrame(): CameraFrame | null {
    return this.cameraFrame;
  }

  // camera frame → 天体/動的物体 → マーカー/線 → stage/HUD → marker collision の順で同期する。
  public sync(graphics: GraphicsSettingsData, style: RenderStyle, viewport: Viewport): void {
    const controlled = this.activeControllable();
    const displayWindow = this.displayWindowManager.current;
    this.viewBadge.sync(
      this.activeStage.stageClass.selectLabel, this.cameraSystem.activeFocus,
      controlled, this.navTarget.name,
    );

    const { displayTime, simTime } = displayWindow;
    const celestialBodies = this.celestialSystem.celestialMotions;
    const camera = this.cameraView.sync(
      this.cameraSystem.activeViewpoint, this.cameraSystem.clipFovDeg, this.cameraSystem.clipDistance,
      viewport, this.cameraSystem.view, this.cameraSystem.zoomActive, this.cameraSystem.focusVelocity,
    );
    this.cameraFrame = camera;

    this.viewOptions.setVisible(this.viewManager.current === 'map');
    this.viewManager.activeView.syncLabels(displayWindow, camera);
    const visibilityPolicy = this.viewManager.activeView.visibilityPolicy;
    const orbitRef = controlled
      ? this.orbitReference.resolve(
        controlled.motion.state.r, celestialBodies, this.navTarget,
        this.dynamicSystem, this.celestialSystem, controlled.motion.state.t,
      )
      : undefined;

    this.celestialSystem.sync(
      displayTime, camera, this.cameraSystem, graphics, style,
      this.mapDisplay.current, this.grid.current, this.orbitGuide.current, visibilityPolicy, this.markerManager,
    );
    this.viewOptions.setOrbitGuideLineCount(this.celestialSystem.orbitGuide.lineCount);
    this.celestialSystem.bakeClouds(this.renderer, displayTime, this.gpu);

    const timeLabel = timeLabelSettingOf(displayWindow);
    this.dynamicSystem.sync(
      displayTime, controlled, visibilityPolicy, camera, style, graphics,
      orbitRef,
    );
    this.equatorNodes.sync(
      camera.project,
      camera.position,
      this.frameAnchors.bodies,
      this.frameAnchors.bodiesPivot,
      camera.mode === 'map',
      timeLabel,
    );
    syncControlledLoopSfx(this.worldSfx, controlled, displayTime, visibilityPolicy);
    this.flashEffectsView.sync(this.flashEffects.live, camera);

    this.targeter.sync(
      controlled, camera, displayTime, simTime, visibilityPolicy, this.celestialMarkers.activeLabels);
    this.navTarget.sync(
      camera, this.frameAnchors.bodies, this.frameAnchors.bodiesPivot, timeLabel);
    this.objectWindows.sync(simTime, displayTime);
    this.planDisplay.sync(camera, displayWindow);
    this.entityLines.sync(
      controlled, this.targeter.aliveTarget, this.viewManager.current, displayWindow, visibilityPolicy, orbitRef,
      camera, this.frameAnchors, this.celestialSystem);
    this.viewManager.activeView.syncPanels(displayWindow, camera);
    this.activeStage.sync(camera, displayTime);

    this.hud.syncTopBar(this.topBarView());
    this.hud.syncBurnManagement(controlled?.boosters?.managementViewModel() ?? null);
    this.hud.syncOrbitPanel(this.orbitPanelView(controlled, orbitRef));
    if (this.viewManager.current === 'map') {
      this.hud.syncMapScale(camera.scale, this.cameraSystem.mapCamera.resolvedFocus);
      if (this.activeStage.id === 'creative') {
        this.hud.syncVesselPanel(this.vesselPanelView(controlled, true));
      }
      this.hud.syncTargetPanel(null);
      this.hud.syncEnemiesPanel(enemiesPanelView(
        controlled, this.activeStage, this.dynamicSystem, this.targeter, true,
      ));
    } else {
      this.hud.syncVesselPanel(this.vesselPanelView(controlled, false));
      this.hud.syncTargetPanel(this.targetPanelView(controlled));
      this.hud.syncEnemiesPanel(enemiesPanelView(
        controlled, this.activeStage, this.dynamicSystem, this.targeter, false,
      ));
    }
    this.hud.syncOrbitAnalysis(this.orbitAnalysisView(controlled, orbitRef, displayWindow.duration));
    this.hud.finishPanelSync();
    this.markerManager.resolveCollisions(this.viewManager.current);
  }

  private topBarView(): TopBarViewModel {
    const displayWindow = this.displayWindowManager.current;
    const simTime = this.dynamicSystem.simTime;
    return {
      epochUnixSec: displayWindow.epochUnixSec,
      simTime,
      simSpeed: this.simSpeedManager.simSpeed,
      speedOptions: SIM_SPEED_LEVELS,
      autoWarpRealRemain: this.simSpeedManager.estimatedRealSecondsToWarpEnd(simTime),
      autoWarpSimRemain: this.simSpeedManager.remainingSimulationSeconds(simTime),
      isPaused: this.isPaused(),
      onSpeedChange: (speed) => this.simSpeedManager.setSpeed(speed),
    };
  }

  private orbitPanelView(
    entity: Controllable | null, reference: ReturnType<OrbitReferenceSelector['resolve']> | undefined,
  ): OrbitPanelViewModel | null {
    if (!entity || !reference) return null;
    const info = orbitInfo(
      entity, reference, entity.motion.state.t, (id: string) => this.celestialSystem.nameOf(id),
    );
    const centerName = !reference.attractor && this.navTarget.name ? this.navTarget.name : info.centerName;
    const status = entity.statusSnapshot();
    const dynamicPressure = status.aero?.qdyn ?? null;
    return {
      centerName,
      centerId: info.centerId,
      alt: info.alt,
      spd: info.spd,
      apAlt: info.apAlt,
      peAlt: info.peAlt,
      incDeg: info.incDeg,
      period: info.period,
      altitudeWarning: entity.altitudeAlarm?.descendWarned ?? false,
      dynamicPressure,
      dynamicPressureWarning: dynamicPressure !== null && dynamicPressure > 0.5 * MAX_DYN_PRESSURE,
      temperatureK: entity.motion.temperature,
      temperatureWarning: entity.motion.temperature > 0.7 * MAX_HULL_TEMP,
      referenceMode: this.orbitReference.selectedMode,
      onReferenceModeChange: (mode) => this.orbitReference.setMode(mode),
    };
  }

  private vesselPanelView(entity: Controllable | null, isMapView: boolean): VesselPanelViewModel | null {
    if (!entity) return null;
    return {
      status: entity.statusSnapshot(),
      isMapView,
      isCreative: this.activeStage.id === 'creative',
      cameraFollowsAttitude: this.cameraSystem.combatCamera.rotationFollow?.kind === 'attitude',
      onToggleSolarPanel: entity.toggleSolarPanel ?? null,
      onToggleRadiator: entity.toggleRadiator ?? null,
    };
  }

  private targetPanelView(entity: Controllable | null): TargetPanelViewModel | null {
    const target = entity ? this.targeter.aliveTarget : null;
    if (!entity || !target) return null;
    const relative = relativeInfo(
      entity, target, this.celestialSystem.celestialMotions, entity.motion.state.t,
    );
    return {
      name: target.name,
      distanceM: relative.dist,
      closingMps: relative.closing,
      relativeSpeedMps: relative.relSpeed,
      hp: target.hp,
      maxHp: target.maxHp,
      protein: target instanceof ProteinEnemy ? target.combatReadout : null,
    };
  }

  private resolveOrbitAnalysisTarget(): ApproachTargetSource | null {
    const id = this.navTarget.id;
    if (id === null) return null;
    const body = this.celestialSystem.find(id)?.motion;
    if (body !== undefined) return { kind: 'celestialBody', body };
    const entity = aliveCombatTarget(this.dynamicSystem.all(), id);
    return entity ? { kind: 'entity', entity } : null;
  }

  private orbitAnalysisView(
    entity: Controllable | null, reference: ReturnType<OrbitReferenceSelector['resolve']> | undefined,
    windowDurationSec: number,
  ): OrbitAnalysisViewModel {
    return {
      entity,
      reference: reference ?? null,
      target: this.resolveOrbitAnalysisTarget(),
      celestialSystem: this.celestialSystem,
      windowDurationSec,
    };
  }
}
