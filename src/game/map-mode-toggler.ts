// マップモードの開閉。視点側(cameraSystem.mapMode)と計画編集側(editor.editMode)という
// 独立した二つのフラグを同時に切り替える唯一の場所。マップモード中だけ現れる操作パネルは
// それぞれの所有者(CameraSystem / PredictSystem)が自分の毎フレーム sync で出し入れする。
import { Hud } from "./hud/hud";
import { CameraSystem } from "./camera/camera-system";
import { TouchControls } from "./input/touch";
import type { Input } from "./input/input";
import { KEY_MAPPING as K } from "./input/key-mapping";
import { PlanEditor } from "./plan/plan-editor";
import { PredictSystem } from "./predict/predict-system";

export class MapModeToggler {
  constructor(private readonly _hud: Hud) { }

  private open(
    editor: PlanEditor,
    touchControls: TouchControls | null,
    cameraSystem: CameraSystem,
    predict: PredictSystem): void {
    editor.selectedNodeIdx = null;
    touchControls?.setMapMode(true);
    cameraSystem.mapMode = true;
    editor.editMode = true;
    predict.forceCurrent = false;
  }

  private close(
    editor: PlanEditor,
    touchControls: TouchControls | null,
    cameraSystem: CameraSystem,
    predict: PredictSystem): void {
    editor.onMapClosed();
    editor.closeMenu();
    cameraSystem.closeFocusMenu();
    touchControls?.setMapMode(false);
    cameraSystem.mapMode = false;
    editor.editMode = false;
    predict.forceCurrent = true;
  }

  // 毎フレーム呼ぶ。[M] の開閉を受け、決着後は開いたままにならないよう閉じる。
  update(
    input: Input,
    isPlaying: boolean,
    editor: PlanEditor,
    touchControls: TouchControls | null,
    cameraSystem: CameraSystem,
    predict: PredictSystem,
  ): void {
    // ポーズ中、死亡後はマップモードを開けない
    if (!isPlaying) {
      if (cameraSystem.mapMode) { // 開いていたら閉じる
        this.close(editor, touchControls, cameraSystem, predict);
      }
      return;
    }

    if (input.takeKey(K.toggleMapMode)) { // 入力があったとき
      if (!cameraSystem.mapMode) { // 閉じていたら開く
        this.open(editor, touchControls, cameraSystem, predict);
        this._hud.hint(
          `軌道計画モード: 軌道をクリックしてノード配置 → ドラッグで移動・矢印ハンドルでΔv調整 → 右クリックでメニュー → [${K.toggleMapMode.label}] で確定`,
          5000,
        );
      }
      else { // 開いていたら閉じる
        this.close(editor, touchControls, cameraSystem, predict);
        if (editor.plan.nodes.length > 0) {
          this._hud.hint(`マニューバ計画 ${editor.plan.nodes.length} 件確定 — [${K.autoWarpToNode.label}] で直近ノードへ自動ワープ`, 4500);
        }
      }
    }
  }
}
