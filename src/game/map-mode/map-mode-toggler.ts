import { Hud } from "../../hud/hud";
import { CameraSystem } from "../camera/camera-system";
import { Plan } from "../plan/plan";
import { PlanEditor } from "../plan/plan-editor";
import { TouchControls } from "../touch";

export class MapModeToggler {
  editor: PlanEditor;
  plan: Plan;
  _hud: Hud;

  constructor(editor: PlanEditor, plan: Plan, hud: Hud) {
    this.editor = editor;
    this.plan = plan;
    this._hud = hud;
  }
  // --------------------------------------------------------------- toggler
  private open(touchControls: TouchControls | null, cameraSystem: CameraSystem): void {
    this.editor.selectedNodeIdx = null;

    this.plan.markDirty();
    this._hud.setMapToolbarVisible(true);
    touchControls?.setMapMode(true);
    cameraSystem.mapMode = true;
  }

  private close(touchControls: TouchControls | null, cameraSystem: CameraSystem): void {
    this.editor.onMapClosed();
    this.editor.closeMenu();
    this._hud.setPlanPanel(null);
    this._hud.setMapToolbarVisible(false);
    touchControls?.setMapMode(false);
    cameraSystem.mapMode = false;
  }

  toggle(isPlaying: boolean, touchControls: TouchControls | null, cameraSystem: CameraSystem): void {
    // ポーズ中、死亡後はマップモードを変更できない
    if (!isPlaying) return;

    if (!cameraSystem.mapMode) {
      this.open(touchControls, cameraSystem);
      this._hud.hint(
        '軌道計画モード: 軌道をクリックしてノード配置 → ドラッグで移動・矢印ハンドルでΔv調整 → 右クリックでメニュー → [M] で確定',
        5000,
      );
      return;
    }
    else {
      this.close(touchControls, cameraSystem);
      if (this.plan.nodes.length > 0) {
        this._hud.hint(`マニューバ計画 ${this.plan.nodes.length} 件確定 — [N] で直近ノードへ自動ワープ`, 4500);
      }
    }
    return;
  }

  // isPlayeingがfalseになったときに（死んだとき）にmapModeを終了する
  update(isPlaying: boolean, touchControls: TouchControls | null, cameraSystem: CameraSystem): void {
    if (isPlaying || !cameraSystem.mapMode) return;

    this.close(touchControls, cameraSystem);
    return;
  }
}