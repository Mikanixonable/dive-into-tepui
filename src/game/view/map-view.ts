// マップビュー専用のフレーム処理と遷移フック(ViewFrame の具象)。
import { MapPicking } from '../pickable/map-picking';
import type { Input } from '../../input/input';
import type { Hud } from '../hud/hud';
import type { CameraSystem } from '../camera/camera-system';
import type { CelestialSystem } from '../celestial/celestial-system';
import type { DynamicSystem } from '../dynamic/dynamic-system';
import type { ObjectPickable } from '../pickable/object-pickable';
import type { ObjectPickables } from '../pickable/object-pickables';
import type { LinePickables } from '../pickable/line-pickables';
import type { ObjectWindows } from '../pickable/object-windows';
import type { MapVisibilityPolicy } from '../map/visibility-policy';
import type { CelestialMarkers } from '../marker/celestial-markers';
import type { MarkerManager } from '../marker/marker-manager';
import type { NavTarget } from '../nav-target';
import type { Targeter } from '../targeter';
import type { PlanEditor } from '../plan/plan-editor';
import type { ActiveControllableController } from '../active-controllable-controller';
import type { DisplayWindow, DisplayWindowManager } from '../display-window-manager';
import type { FrameControls } from '../hud/frame/frame-controls';
import type { FrameAnchors } from '../frame-anchors';
import type { FloatingOrigin } from '../camera/floating-origin';
import type { ViewFrame } from './view';
import type { PerfCounts } from '../perf-counts';

export class MapView implements ViewFrame {
  private readonly picking: MapPicking;

  // マップのクリックの当て先は、マップビューにいる間しか働かないので、受け取った材料から
  // ここで組んで持つ。
  public constructor(
    private readonly input: Input,
    private readonly cameraSystem: CameraSystem,
    private readonly targeter: Targeter,
    private readonly editor: PlanEditor,
    private readonly objectWindows: ObjectWindows,
    private readonly dynamicSystem: DynamicSystem,
    private readonly celestialSystem: CelestialSystem,
    private readonly objectPickables: ObjectPickables,
    private readonly linePickables: LinePickables,
    private readonly celestialMarkers: CelestialMarkers,
    private readonly markerManager: MarkerManager,
    private readonly displayWindowManager: DisplayWindowManager,
    private readonly frameControls: FrameControls,
    private readonly frameAnchors: FrameAnchors,
    private readonly activePlayers: ActiveControllableController,
    hud: Hud,
    navTarget: NavTarget,
  ) {
    this.picking = new MapPicking(
      hud, cameraSystem, dynamicSystem, celestialSystem, celestialMarkers, markerManager,
      navTarget, frameControls, objectPickables, linePickables, objectWindows,
    );
  }

  public get pickables(): readonly ObjectPickable[] { return this.objectPickables.pickables; }
  public get visibilityPolicy(): MapVisibilityPolicy | null { return this.objectPickables.visibilityPolicy; }

  // 負荷確認ウィンドウが読む、マップの候補列の長さと表示中の天体ラベル数。
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

  // 前回の選択を引き継がず、ノード未選択で始める。
  public onEnter(): void {
    this.editor.selectedNodeIdx = null;
  }

  // 開いたままの編集 UI とメニューを畳み、マップで組んだ選択候補・可視性ポリシー・
  // 軌道線候補を空へ戻す。
  public onLeave(): void {
    this.editor.onMapClosed();
    this.editor.closeMenu();
    this.objectWindows.close();
    this.picking.close();
    this.objectPickables.clear();
    this.linePickables.clear();
  }

  // Δv 編集キー([Del]=選択ノード削除・WASDQE・ラッチ)を編集セッションへ配る。
  public handleInput(input: Input, dt: number): void {
    this.editor.handleInput(input, dt);
  }

  // クリック・右クリックを、ノード編集と被選択物・軌道線・空域のメニューへ先着順で配る。
  public handlePointer(simTime: number): void {
    this.picking.handleRightClick(this.input, simTime);
    this.picking.handleLeftClick(this.input);
    this.picking.handleDoubleClick(this.input);
    this.editor.handleMapPointer(this.input);
    this.picking.handleLineRightClick(this.input);
    this.picking.handleEmptySpaceRightClick(this.input, simTime);
  }

  // 赤道交点(ターゲット・基地)を求め直し、選択候補と可視性ポリシーを組む。
  // 交点アイコンは候補列に載るので、objectPickables.refresh より先に求める。
  public update(displayWindow: DisplayWindow): void {
    this.targeter.updateEquatorNodes(displayWindow, this.celestialSystem, this.frameAnchors);
    this.dynamicSystem.updateBaseEquatorNodes(displayWindow, this.celestialSystem, this.frameAnchors);
    this.objectPickables.refresh(displayWindow);
    this.editor.update(displayWindow.simTime);
  }

  // 天体ラベルの間引きと表示。この後のマーカー同期が近接判定に読む。
  public syncLabels(): void {
    this.celestialMarkers.syncLabels(this.cameraSystem.activeCameraProjection, this.cameraSystem.activeCameraPos);
  }

  // マップ専用の編集 UI と常設パネル(未来表示・座標系・軌道物体一覧)・天体ラベルのサブ行・
  // 軌道線の右クリック候補。
  public syncPanels(displayWindow: DisplayWindow, fo: FloatingOrigin): void {
    // 編集 UI と常設パネル
    this.editor.sync(this.cameraSystem.mapCamera.dist, fo);
    this.displayWindowManager.sync(this.activePlayers.current);
    this.picking.sync(displayWindow.displayTime, this.activePlayers.current);
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
    this.editor.dispose();
    this.picking.dispose();
  }
}
