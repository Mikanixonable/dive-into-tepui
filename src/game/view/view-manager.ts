// 選ばれたビューから、2ビューの表示実装と遷移時の表示フックを同期する。
import type { TouchControls } from '../hud/touch-controls';
import type { ViewSelectionSource } from '../viewer/view-selection';
import type { ViewMode } from './view-mode';
import type { ViewFrame } from './view-frame';

export class ViewManager {
  private displayedView: ViewMode;

  public get current(): ViewMode { return this.source.current; }

  public get isMapView(): boolean { return this.source.current === 'map'; }

  // 現在のビューの実装。ビューによるフレーム処理の分岐はこの1箇所に閉じる。
  public get activeView(): ViewFrame { return this.views[this.source.current]; }

  // source が選んだ初期ビューの表示フックを適用する。
  public constructor(
    private readonly source: ViewSelectionSource,
    private readonly touchControls: TouchControls | null,
    private readonly views: Record<ViewMode, ViewFrame>,
  ) {
    this.displayedView = source.current;
    this.views[this.displayedView].onEnter();
    this.touchControls?.setView(this.displayedView);
  }

  // source の選択が変わったとき、表示側の退出・入場とタッチ操作を1度だけ同期する。
  public sync(): void {
    const selected = this.source.current;
    if (selected === this.displayedView) return;
    this.views[this.displayedView].onLeave();
    this.views[selected].onEnter();
    this.touchControls?.setView(selected);
    this.displayedView = selected;
  }

  // 保持する両ビューの表示物・DOM を片付ける。
  public dispose(): void {
    for (const view of Object.values(this.views)) view.dispose();
  }

  // ビュー選択 UI に並べる遷移先 — 現在のビュー以外で、いま入れるもの。
  public selectableViews(): readonly ViewMode[] {
    return (Object.keys(this.views) as ViewMode[])
      .filter((view) => view !== this.source.current && this.source.canSelect(view));
  }
}
