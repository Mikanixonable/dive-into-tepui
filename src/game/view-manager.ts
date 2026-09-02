// どのワールドビューを表示しているかの正本と、2ビューの実装の保持。遷移は必ず setView() を通る。
import { Hud } from './hud/hud';
import { TouchControls } from './input/touch';
import type { Input } from './input/input';
import { KEY_MAPPING as K } from './input/key-mapping';
import { DisplayWindowManager } from './display-window-manager';
import type { ActiveControllableController } from './active-controllable-controller';
import { setPanelCollapsedView } from './hud/panel-shell';
import type { WorldViewFrame } from './world-view';

export type WorldView = 'combat' | 'map';

export class ViewManager {
  private worldView: WorldView;

  get current(): WorldView { return this.worldView; }

  get isMapView(): boolean { return this.worldView === 'map'; }
  get isCombatView(): boolean { return this.worldView === 'combat'; }

  // 現在のビューの実装。ビューによるフレーム処理の分岐はこの1箇所に閉じる。
  get activeView(): WorldViewFrame { return this.views[this.worldView]; }

  constructor(
    private readonly hud: Hud,
    private readonly touchControls: TouchControls | null,
    private readonly displayWindow: DisplayWindowManager,
    private readonly activePlayers: ActiveControllableController,
    private readonly views: Record<WorldView, WorldViewFrame>,
    requestedView?: WorldView,
  ) {
    // セーブ由来の値は検証されていないため、ビュー id として読めるものだけを受ける。
    // 入れないビューが要求されたら、遷移と同じ規則でマップへ落とす。
    const requested: WorldView = requestedView === 'map' ? 'map' : 'combat';
    this.worldView = this.views[requested].canEnter() ? requested : 'map';
    this.views[this.worldView].onEnter();
    this.applyChrome();
  }

  // ビュー遷移の唯一の入口。next にいる状態で終われたかを返し、入れないビューなら何もしない。
  // 既に next にいる場合でも applyChrome() は必ず走らせ、「この呼び出しの後、HUD・タッチ・
  // 未来表示の各フラグは現在のビューに揃っている」という保証を遷移の有無に依らず成り立たせる。
  setView(next: WorldView): boolean {
    if (next === this.current) { this.applyChrome(); return true; }
    if (!this.views[next].canEnter()) return false;

    const prev = this.worldView;
    this.worldView = next;
    this.views[prev].onLeave();
    this.views[next].onEnter();
    this.applyChrome();
    return true;
  }

  serializeView(): WorldView {
    return this.worldView;
  }

  // ビュー選択 UI に並べる遷移先。現在のビュー自身と、いま入れないビューは含まない。
  selectableViews(): readonly WorldView[] {
    const all: readonly WorldView[] = ['combat', 'map'];
    return all.filter((v) => v !== this.current && this.views[v].canEnter());
  }

  // 現在のビューに合わせて HUD の見た目と、未来表示・収納状態の各フラグを揃える。
  private applyChrome(): void {
    setPanelCollapsedView(this.worldView);
    this.hud.setWorldView(this.worldView);
    this.touchControls?.setWorldView(this.worldView);
    this.displayWindow.forceCurrent = this.worldView !== 'map';
  }

  // [M] による戦闘⇔マップの切り替えを受ける。
  handleInput(input: Input): void {
    if (!input.takeKey(K.toggleMapMode)) return;

    if (this.current === 'map') {
      if (!this.setView('combat')) {
        this.hud.hint('操作できる艦または基地がいません');
        return;
      }
      const nodeCount = this.activePlayers.currentControllable?.plan.nodes.length ?? 0;
      if (nodeCount > 0) {
        this.hud.hint(`マニューバ計画 ${nodeCount} 件確定 — [${K.autoWarpToNode.label}] で直近ノードへ自動ワープ`, 4500);
      }
      return;
    }

    if (this.setView('map')) {
      this.hud.hint(
        `軌道計画モード: 軌道をクリックしてノード配置 → ドラッグで移動・矢印ハンドルでΔv調整 → 右クリックでメニュー → [${K.toggleMapMode.label}] で確定`,
        5000,
      );
    }
  }
}
