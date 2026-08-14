// どのビューを表示しているかの正本と、ビュー間の遷移。戦闘・マップ・ドックは
// いずれも画面全体を占める対等なビューで、遷移は必ず setView() を通る。
import { Hud } from './hud/hud';
import { CameraSystem } from './camera/camera-system';
import { TouchControls } from './input/touch';
import type { Input } from './input/input';
import { KEY_MAPPING as K } from './input/key-mapping';
import { PlanEditor } from './plan/plan-editor';
import { DisplayWindowManager } from './display-window-manager';
import { MapContextActions } from './map-context-actions';
import type { Docking } from './docking';
import type { ActivePlayerController } from './active-player-controller';
import { setPanelCollapsedView } from './hud/panel-shell';
import type { OverlayHandle } from './hud/overlay-manager';

export type ViewId = 'combat' | 'map' | 'dock';

// 3D 世界を描くビュー。ドックはこのどちらかに重なる形で開き、閉じると元へ戻る。
export type WorldViewId = 'combat' | 'map';

// TODO: 戦闘⇔マップの切り替えと、ドックの開閉という2つの責務が同居している。分けるには
// 3つのビューを1つの排他選択として外へ見せている口(current / setView / selectableViews)を
// 2軸へ割る必要があり、ViewBadge のビュー選択 UI まで及ぶため現時点では容易ではない。
export class ViewManager {
  // ドック表示中も保持される 3D 側のビュー。カメラ・軌道計画の状態はこちらに従う。
  private worldView: WorldViewId;
  private isDockOpen = false;
  private docking: Docking | null = null;

  // ドックの開閉の正本はこのクラス(isDockOpen)自身であり続ける — OverlayManager へは
  // 「開いた/閉じた」を通知するだけの一方向で、この adapter は leaveDock() を呼び戻すのみ。
  private readonly dockOverlayHandle: OverlayHandle = {
    contains: (target) => this.docking?.dockView.element.contains(target) ?? false,
    close: () => this.leaveDock(),
  };

  get current(): ViewId { return this.isDockOpen ? 'dock' : this.worldView; }

  get isMapView(): boolean { return this.worldView === 'map'; }
  get isCombatView(): boolean { return this.worldView === 'combat'; }

  // このビューが 3D 世界を描くか。ドックは画面全体を不透明に覆い 3D 世界を持たない。
  get rendersWorld(): boolean { return !this.isDockOpen; }

  constructor(
    private readonly hud: Hud,
    private readonly editor: PlanEditor,
    private readonly cameraSystem: CameraSystem,
    private readonly displayWindow: DisplayWindowManager,
    private readonly mapActions: MapContextActions,
    private readonly activePlayers: ActivePlayerController,
    private readonly touchControls: TouchControls | null,
    requestedView?: WorldViewId,
  ) {
    // 戦闘ビューは操作対象艦を前提とするので、遷移と同じ規則で入れるビューへ落とす。
    const requested = requestedView ?? 'combat';
    this.worldView = this.canEnter(requested) ? requested : 'map';
    this.applyChrome();
  }

  // Docking は ViewManager より後に生成されるので、生成後に登録する。
  setDocking(docking: Docking): void {
    this.docking = docking;
  }

  // ビュー遷移の唯一の入口。遷移できない場合は何もしない。既に next にいる場合でも
  // applyChrome() は必ず走らせ、「この呼び出しの後、カメラ・計画編集・未来表示の各フラグは
  // 現在のビューに揃っている」という保証を遷移の有無に依らず成り立たせる。
  setView(next: ViewId): void {
    if (next === this.current) { this.applyChrome(); return; }
    if (!this.canEnter(next)) return;

    const prevWorld = this.worldView;
    const wasDockOpen = this.isDockOpen;
    if (this.isDockOpen) this.docking?.leaveDock();
    if (next === 'dock') {
      this.isDockOpen = true;
    } else {
      this.isDockOpen = false;
      this.worldView = next;
    }

    // 3D 側のビューが実際に変わるときだけマップの開閉処理を走らせる。マップ→ドックでは
    // 背後のマップを維持するので、計画編集の後始末(空ノードの間引き)を起こさない。
    const nextWorld = this.worldView;
    if (prevWorld !== nextWorld) {
      if (prevWorld === 'map') this.closeMap();
      if (nextWorld === 'map') this.openMap();
    }
    if (next === 'dock') this.docking?.enterDock();
    this.syncDockOverlay(wasDockOpen);
    this.applyChrome();
  }

