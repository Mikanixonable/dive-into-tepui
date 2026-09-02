// どのワールドビューを表示しているかの正本と、2ビューの実装の保持。遷移は必ず setView() を
// 通り、遷移の可否・支度・後始末は各ビュー(WorldViewFrame)のフックが持つ。
import { Hud } from './hud/hud';
import { TouchControls } from './input/touch';
import type { Input } from './input/input';
import { KEY_MAPPING as K } from './input/key-mapping';
import { DisplayWindowManager } from './display-window-manager';
import type { ActiveControllableController } from './active-controllable-controller';
import { setPanelCollapsedView } from './hud/panel-shell';
import type { WorldViewFrame } from './world-view';

export type WorldView = 'combat' | 'map';

interface ViewMenuItem {
  readonly id: string;
  readonly label: string;
  readonly viewId: WorldView;
}

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
    // 入れないビューが要求されたら、遷移と同じ規則でマップへ落とす。
    const requested = requestedView ?? 'combat';
    this.worldView = this.views[requested].canEnter() ? requested : 'map';
    this.applyChrome();
  }

  // ビュー遷移の唯一の入口。遷移できない場合は何もしない。既に next にいる場合でも
  // applyChrome() は必ず走らせ、「この呼び出しの後、HUD・タッチ・未来表示の各フラグは
  // 現在のビューに揃っている」という保証を遷移の有無に依らず成り立たせる。
  setView(next: WorldView): void {
    if (next === this.current) { this.applyChrome(); return; }
    if (!this.views[next].canEnter()) return;

    const prev = this.worldView;
    this.worldView = next;
    this.views[prev].onLeave();
    this.views[next].onEnter();
    this.applyChrome();
  }

  serializeView(): WorldView {
    return this.worldView;
  }

  // ビュー選択 UI に並べる遷移先。現在のビュー自身と、いま入れないビューは含まない。
  selectableViews(): readonly WorldView[] {
    const all: readonly WorldView[] = ['combat', 'map'];
    return all.filter((v) => v !== this.current && this.views[v].canEnter());
  }

  // ビュー選択 UI に並べる詳細な遷移項目の一覧を取得する。
  getSelectableMenuItems(): readonly ViewMenuItem[] {
    const items: ViewMenuItem[] = [];

    if (this.current !== 'combat' && this.views.combat.canEnter()) {
      items.push({ id: 'combat', label: 'Combat', viewId: 'combat' });
    }

    if (this.current !== 'map') {
      items.push({ id: 'map', label: 'Map', viewId: 'map' });
    }

    return items;
  }

  // ビュー選択 UI で選ばれた項目を実行する。
  selectMenuItem(item: ViewMenuItem): void {
    this.setView(item.viewId);
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
      if (!this.views.combat.canEnter()) {
        this.hud.hint('操作できる艦または基地がいません');
        return;
      }
      this.setView('combat');
      const nodeCount = this.activePlayers.currentControllable?.plan.nodes.length ?? 0;
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
