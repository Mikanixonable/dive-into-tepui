// マップビュー専用のフレーム処理と遷移フック(ViewFrame の具象)。
import { MapPicking } from '../pickable/map-picking';
import type { Input } from '../../input/input';
import type { HudLayers } from '../hud/hud-layers';
import type { Notifier } from '../../hud/notifier';
import type { CameraSystem } from '../camera/camera-system';
import type { CelestialSystem } from '../celestial/celestial-system';
import type { EntityRoster } from '../dynamic/entity-roster';
import type { ObjectPickable } from '../pickable/object-pickable';
import { ObjectPickables } from '../pickable/object-pickables';
import { LinePickables } from '../pickable/line-pickables';
import type { ObjectWindows } from '../pickable/object-windows';
import type { MapVisibilityPolicy } from '../map/visibility-policy';
import type { CelestialMarkers } from '../marker/celestial-markers';
import type { MarkerManager } from '../marker/marker-manager';
import type { EquatorNodeManager } from '../marker/equator-node-manager';
import type { NavTarget } from '../nav-target';
import { PlanEditor } from '../plan/plan-editor';
import type { PlanDisplay } from '../plan/plan-display';
import type { SimSpeedManager } from '../dynamic/sim-speed-manager';
import type { UiSfx } from '../../audio/sfx/ui-sfx';
import type * as THREE from 'three/webgpu';
import type { ControlSelection } from '../control-selection';
import type { DisplayWindow, DisplayWindowManager } from '../display-window-manager';
import type { FrameControls } from '../hud/frame/frame-controls';
import type { FrameAnchors } from '../frame-anchors';
import type { MapDisplayToggles } from '../map/display-toggles';
import type { RunSetting } from '../run-setting';
import type { FloatingOrigin } from '../camera/floating-origin';
import type { ViewFrame } from './view-frame';
import type { PerfCounts } from '../perf-counts';

export class MapView implements ViewFrame {
  private readonly picking: MapPicking;
  // マップでしか使わないものはここが持つ。計画の編集、被選択物の候補列、軌道線の候補列。
  public readonly planEditor: PlanEditor;
  private readonly objectPickables: ObjectPickables;
  private readonly linePickables: LinePickables;

  // マップ専用の編集口・候補列・クリックの当て先は、受け取った材料からここで組んで持つ。
  public constructor(
    private readonly input: Input,
    private readonly cameraSystem: CameraSystem,
    private readonly objectWindows: ObjectWindows,
    roster: EntityRoster,
    equatorNodes: EquatorNodeManager,
    private readonly celestialSystem: CelestialSystem,
    private readonly celestialMarkers: CelestialMarkers,
    private readonly markerManager: MarkerManager,
    private readonly displayWindowManager: DisplayWindowManager,
    private readonly frameControls: FrameControls,
    private readonly frameAnchors: FrameAnchors,
    private readonly controlSelection: ControlSelection,
    simSpeedManager: SimSpeedManager,
    planDisplay: PlanDisplay,
    scene: THREE.Scene,
    hud: HudLayers & Notifier,
    uiSfx: UiSfx,
    navTarget: NavTarget,
    private readonly mapDisplay: RunSetting<MapDisplayToggles>,
  ) {
    // 編集・物体候補・線候補を組み、最後に同じ候補群を読む入力処理へ渡す。
    this.planEditor = new PlanEditor(
      hud, uiSfx, simSpeedManager, celestialSystem, scene, controlSelection,
      displayWindowManager, frameControls, planDisplay.path,
    );
    this.objectPickables = new ObjectPickables(
      controlSelection, roster, celestialSystem, navTarget, cameraSystem,
      celestialMarkers, planDisplay, frameAnchors, equatorNodes,
    );
    this.linePickables = new LinePickables(roster, celestialSystem);
    this.picking = new MapPicking(
      hud, cameraSystem, roster, celestialSystem, celestialMarkers, markerManager,
      navTarget, frameControls, this.objectPickables, this.linePickables, objectWindows,
      controlSelection,
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

  // マップビューはいつでも入れる。
  public canEnter(): boolean {
    return true;
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

  // Δv 編集キー([Del]=選択ノード削除・WASDQE・ラッチ)を編集セッションへ配る。
  public handleInput(input: Input, dt: number): void {
    this.planEditor.handleInput(input, dt);
  }

  // クリック・右クリックを、ノード編集と被選択物・軌道線・空域のメニューへ先着順で配る。
  public handlePointer(simTime: number): void {
    this.picking.handleRightClick(this.input, simTime);
    this.picking.handleLeftClick(this.input);
    this.picking.handleDoubleClick(this.input);
    this.planEditor.handleMapPointer(this.input);
    this.picking.handleLineRightClick(this.input);
    this.picking.handleEmptySpaceRightClick(this.input, simTime);
  }

  // 選択候補と可視性ポリシーを組み、時刻に追従する操作パネルを更新する。
  public update(displayWindow: DisplayWindow): void {
    this.objectPickables.refresh(displayWindow, this.mapDisplay.current);
    this.frameControls.update(displayWindow.displayTime);
    this.planEditor.update(displayWindow.simTime);
  }

  // 天体ラベルの間引きと表示。
  public syncLabels(displayWindow: DisplayWindow): void {
    const visibilityPolicy = this.visibilityPolicy;
    if (visibilityPolicy === null) { this.celestialMarkers.hideLabels(); return; }
    this.celestialMarkers.syncLabels(
      this.cameraSystem.activeCameraProjection, this.cameraSystem.activeCameraPos,
      displayWindow.displayTime, visibilityPolicy,
    );
  }

  // マップ専用の編集 UI と常設パネル(未来表示・座標系・軌道物体一覧)・天体ラベルのサブ行・
  // 軌道線の右クリック候補。
  public syncPanels(displayWindow: DisplayWindow, fo: FloatingOrigin): void {
    // 編集 UI と常設パネル
    this.planEditor.sync(this.cameraSystem.mapCamera.dist, fo);
    this.displayWindowManager.sync(this.controlSelection.current);
    this.picking.sync(displayWindow.displayTime, this.controlSelection.current);
    this.frameControls.sync(
      this.objectPickables.pickables, this.cameraSystem.activeCameraPos,
      displayWindow.simTime, displayWindow.displayTime,
    );
    // 天体ラベルのサブ行と、軌道線の右クリック候補
    this.celestialMarkers.syncSubLabels(
      this.markerManager.combatMarkers, this.celestialSystem.celestialMotions, displayWindow.displayTime,
      this.cameraSystem.activeCameraProjection, this.cameraSystem.activeCameraPos,
    );
    this.linePickables.refresh(displayWindow, this.frameAnchors);
  }

  // 編集 UI とクリックの当て先を片付ける。
  public dispose(): void {
    this.planEditor.dispose();
    this.picking.dispose();
  }
}
