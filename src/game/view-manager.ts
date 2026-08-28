// どのワールドビューを表示しているかの正本。遷移は必ず setView() を通る。
import { Hud } from './hud/hud';
import { CameraSystem } from './camera/camera-system';
import { TouchControls } from './input/touch';
import type { Input } from './input/input';
import { KEY_MAPPING as K } from './input/key-mapping';
import { PlanEditor } from './plan/plan-editor';
import { DisplayWindowManager } from './display-window-manager';
import { MapContextActions } from './pickable/map-context-actions';
import type { ActiveControllableController } from './active-controllable-controller';
import { setPanelCollapsedView } from './hud/panel-shell';
import type { Base } from './game-entity/base';

export type ViewId = 'combat' | 'map';

export interface ViewMenuItem {
  readonly id: string;
  readonly label: string;
  readonly viewId: ViewId;
}

export type WorldViewId = 'combat' | 'map';

export class ViewManager {
  private worldView: WorldViewId;
  private controlledBaseProvider: (() => Base | null) | null = null;

  get current(): ViewId { return this.worldView; }

  get isMapView(): boolean { return this.worldView === 'map'; }
  get isCombatView(): boolean { return this.worldView === 'combat'; }

  constructor(
    private readonly hud: Hud,
    private readonly editor: PlanEditor,
    private readonly cameraSystem: CameraSystem,
    private readonly displayWindow: DisplayWindowManager,
    private readonly mapActions: MapContextActions,
    private readonly activePlayers: ActiveControllableController,
    private readonly touchControls: TouchControls | null,
    requestedView?: WorldViewId,
  ) {
    // 戦闘ビューは操作対象艦を前提とするので、遷移と同じ規則で入れるビューへ落とす。
    const requested = requestedView ?? 'combat';
    this.worldView = this.canEnter(requested) ? requested : 'map';
    this.applyChrome();
  }

  setControlledBaseProvider(provider: () => Base | null): void {
    this.controlledBaseProvider = provider;
  }

  // ビュー遷移の唯一の入口。遷移できない場合は何もしない。既に next にいる場合でも
  // applyChrome() は必ず走らせ、「この呼び出しの後、カメラ・計画編集・未来表示の各フラグは
  // 現在のビューに揃っている」という保証を遷移の有無に依らず成り立たせる。
  setView(next: ViewId): void {
    if (next === this.current) { this.applyChrome(); return; }
    if (!this.canEnter(next)) return;

    const prevWorld = this.worldView;
    this.worldView = next;

    // ビューが実際に変わるときだけマップの開閉処理を走らせる。
    const nextWorld = this.worldView;
    if (prevWorld !== nextWorld) {
      if (prevWorld === 'map') this.leaveMap();
      if (nextWorld === 'map') this.enterMap();
    }
    this.applyChrome();
  }

  serializeView(): WorldViewId {
    return this.worldView;
  }

  // ビュー選択 UI に並べる遷移先。現在のビュー自身と、いま入れないビューは含まない。
  selectableViews(): readonly ViewId[] {
    const all: readonly ViewId[] = ['combat', 'map'];
    return all.filter((v) => v !== this.current && this.canEnter(v));
  }

  // ビュー選択 UI に並べる詳細な遷移項目の一覧を取得する。
  getSelectableMenuItems(): readonly ViewMenuItem[] {
    const items: ViewMenuItem[] = [];

    if (this.current !== 'combat' && this.canEnter('combat')) {
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

  // 戦闘ビューは操作対象の艦または基地が必要。
  private canEnter(view: ViewId): boolean {
    if (view === 'combat') {
      return this.activePlayers.current !== null
        || (this.controlledBaseProvider?.() ?? null) !== null;
    }
    return true;
  }

  // 現在のビューに合わせて HUD の見た目と、カメラ・計画編集・未来表示・収納状態の各フラグを揃える。
  private applyChrome(): void {
    const map = this.worldView === 'map';
    setPanelCollapsedView(map ? 'map' : 'combat');
    this.hud.setWorldView(map ? 'map' : 'combat');
    this.touchControls?.setMapMode(map);
    this.cameraSystem.setMapMode(map);
    this.editor.setMapMode(map);
    this.displayWindow.forceCurrent = !map;
  }

  // マップへ入るときの支度。
  private enterMap(): void {
    this.editor.selectedNodeIdx = null;
  }

  // マップから出るときの後始末。開いたままの編集 UI とメニューを畳む。
  private leaveMap(): void {
    this.editor.onMapClosed();
    this.editor.closeMenu();
    this.mapActions.close();
  }

  // [M] による戦闘⇔マップの切り替えを受ける。
  handleInput(input: Input): void {
    if (!input.takeKey(K.toggleMapMode)) return;

    if (this.current === 'map') {
      if (!this.canEnter('combat')) {
        this.hud.hint('操作できる艦または基地がいません');
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
