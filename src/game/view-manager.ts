// どのビューを表示しているかの正本と、ビュー間の遷移。戦闘・マップ・ドックは
// いずれも画面全体を占める対等なビューで、遷移は必ず setView() を通る。
import { Hud } from './hud/hud';
import { CameraSystem } from './camera/camera-system';
import { TouchControls } from './input/touch';
import type { Input } from './input/input';
import { KEY_MAPPING as K } from './input/key-mapping';
import { PlanEditor } from './plan/plan-editor';
import { DisplayTimeManager } from './display-time-manager';
import { MapPicker } from './map-picker';
import type { Docking } from './docking';
import { resetHudDocks, syncNavballPlacement, syncOrbitPlacement } from './hud/dom';

export type ViewId = 'combat' | 'map' | 'dock';

// 3D 世界を描くビュー。ドックはこのどちらかに重なる形で開き、閉じると元へ戻る。
type WorldViewId = 'combat' | 'map';

export class ViewManager {
  private _current: ViewId;
  private returnFromDock: WorldViewId = 'map';
  private touchControls: TouchControls | null = null;
  private docking: Docking | null = null;

  get current(): ViewId { return this._current; }

  // ドック表示中に背後で維持している 3D 側のビュー。カメラ・軌道計画の状態はこちらに従う。
  private get worldView(): WorldViewId {
    return this._current === 'dock' ? this.returnFromDock : this._current;
  }

  constructor(
    private readonly hud: Hud,
    private readonly editor: PlanEditor,
    private readonly cameraSystem: CameraSystem,
    private readonly displayTimeManager: DisplayTimeManager,
    private readonly mapPicker: MapPicker,
    initialView: ViewId = 'combat',
  ) {
    this._current = initialView;
    this.applyChrome();
  }

  // タッチ UI は Input より後に生成されるので、生成後に登録する。
  setTouchControls(controls: TouchControls | null): void {
    this.touchControls = controls;
    controls?.setMapMode(this.worldView === 'map');
  }

  // Docking は ViewManager より後に生成されるので、生成後に登録する。
  setDocking(docking: Docking): void {
    this.docking = docking;
  }

  // ビュー遷移の唯一の入口。遷移できない場合は何もしない。
  setView(next: ViewId): void {
    if (next === this._current) return;
    if (!this.canEnter(next)) return;

    const prevWorld = this.worldView;
    if (this._current === 'dock') this.docking?.leaveDock();
    if (next === 'dock') this.returnFromDock = prevWorld;
    this._current = next;

    // 3D 側のビューが実際に変わるときだけマップの開閉処理を走らせる。マップ→ドックでは
    // 背後のマップを維持するので、計画編集の後始末(空ノードの間引き)を起こさない。
    const nextWorld = this.worldView;
    if (prevWorld !== nextWorld) {
      if (prevWorld === 'map') this.closeMap();
      if (nextWorld === 'map') this.openMap();
    }
    if (next === 'dock') this.docking?.enterDock();
    this.applyChrome();
  }

  // ドックから、開く前のビューへ戻る。
  leaveDock(): void {
    if (this._current === 'dock') this.setView(this.returnFromDock);
  }

  // ビュー選択 UI に並べる遷移先。現在のビュー自身と、いま入れないビューは含まない。
  // combatAvailable は操作対象の艦が生存しているか(戦闘ビューは自機を前提とする)。
  selectableViews(combatAvailable: boolean): readonly ViewId[] {
    const all: readonly ViewId[] = ['combat', 'map', 'dock'];
    return all.filter((v) => v !== this._current && this.canEnter(v, combatAvailable));
  }

  // そのビューへいま入れるか。ドックは対象基地が要り、戦闘は操作できる艦が要る。
  private canEnter(view: ViewId, combatAvailable = true): boolean {
    if (view === 'dock') return this.docking?.canEnterDock() ?? false;
    if (view === 'combat') return combatAvailable;
    return true;
  }

  // 現在のビューに合わせて HUD の見た目と、カメラ・計画編集・未来表示の各フラグを揃える。
  private applyChrome(): void {
    const map = this.worldView === 'map';
    this.hud.root.classList.toggle('map-mode', map);
    this.hud.root.classList.toggle('dock-mode', this._current === 'dock');
    syncNavballPlacement(this.hud.root, map);
    syncOrbitPlacement(this.hud.root, map);
    if (!map) resetHudDocks(this.hud.root);
    this.touchControls?.setMapMode(map);
    this.cameraSystem.setMapMode(map);
    this.editor.setMapMode(map);
    this.displayTimeManager.forceCurrent = !map;
  }

  // マップへ入るときの支度。
  private openMap(): void {
    this.editor.selectedNodeIdx = null;
  }

  // マップから出るときの後始末。開いたままの編集 UI とメニューを畳む。
  private closeMap(): void {
    this.editor.onMapClosed();
    this.editor.closeMenu();
    this.mapPicker.close();
  }

  // [M] による戦闘⇔マップの切り替えを受ける。ドック表示中はキーを消費しない。
  handleInput(input: Input, isPlaying: boolean, canToggleView: boolean): void {
    // 決着後はどのビューに居ても戦闘ビューへ戻す(結果画面を隠さないため)。
    if (!isPlaying) {
      if (this._current === 'dock') this.leaveDock();
      if (this._current === 'map') this.setView('combat');
      return;
    }
    if (this._current === 'dock') return;
    if (!canToggleView || !input.takeKey(K.toggleMapMode)) return;

    if (this._current === 'map') {
      this.setView('combat');
      if (this.editor.plan.nodes.length > 0) {
        this.hud.hint(`マニューバ計画 ${this.editor.plan.nodes.length} 件確定 — [${K.autoWarpToNode.label}] で直近ノードへ自動ワープ`, 4500);
      }
      return;
    }

    this.setView('map');
    this.hud.hint(
      `軌道計画モード: 軌道をクリックしてノード配置 → ドラッグで移動・矢印ハンドルでΔv調整 → 右クリックでメニュー → [${K.toggleMapMode.label}] で確定`,
      5000,
    );
  }
}
