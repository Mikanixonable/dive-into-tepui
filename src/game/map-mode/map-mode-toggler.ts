import { Hud } from "../../hud/hud";
import { CameraSystem } from "../camera/camera-system";
import { TouchControls } from "../touch";
import { MapModeSystem } from "./map-mode-system";

export class MapModeToggler {
  _hud: Hud;

  constructor(hud: Hud) {
    this._hud = hud;
  }
  // --------------------------------------------------------------- toggler
  private open(mapModeSystem: MapModeSystem, touchControls: TouchControls | null, cameraSystem: CameraSystem): void {
    mapModeSystem.editor.selectedNodeIdx = null;

    mapModeSystem.editor.plan.markDirty();
    this._hud.setMapToolbarVisible(true);
    touchControls?.setMapMode(true);
    cameraSystem.mapMode = true;
  }

  private close(mapModeSystem: MapModeSystem, touchControls: TouchControls | null, cameraSystem: CameraSystem): void {
    mapModeSystem.editor.onMapClosed();
    mapModeSystem.editor.closeMenu();
    this._hud.setPlanPanel(null);
    this._hud.setMapToolbarVisible(false);
    touchControls?.setMapMode(false);
    cameraSystem.mapMode = false;
    mapModeSystem.guide.clearActiveTarget();
  }

  toggle(isPlaying: boolean, mapModeSystem: MapModeSystem, touchControls: TouchControls | null, cameraSystem: CameraSystem): void {
    // ポーズ中、死亡後はマップモードを変更できない
    if (!isPlaying) return;

    if (!cameraSystem.mapMode) {
      this.open(mapModeSystem, touchControls, cameraSystem);
      this._hud.hint(
        '軌道計画モード: 軌道をクリックしてノード配置 → ドラッグで移動・矢印ハンドルでΔv調整 → 右クリックでメニュー → [M] で確定',
        5000,
      );
      return;
    }
    else {
      this.close(mapModeSystem, touchControls, cameraSystem);
      if (mapModeSystem.editor.plan.nodes.length > 0) {
        this._hud.hint(`マニューバ計画 ${mapModeSystem.editor.plan.nodes.length} 件確定 — [N] で直近ノードへ自動ワープ`, 4500);
      }
    }
    return;
  }

  // isPlayeingがfalseになったときに（死んだとき）にmapModeを終了する
  update(isPlaying: boolean, mapModeSystem: MapModeSystem, touchControls: TouchControls | null, cameraSystem: CameraSystem): void {
    if (isPlaying || !cameraSystem.mapMode) return;

    this.close(mapModeSystem, touchControls, cameraSystem);
    return;
  }
}