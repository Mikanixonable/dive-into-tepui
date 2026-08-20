// どのビューを表示しているかの正本と、ビュー間の遷移。3D 世界を描くビューは運用とマップの
// 2つで、遷移は必ず setView() を通る。基地の操作と艦体の組立は、そのどちらの上にも重なる
// ウィンドウとして開く(Docking が持つ)。
import { Hud } from './hud/hud';
import { CameraSystem } from './camera/camera-system';
import { TouchControls } from './input/touch';
import type { Input } from './input/input';
import { KEY_MAPPING as K } from './input/key-mapping';
import { PlanEditor } from './plan/plan-editor';
import { DisplayWindowManager } from './display-window-manager';
import { MapContextActions } from './map-context-actions';
import type { Docking } from './docking';
import type { ActiveVesselController } from './active-vessel-controller';
import { setPanelCollapsedView } from './hud/panel-shell';
import type { Vessel } from './vessel/vessel';

// 'dock' は過去のセーブが持ちうる値としてだけ残る。遷移先として選ぶ経路は無い。
export type ViewId = 'combat' | 'map' | 'dock';

export interface ViewMenuItem {
  readonly id: string;
  readonly label: string;
  readonly viewId: ViewId;
}

// 3D 世界を描くビュー。
export type WorldViewId = 'combat' | 'map';

export class ViewManager {
  // カメラ・軌道計画の状態が従うビュー。
  private worldView: WorldViewId;
  private docking: Docking | null = null;
  private controlledBaseProvider: (() => Vessel | null) | null = null;

  get current(): ViewId { return this.worldView; }

  get isMapView(): boolean { return this.worldView === 'map'; }
  get isCombatView(): boolean { return this.worldView === 'combat'; }

  get rendersWorld(): boolean { return true; }

  constructor(
    private readonly hud: Hud,
    private readonly editor: PlanEditor,
    private readonly cameraSystem: CameraSystem,
    private readonly displayWindow: DisplayWindowManager,
    private readonly mapActions: MapContextActions,
    private readonly activeVessels: ActiveVesselController,
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

  setControlledBaseProvider(provider: () => Vessel | null): void {
    this.controlledBaseProvider = provider;
  }

  // ビュー遷移の唯一の入口。遷移できない場合は何もしない。既に next にいる場合でも
  // applyChrome() は必ず走らせ、「この呼び出しの後、カメラ・計画編集・未来表示の各フラグは
  // 現在のビューに揃っている」という保証を遷移の有無に依らず成り立たせる。
  setView(next: ViewId): void {
    if (next === 'dock') return;
    if (next === this.current) { this.applyChrome(); return; }
    if (!this.canEnter(next)) return;

    const prev = this.worldView;
    this.worldView = next;
    if (prev === 'map') this.leaveMap();
    if (next === 'map') this.enterMap();
    this.applyChrome();
  }

  dispose(): void {}

  // 現在のビューをセーブデータへ書き出す。
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
        items.push({ id: 'combat', label: 'Operations', viewId: 'combat' });
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

  // そのビューへいま入れるか。運用ビューは見る対象(操作艦か基地)が要る。
  private canEnter(view: ViewId): boolean {
    if (view === 'dock') return false;
    if (view === 'combat') {
      return this.activeVessels.current !== null
        || (this.controlledBaseProvider?.() ?? null) !== null
        || (this.docking?.getAvailableBases().length ?? 0) > 0;
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
