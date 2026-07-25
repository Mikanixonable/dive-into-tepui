// マップモードの開閉。視点側(cameraSystem.mapMode)と計画編集側(editor.editMode)という
// 独立した二つのフラグを同時に切り替える唯一の場所。マップモード中だけ現れる操作パネルは
// それぞれの所有者(CameraSystem / PredictSystem)が自分の毎フレーム sync で出し入れする。
import { Hud } from "./hud/hud";
import { CameraSystem } from "./camera/camera-system";
import { TouchControls } from "./input/touch";
import { PlanEditor } from "./plan/plan-editor";

export class MapModeToggler {
  constructor(private readonly _hud: Hud) {}

  private open(editor: PlanEditor, touchControls: TouchControls | null, cameraSystem: CameraSystem): void {
    editor.selectedNodeIdx = null;

    touchControls?.setMapMode(true);
    // 独立した二つの責務(広範囲視点 / 計画編集)を同時に開く唯一の場所。
    cameraSystem.mapMode = true;
    editor.editMode = true;
  }

  private close(editor: PlanEditor, touchControls: TouchControls | null, cameraSystem: CameraSystem): void {
    editor.onMapClosed();
    editor.closeMenu();
    cameraSystem.closeFocusMenu();
    touchControls?.setMapMode(false);
    cameraSystem.mapMode = false;
    editor.editMode = false;
  }

  toggle(isPlaying: boolean, editor: PlanEditor, touchControls: TouchControls | null, cameraSystem: CameraSystem): void {
    // ポーズ中、死亡後はマップモードを変更できない
    if (!isPlaying) return;

    if (!cameraSystem.mapMode) {
      this.open(editor, touchControls, cameraSystem);
      this._hud.hint(
        '軌道計画モード: 軌道をクリックしてノード配置 → ドラッグで移動・矢印ハンドルでΔv調整 → 右クリックでメニュー → [M] で確定',
        5000,
      );
      return;
    }
    else {
      this.close(editor, touchControls, cameraSystem);
      if (editor.plan.nodes.length > 0) {
        this._hud.hint(`マニューバ計画 ${editor.plan.nodes.length} 件確定 — [N] で直近ノードへ自動ワープ`, 4500);
      }
    }
    return;
  }

  // isPlayeingがfalseになったときに（死んだとき）にmapModeを終了する
  update(isPlaying: boolean, editor: PlanEditor, touchControls: TouchControls | null, cameraSystem: CameraSystem): void {
    if (isPlaying || !cameraSystem.mapMode) return;

    this.close(editor, touchControls, cameraSystem);
    return;
  }
}
