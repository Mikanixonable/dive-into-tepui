// マップビュー専用のフレーム処理と遷移フック(ViewFrame の具象)。
import { MapPicking } from '../pickable/map-picking';
import type { Input } from '../../input/input';
import type { HudLayers } from '../hud/hud-layers';
import type { Notifier } from '../../hud/notifier';
import type { CelestialSystem } from '../celestial/celestial-system';
import type { EntityRoster } from '../dynamic/entity-roster';
import type { ObjectPickable } from '../pickable/object-pickable';
import { ObjectPickables } from '../pickable/object-pickables';
import { LinePickables } from '../pickable/line-pickables';
import type { ObjectWindows } from '../pickable/object-windows';
import type { MapVisibilityPolicy } from '../map/visibility-policy';
import type { CelestialMarkers } from '../marker/celestial-markers';
import type { MarkerVisibility } from '../../marker/marker-visibility';
import type { GroupedMarkers } from '../marker/grouped-markers';
import type { EquatorNodeManager } from '../marker/equator-node-manager';
import type { NavTargetPresenter } from '../nav-target-presenter';
import type { NavTargetCommands } from '../viewer/nav-target-commands';
import { PlanEditor } from '../plan/plan-editor';
import type { PlanCommands } from '../plan/plan-commands';
import type { PlanDisplay } from '../plan/plan-display';
import type { SimSpeedCommands } from '../dynamic/sim-speed-commands';
import type { SimSpeedManager } from '../dynamic/sim-speed-manager';
import type * as THREE from 'three/webgpu';
import type { ControlSelection } from '../control-selection';
import type { ControlSelectionCommands } from '../control-selection-commands';
import type { DisplayWindow, DisplayWindowManager } from '../display-window-manager';
import type { FrameControls } from '../hud/frame/frame-controls';
import type { FrameAnchors } from '../frame-anchors';
import type { MapDisplayToggles } from '../map/display-toggles';
import type { SettingValue } from '../../settings/setting-value';
import type { CameraFrame } from '../../render/camera/camera-frame';
import type { ViewFrame } from './view-frame';
import type { PerfCounts } from '../perf-counts';
import type { Vec3 } from '../../math/vec3';
import type { MapCameraSource } from '../viewer/camera-selection';
import type { UiSoundQueue } from '../ui-sound-queue';

interface CameraPositionSource {
  readonly activeCameraPos: Vec3;
}

export class MapView implements ViewFrame {
  private readonly picking: MapPicking;
  public readonly planEditor: PlanEditor;
  private readonly objectPickables: ObjectPickables;
  private readonly linePickables: LinePickables;

  // マップ専用の編集口・候補列・クリックの当て先は、受け取った材料からここで組んで持つ。
  public constructor(
    private readonly input: Input,
    private readonly cameraPresentation: CameraPositionSource,
    private readonly camera: MapCameraSource,
    private readonly objectWindows: ObjectWindows,
    roster: EntityRoster,
    equatorNodes: EquatorNodeManager,
    private readonly celestialSystem: CelestialSystem,
    private readonly celestialMarkers: CelestialMarkers,
    markers: MarkerVisibility,
    private readonly combatMarkers: GroupedMarkers,
    private readonly displayWindowManager: DisplayWindowManager,
    private readonly frameControls: FrameControls,
    private readonly frameAnchors: FrameAnchors,
    private readonly controlSelection: ControlSelection,
    controlSelectionCommands: ControlSelectionCommands,
    simSpeedManager: SimSpeedManager,
    simSpeedCommands: SimSpeedCommands,
    planDisplay: PlanDisplay,
    planCommands: PlanCommands,
    scene: THREE.Scene,
    hud: HudLayers & Notifier,
    uiSounds: UiSoundQueue,
    navTargetPresenter: NavTargetPresenter,
    navTargetCommands: NavTargetCommands,
    private readonly mapDisplay: SettingValue<MapDisplayToggles>,
  ) {
    this.planEditor = new PlanEditor(
      hud, uiSounds, simSpeedManager, simSpeedCommands, celestialSystem, scene, controlSelection,
      displayWindowManager, frameControls, planDisplay.path, planCommands,
    );
    this.objectPickables = new ObjectPickables(
      controlSelection, roster, celestialSystem, navTargetPresenter, camera,
      celestialMarkers, planDisplay, frameAnchors, equatorNodes,
    );
    this.linePickables = new LinePickables(roster, celestialSystem);
    this.picking = new MapPicking(
      hud, camera, roster, celestialSystem, celestialMarkers, markers,
      navTargetPresenter, navTargetCommands, frameControls, this.objectPickables, this.linePickables, objectWindows,
      controlSelectionCommands, displayWindowManager,
    );
  }

