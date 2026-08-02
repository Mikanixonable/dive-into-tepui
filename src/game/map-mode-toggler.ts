// マップモードの開閉。マップモードが開いているかの正本は、このクラスが持つ mapMode。
// 視点側(cameraSystem.overviewMode)・計画編集側(editor.editMode)・未来表示側
// (displayTimeManager.forceCurrent)はいずれもその影響先で、正本と同時に切り替える唯一の
// 場所がここ。マップモード中だけ現れる操作パネルは、それぞれの所有者
// (CameraSystem / DisplayTimeManager / PlanEditor が所有する PlanDisplay)が
// 自分の毎フレーム sync で出し入れする。
import { Hud } from "./hud/hud";
import { CameraSystem } from "./camera/camera-system";
import { TouchControls } from "./input/touch";
import type { Input } from "./input/input";
import { KEY_MAPPING as K } from "./input/key-mapping";
import { PlanEditor } from "./plan/plan-editor";
import { DisplayTimeManager } from "./display-time-manager";
import { MapPickMenu } from "./map-pick-menu";

export class MapModeToggler {
  private _mapMode = false;
  get mapMode(): boolean { return this._mapMode; }

  constructor(private readonly _hud: Hud, initialMapMode = false) {
    this._mapMode = initialMapMode;
  }

  // コンストラクタで受けた初期 mapMode に、視点・入力・未来表示の各フラグを合わせる。
  // 呼び出し時点でまだ存在しない touchControls は対象外(初期状態では触れない)。
  applyInitialState(editor: PlanEditor, cameraSystem: CameraSystem, displayTimeManager: DisplayTimeManager): void {
    this.setMapMode(this._mapMode, editor, null, cameraSystem, displayTimeManager);
  }

  // マップを開く。選択中ノードをクリアしてから mapMode をオンにする。
  private open(
    editor: PlanEditor,
    touchControls: TouchControls | null,
    cameraSystem: CameraSystem,
    displayTimeManager: DisplayTimeManager): void {
    editor.selectedNodeIdx = null;
    this.setMapMode(true, editor, touchControls, cameraSystem, displayTimeManager);
  }

  // マップを閉じる。計画編集側の後始末(ノード整理・メニュー閉じ)をしてから mapMode をオフにする。
  private close(
    editor: PlanEditor,
    touchControls: TouchControls | null,
    cameraSystem: CameraSystem,
    displayTimeManager: DisplayTimeManager,
    mapPickMenu: MapPickMenu): void {
    editor.onMapClosed();
    editor.closeMenu();
    mapPickMenu.closeMenu();
    this.setMapMode(false, editor, touchControls, cameraSystem, displayTimeManager);
  }

  // 正本フラグと、その影響先(広範囲視点・Δv編集入力・未来表示・タッチUI)を一斉に切り替える。
  private setMapMode(
    open: boolean,
    editor: PlanEditor,
    touchControls: TouchControls | null,
    cameraSystem: CameraSystem,
    displayTimeManager: DisplayTimeManager): void {
    this._mapMode = open;
    touchControls?.setMapMode(open);
    cameraSystem.overviewMode = open;
    editor.editMode = open;
    displayTimeManager.forceCurrent = !open;
  }

  // 毎フレーム呼ぶ。[M] の開閉を受け、決着後は開いたままにならないよう閉じる。
  // ポーズ中は [M] の入力そのものを無視する(キーも消費しない)が、既に開いているマップを
  // 強制的に閉じることはしない — ポーズ解除後は開いていた状態のまま戻る。
  // canToggleView が false の間は [M] を無効化する(キーも消費しない) — 戦闘ビューが
  // 前提とする操作対象艦が無いとき用。
  update(
    input: Input,
    isPlaying: boolean,
    _isPaused: boolean,
    canToggleView: boolean,
    editor: PlanEditor,
    touchControls: TouchControls | null,
    cameraSystem: CameraSystem,
    displayTimeManager: DisplayTimeManager,
    mapPickMenu: MapPickMenu,
  ): void {
    // 決着後はマップモードを開けない(既に開いていれば閉じる)
    if (!isPlaying) {
      if (this._mapMode) { // 開いていたら閉じる
        this.close(editor, touchControls, cameraSystem, displayTimeManager, mapPickMenu);
      }
      return;
    }

    if (!canToggleView) return;

    // ポーズ中も [M] でマップビューの切り替えを許可する

    if (input.takeKey(K.toggleMapMode)) { // 入力があったとき
      if (!this._mapMode) { // 閉じていたら開く
        this.open(editor, touchControls, cameraSystem, displayTimeManager);
        this._hud.hint(
          `軌道計画モード: 軌道をクリックしてノード配置 → ドラッグで移動・矢印ハンドルでΔv調整 → 右クリックでメニュー → [${K.toggleMapMode.label}] で確定`,
          5000,
        );
      }
      else { // 開いていたら閉じる
        this.close(editor, touchControls, cameraSystem, displayTimeManager, mapPickMenu);
        if (editor.plan.nodes.length > 0) {
          this._hud.hint(`マニューバ計画 ${editor.plan.nodes.length} 件確定 — [${K.autoWarpToNode.label}] で直近ノードへ自動ワープ`, 4500);
        }
      }
    }
  }
}
