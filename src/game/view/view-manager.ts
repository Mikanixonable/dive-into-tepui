// どのビューを表示しているかの正本と、2ビューの実装の保持。遷移は必ず setView() を通る。
import { Hud } from '../hud/hud';
import { TouchControls } from '../hud/touch-controls';
import type { Input } from '../../input/input';
import { KEY_MAPPING as K } from '../../input/key-mapping';
import type { ControlSelection } from '../control-selection';
import type { ViewMode } from '../../render/view-mode';
import type { ViewFrame } from './view-frame';

export class ViewManager {
  private view: ViewMode;

  public get current(): ViewMode { return this.view; }

  public get isMapView(): boolean { return this.view === 'map'; }

  // 現在のビューの実装。ビューによるフレーム処理の分岐はこの1箇所に閉じる。
  public get activeView(): ViewFrame { return this.views[this.view]; }

  // requestedView のビューで始める。入れないビューならマップで始める。
  public constructor(
    private readonly hud: Hud,
    private readonly touchControls: TouchControls | null,
    private readonly controlSelection: ControlSelection,
    private readonly views: Record<ViewMode, ViewFrame>,
    requestedView?: ViewMode,
  ) {
    // セーブ由来の未検証の値を、ビュー id へ丸める。
    const requested: ViewMode = requestedView === 'map' ? 'map' : 'combat';
    this.view = this.views[requested].canEnter() ? requested : 'map';
    this.views[this.view].onEnter();
    this.touchControls?.setView(this.view);
  }

  // ビュー遷移の唯一の入口。next にいる状態で終われたかを返し、入れないビューなら何もしない。
  // 呼んだ後は遷移の有無に依らず、タッチ操作パッドが現在のビューに揃う。
  public setView(next: ViewMode): boolean {
    if (next === this.current) { this.touchControls?.setView(next); return true; }
    if (!this.views[next].canEnter()) return false;

    const prev = this.view;
    this.view = next;
    this.views[prev].onLeave();
    this.views[next].onEnter();
    this.touchControls?.setView(next);
    return true;
  }

  // 保持する両ビューの表示物・DOM を片付ける。
  public dispose(): void {
    for (const view of Object.values(this.views)) view.dispose();
  }

  // ビュー選択 UI に並べる遷移先 — 現在のビュー以外で、いま入れるもの。
  public selectableViews(): readonly ViewMode[] {
    return (Object.keys(this.views) as ViewMode[])
      .filter((v) => v !== this.view && this.views[v].canEnter());
  }

  // [M] による戦闘⇔マップの切り替えを受ける。
  public handleInput(input: Input): void {
    if (!input.takeKey(K.toggleMapMode)) return;

    // マップから戦闘へ。入れなければその旨を、計画があれば確定したことを知らせる。
    if (this.current === 'map') {
      if (!this.setView('combat')) {
        this.hud.hint('操作できる艦または基地がいません');
        return;
      }
      const nodeCount = this.controlSelection.current?.plan.nodes.length ?? 0;
      if (nodeCount > 0) {
        this.hud.hint(`マニューバ計画 ${nodeCount} 件確定 — [${K.autoWarpToNode.label}] で直近ノードへ自動ワープ`, 4500);
      }
      return;
    }

    // 戦闘からマップへ。軌道計画の手引きを出す。
    if (this.setView('map')) {
      this.hud.hint(
        `軌道計画モード: 軌道をクリックしてノード配置 → ドラッグで移動・矢印ハンドルでΔv調整 → 右クリックでメニュー → [${K.toggleMapMode.label}] で確定`,
        5000,
      );
    }
  }
}
