// マップモードの開閉。マップモードが開いているかの正本は、このクラスが持つ mapMode。
// 視点側(cameraSystem.overviewMode)・計画編集側(editor.editMode)・未来表示側
// (predict.forceCurrent)はいずれもその影響先で、正本と同時に切り替える唯一の場所がここ。
// マップモード中だけ現れる操作パネルは、それぞれの所有者(CameraSystem / PredictSystem)が
// 自分の毎フレーム sync で出し入れする。
import { Hud } from "./hud/hud";
import { CameraSystem } from "./camera/camera-system";
import { TouchControls } from "./input/touch";
import type { Input } from "./input/input";
import { KEY_MAPPING as K } from "./input/key-mapping";
import { PlanEditor } from "./plan/plan-editor";
import { PredictSystem } from "./predict/predict-system";

export class MapModeToggler {
  private _mapMode = false;
  get mapMode(): boolean { return this._mapMode; }

  constructor(private readonly _hud: Hud) { }

  private open(
    editor: PlanEditor,
    touchControls: TouchControls | null,
    cameraSystem: CameraSystem,
    predict: PredictSystem): void {
    editor.selectedNodeIdx = null;
    this.setMapMode(true, editor, touchControls, cameraSystem, predict);
  }

  private close(
    editor: PlanEditor,
    touchControls: TouchControls | null,
    cameraSystem: CameraSystem,
    predict: PredictSystem): void {
    editor.onMapClosed();
    editor.closeMenu();
    cameraSystem.closeFocusMenu();
    this.setMapMode(false, editor, touchControls, cameraSystem, predict);
  }

  // 正本フラグと、その影響先(広範囲視点・Δv編集入力・未来表示・タッチUI)を一斉に切り替える。
  private setMapMode(
    open: boolean,
    editor: PlanEditor,
    touchControls: TouchControls | null,
    cameraSystem: CameraSystem,
    predict: PredictSystem): void {
    this._mapMode = open;
    touchControls?.setMapMode(open);
    cameraSystem.overviewMode = open;
    editor.editMode = open;
    predict.forceCurrent = !open;
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
      if (this._mapMode) { // 開いていたら閉じる
        this.close(editor, touchControls, cameraSystem, predict);
      }
      return;
    }

    if (input.takeKey(K.toggleMapMode)) { // 入力があったとき
      if (!this._mapMode) { // 閉じていたら開く
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
