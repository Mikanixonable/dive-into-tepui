// マップビュー専用のフレーム処理(WorldViewFrame の具象)。呼ぶ位置と順序は Game が持つ。
import type { Input } from './input/input';
import type { CameraSystem } from './camera/camera-system';
import type { CelestialSystem } from './celestial/celestial-system';
import type { DynamicSystem } from './dynamic/dynamic-system';
import type { MapPickables } from './pickable/map-pickables';
import type { LinePickables } from './pickable/line-pickables';
import type { MapContextActions } from './pickable/map-context-actions';
import type { CelestialMarkers } from './marker/celestial-markers';
import type { MarkerManager } from './marker/marker-manager';
import type { Targeter } from './targeter';
import type { PlanEditor } from './plan/plan-editor';
import type { ActiveControllableController } from './active-controllable-controller';
import type { DisplayWindow, DisplayWindowManager } from './display-window-manager';
import type { FrameControls } from './hud/frame/frame-controls';
import type { FrameAnchors } from './frame-anchors';
import type { FloatingOrigin } from './camera/floating-origin';
import type { WorldViewFrame } from './world-view';

export class MapView implements WorldViewFrame {
  constructor(
    private readonly input: Input,
    private readonly cameraSystem: CameraSystem,
    private readonly targeter: Targeter,
    private readonly editor: PlanEditor,
    private readonly mapActions: MapContextActions,
    private readonly dynamicSystem: DynamicSystem,
    private readonly celestialSystem: CelestialSystem,
    private readonly mapPickables: MapPickables,
    private readonly linePickables: LinePickables,
    private readonly celestialMarkers: CelestialMarkers,
    private readonly markerManager: MarkerManager,
    private readonly displayWindowManager: DisplayWindowManager,
    private readonly frameControls: FrameControls,
    private readonly frameAnchors: FrameAnchors,
    private readonly activePlayers: ActiveControllableController,
  ) {}

  // マップビューはいつでも入れる。
  canEnter(): boolean {
    return true;
  }

  onEnter(): void {
    this.editor.selectedNodeIdx = null;
  }

  // 開いたままの編集 UI とメニューを畳み、マップで組んだ選択候補・可視性ポリシー・
  // 軌道線候補を空へ戻す(戦闘ビューの表示・選択は null 経路で判定する)。
  onLeave(): void {
    this.editor.onMapClosed();
    this.editor.closeMenu();
    this.mapActions.close();
    this.mapPickables.clear();
    this.linePickables.clear();
  }

  // Δv 編集キー([Del]=選択ノード削除・WASDQE・ラッチ)を編集セッションへ配る。
  handleInput(input: Input, dt: number): void {
    this.editor.handleInput(input, dt);
  }

  // クリック・右クリックを、ノード編集と被選択物・軌道線・空域のメニューへ先着順で配る。
  handlePointer(simTime: number): void {
    this.mapActions.handleMapRightClick(this.input, simTime);
    this.mapActions.handleLeftClick(this.input);
    this.mapActions.handleDoubleClick(this.input);
    this.editor.handleMapPointer(this.input);
    this.mapActions.handleLineRightClick(this.input);
    this.mapActions.handleEmptySpaceRightClick(this.input, simTime);
  }

  // 赤道交点(ターゲット・基地)を求め直し、選択候補と可視性ポリシーを組む。
  // 交点アイコンは候補列に載るので、mapPickables.refresh より先に求める。
  update(displayWindow: DisplayWindow): void {
    this.targeter.updateEquatorNodes(displayWindow, this.celestialSystem, this.frameAnchors);
    this.dynamicSystem.updateBaseEquatorNodes(displayWindow, this.celestialSystem, this.frameAnchors);
    this.mapPickables.refresh(displayWindow);
    this.editor.update(displayWindow);
  }

  // 天体ラベルの間引きと表示。この後のマーカー同期が近接判定に読む。
  syncLabels(): void {
    this.celestialMarkers.syncLabels(this.cameraSystem.activeCameraProjection, this.cameraSystem.activeCameraPos);
  }

  // マップ専用の編集 UI と常設パネル(未来表示・座標系)・天体ラベルのサブ行・
  // 軌道線の右クリック候補。
  syncPanels(displayWindow: DisplayWindow, fo: FloatingOrigin): void {
    this.editor.sync(this.cameraSystem, displayWindow.simTime, fo);
    this.displayWindowManager.sync(this.activePlayers.current);
    this.frameControls.sync(
      this.mapPickables.pickables, this.cameraSystem.activeCameraPos,
      displayWindow.simTime, displayWindow.displayTime, true,
    );
    this.celestialMarkers.syncSubLabels(
      this.markerManager.combatMarkers, this.celestialSystem.celestialMotions, displayWindow.displayTime,
      this.cameraSystem.activeCameraProjection, this.cameraSystem.activeCameraPos,
    );
    this.linePickables.refresh(displayWindow, this.frameAnchors);
  }

  dispose(): void {
    this.editor.dispose();
  }
}