  public get pickables(): readonly ObjectPickable[] { return this.objectPickables.pickables; }
  public get visibilityPolicy(): MapVisibilityPolicy | null { return this.objectPickables.visibilityPolicy; }

  // マップの候補列の長さと、表示中の天体ラベル数。
  public perfCounts(): Pick<PerfCounts, 'mapMode' | 'mapItems' | 'mapLabels'> {
    return {
      mapMode: true,
      mapItems: this.objectPickables.pickables.length,
      mapLabels: this.celestialMarkers.shownLabelCount,
    };
  }

  // ノード未選択で始める。
  public onEnter(): void {
    this.planEditor.selectedNodeIdx = null;
  }

  // 開いたままの編集 UI とメニューを畳み、マップで組んだ選択候補・可視性ポリシー・
  // 軌道線候補を空へ戻す。
  public onLeave(): void {
    this.planEditor.onMapClosed();
    this.planEditor.closeMenu();
    this.objectWindows.close();
    this.picking.close();
    this.objectPickables.clear();
    this.linePickables.clear();
  }

  // router から計画キーと Δv 編集の単発キーを受け取る。
  public handleCommand(commandId: string): void {
    this.planEditor.handleCommand(commandId);
  }

  // Δv 編集の押下中操作を編集セッションへ配る。
  public updateActions(dt: number): void {
    this.planEditor.updateActions(this.input, dt);
  }

  // クリック・右クリックを、ノード編集と被選択物・軌道線・空域のメニューへ先着順で配る。
  public handlePointer(camera: CameraFrame): void {
    this.picking.handleRightClick(this.input, camera);
    this.picking.handleLeftClick(this.input, camera);
    this.picking.handleDoubleClick(this.input, camera);
    this.planEditor.handleMapPointer(this.input);
    this.picking.handleLineRightClick(this.input, camera);
    this.picking.handleEmptySpaceRightClick(this.input);
  }

  // 選択候補と可視性ポリシーを組み、時刻に追従する操作パネルを更新する。
  public update(displayWindow: DisplayWindow): void {
    this.objectPickables.refresh(
      displayWindow, this.mapDisplay.current, this.cameraPresentation.activeCameraPos,
    );
    this.displayWindowManager.dropStaleRotatingFrame(displayWindow.displayTime, this.frameAnchors);
    this.planEditor.update();
  }

  // 天体ラベルの間引きと表示。
  public syncLabels(displayWindow: DisplayWindow, camera: CameraFrame, nowMs: number): void {
    const visibilityPolicy = this.visibilityPolicy;
    if (visibilityPolicy === null) { this.celestialMarkers.hideLabels(nowMs); return; }
    this.celestialMarkers.syncLabels(
      camera.project, camera.position, displayWindow.displayTime, visibilityPolicy, nowMs,
    );
  }

  // マップ専用の表示物を、このフレームの表示窓とカメラへ揃える。
  public syncPanels(displayWindow: DisplayWindow, camera: CameraFrame, nowMs: number): void {
    // 編集 UI と常設パネル
    this.planEditor.sync(this.camera.map.distance, camera.floatingOrigin);
    this.displayWindowManager.sync(this.controlSelection.current);
    this.picking.sync(displayWindow.displayTime, this.controlSelection.current);
    this.frameControls.sync(
      this.objectPickables.pickables, camera.position, displayWindow.displayTime,
    );
    // 天体ラベルのサブ行と、軌道線の右クリック候補
    this.celestialMarkers.syncSubLabels(
      this.combatMarkers, this.celestialSystem.celestialMotions, displayWindow.displayTime,
      camera.project, camera.position, nowMs,
    );
    this.linePickables.refresh();
  }

  // 編集 UI とクリックの当て先を片付ける。
  public dispose(): void {
    this.planEditor.dispose();
    this.picking.dispose();
  }
}