  // ドックを閉じ、その裏で保たれていた 3D 側のビューへ戻る。
  leaveDock(): void {
    if (!this.isDockOpen) return;
    this.docking?.leaveDock();
    this.isDockOpen = false;
    this.hud.overlayManager.close('dock-view');
    this.applyChrome();
  }

  // isDockOpen が変化したフレームだけ OverlayManager 側の登録を追従させる。
  private syncDockOverlay(wasDockOpen: boolean): void {
    if (this.isDockOpen === wasDockOpen) return;
    if (this.isDockOpen) {
      this.hud.overlayManager.open('dock-view', this.dockOverlayHandle, {
        kind: 'modal', closeOnEscape: true, closeOnOutsideClick: false, gatesInput: true,
      });
    } else {
      this.hud.overlayManager.close('dock-view');
    }
  }

  // 現在の3D側ビュー(ドック表示中はその背後のビュー)をセーブデータへ書き出す。
  serializeView(): WorldViewId {
    return this.worldView;
  }

  // ビュー選択 UI に並べる遷移先。現在のビュー自身と、いま入れないビューは含まない。
  selectableViews(): readonly ViewId[] {
    const all: readonly ViewId[] = ['combat', 'map', 'dock'];
    return all.filter((v) => v !== this.current && this.canEnter(v));
  }

  // そのビューへいま入れるか。ドックは対象基地が要り、戦闘は操作対象の艦が要る。
  private canEnter(view: ViewId): boolean {
    if (view === 'dock') return this.docking?.canEnterDock() ?? false;
    if (view === 'combat') return this.activePlayers.current !== null;
    return true;
  }

  // 現在のビューに合わせて HUD の見た目と、カメラ・計画編集・未来表示・収納状態の各フラグを揃える。
  private applyChrome(): void {
    const map = this.worldView === 'map';
    setPanelCollapsedView(map ? 'map' : 'combat');
    this.hud.setWorldView(map ? 'map' : 'combat');
    this.hud.root.classList.toggle('dock-mode', this.isDockOpen);
    this.touchControls?.setMapMode(map);
    this.cameraSystem.setMapMode(map);
    this.editor.setMapMode(map);
    this.displayWindow.forceCurrent = !map;
  }

  // マップへ入るときの支度。
  private openMap(): void {
    this.editor.selectedNodeIdx = null;
  }

  // マップから出るときの後始末。開いたままの編集 UI とメニューを畳む。
  private closeMap(): void {
    this.editor.onMapClosed();
    this.editor.closeMenu();
    this.mapActions.close();
  }

  // [M] による戦闘⇔マップの切り替えを受ける。ドック表示中はキーを消費しない。
  handleInput(input: Input): void {
    if (this.isDockOpen) return;
    if (!input.takeKey(K.toggleMapMode)) return;

    if (this.current === 'map') {
      if (!this.canEnter('combat')) {
        this.hud.hint('操作できる艦がいません');
        return;
      }
      this.setView('combat');
      const nodeCount = this.editor.plan?.nodes.length ?? 0;
      if (nodeCount > 0) {
        this.hud.hint(`マニューバ計画 ${nodeCount} 件確定 — [${K.autoWarpToNode.label}] で直近ノードへ自動ワープ`, 4500);
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
