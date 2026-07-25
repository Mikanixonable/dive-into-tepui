import { Hud } from "./hud/hud";
import { CameraSystem } from "./camera/camera-system";
import { TouchControls } from "./input/touch";
import { PlanSystem } from "./plan/plan-system";

export class MapModeToggler {
  _hud: Hud;

  constructor(hud: Hud) {
    this._hud = hud;
  }
  
  private open(planSystem: PlanSystem, touchControls: TouchControls | null, cameraSystem: CameraSystem): void {
    planSystem.editor.selectedNodeIdx = null;

    this._hud.setMapToolbarVisible(true);
    touchControls?.setMapMode(true);
    // 独立した二つの責務(広範囲視点 / 計画編集)を同時に開く唯一の場所。
    cameraSystem.mapMode = true;
    planSystem.editMode = true;
  }

  private close(planSystem: PlanSystem, touchControls: TouchControls | null, cameraSystem: CameraSystem): void {
    planSystem.onMapClosed();
    planSystem.editor.closeMenu();
    cameraSystem.closeFocusMenu();
    this._hud.setPlanPanel(null);
    this._hud.setMapToolbarVisible(false);
    touchControls?.setMapMode(false);
    cameraSystem.mapMode = false;
    planSystem.editMode = false;
  }

  toggle(isPlaying: boolean, planSystem: PlanSystem, touchControls: TouchControls | null, cameraSystem: CameraSystem): void {
    // ポーズ中、死亡後はマップモードを変更できない
    if (!isPlaying) return;

    if (!cameraSystem.mapMode) {
      this.open(planSystem, touchControls, cameraSystem);
      this._hud.hint(
        '軌道計画モード: 軌道をクリックしてノード配置 → ドラッグで移動・矢印ハンドルでΔv調整 → 右クリックでメニュー → [M] で確定',
        5000,
      );
      return;
    }
    else {
      this.close(planSystem, touchControls, cameraSystem);
      if (planSystem.editor.plan.nodes.length > 0) {
        this._hud.hint(`マニューバ計画 ${planSystem.editor.plan.nodes.length} 件確定 — [N] で直近ノードへ自動ワープ`, 4500);
      }
    }
    return;
  }

  // isPlayeingがfalseになったときに（死んだとき）にmapModeを終了する
  update(isPlaying: boolean, planSystem: PlanSystem, touchControls: TouchControls | null, cameraSystem: CameraSystem): void {
    if (isPlaying || !cameraSystem.mapMode) return;

    this.close(planSystem, touchControls, cameraSystem);
    return;
  }
}