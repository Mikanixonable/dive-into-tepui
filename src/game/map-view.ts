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
import type { Player } from './player/player';
import type { DisplayWindow, DisplayWindowManager } from './display-window-manager';
import type { FrameControls } from './hud/frame/frame-controls';
import type { FrameAnchors } from './frame-anchors';
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
    private readonly player: () => Player | null,
  ) {}

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
  }

  // 天体ラベルの間引きと表示。この後のマーカー同期が近接判定に読む。
  syncLabels(): void {
    this.celestialMarkers.syncLabels(this.cameraSystem.activeCameraProjection, this.cameraSystem.activeCameraPos);
  }

  // マップ専用の常設パネル(未来表示・座標系)・天体ラベルのサブ行・軌道線の右クリック候補。
  syncPanels(displayWindow: DisplayWindow): void {
    this.displayWindowManager.sync(this.player());
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
}
