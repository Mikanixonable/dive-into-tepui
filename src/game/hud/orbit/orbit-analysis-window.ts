// 軌道分析のドラッグ可能ウィンドウ。高度・接近・投影の3タブのうち、いま選べるものをタブバーへ
// 出し、選択中のタブへ描画を委ねる。
import { SyncThrottle } from '../sync-throttle';
import { DraggableWindow } from '../../../hud/windows/draggable-window';
import { MQ_COMPACT } from '../../../hud/breakpoints';
import { TabBar } from '../../../hud/widgets';
import { injectOnce } from '../../../hud/inject-style';
import { UNCLIPPED_WINDOW_GROUP } from '../../../hud/overlay-manager';
import { AltitudeTab } from './orbit-altitude-tab';
import { ApproachTab } from './orbit-approach-tab';
import { ProjectionTab } from './orbit-projection-tab';
import type { DynamicEntity } from '../../dynamic/dynamic-entity/dynamic-entity';
import type { OverlayManager } from '../../../hud/overlay-manager';
import type { OrbitReference } from '../../orbit-reference';
import type { ApproachTargetSource } from './orbit-analysis-data';
import type { AnalysisChartSource, AnalysisTab } from './orbit-analysis-tab';

const SYNC_INTERVAL_MS = 250;

// 軌道分析が描く相手 — 操作対象と、その軌道の基準、接近/投影タブが比べる対象。
export interface OrbitAnalysisSubject {
  readonly entity: DynamicEntity;
  readonly reference: OrbitReference;
  // 接近/投影タブが扱えない(質量を持たない・未選択)ときは null。
  readonly target: ApproachTargetSource | null;
}

const STYLE = `
#hud .dg-window.orbit-analysis { max-width: 420px; }
@media ${MQ_COMPACT} {
  #hud .dg-window.orbit-analysis { max-width: 100%; }
}
`;

export class OrbitAnalysisWindow {
  private readonly win: DraggableWindow;
  private readonly tabBar: TabBar<AnalysisTab>;
  // 高度タブは常に選べるので、他のタブが選べなくなったときの戻り先になる。
  private readonly altitudeTab = new AltitudeTab();
  private readonly tabs: readonly AnalysisTab[];
  private selected: AnalysisTab = this.altitudeTab;
  private readonly throttle = new SyncThrottle(SYNC_INTERVAL_MS);
  // 直前に描いた操作対象。切り替わったフレームでタブの表示範囲を開き直す。
  private drawnEntity: DynamicEntity | null = null;

  // ESC・外側クリック・✕ ボタンのどの経路で閉じても発火する。
  public onClose: (() => void) | null = null;

  // (clientX, clientY) にウィンドウを開き、高度タブを選んだ状態にする。
  public constructor(
    clientX: number, clientY: number, overlayManager: OverlayManager,
  ) {
    // ウィンドウの器。
    injectOnce('orbit-analysis-window', STYLE);
    this.win = new DraggableWindow(
      clientX, clientY,
      { title: '軌道分析', initiallyClipped: true, unclippedWindowGroup: UNCLIPPED_WINDOW_GROUP }, overlayManager,
    );
    this.win.element.classList.add('orbit-analysis');
    this.win.onClose = () => this.onClose?.();

    // 3タブを積み、選択中の1つだけが見える状態にする。
    this.tabs = [this.altitudeTab, new ApproachTab(), new ProjectionTab()];
    this.tabBar = new TabBar<AnalysisTab>([[this.altitudeTab, this.altitudeTab.label]], (tab) => this.select(tab));
    this.win.body.appendChild(this.tabBar.element);
    for (const tab of this.tabs) this.win.body.appendChild(tab.element);
    this.select(this.altitudeTab);
  }

  // ウィンドウを最前面へ持ち上げる。
  public bringToFront(): void {
    this.win.bringToFront();
  }

  // ウィンドウと各タブの資源を取り除く。以後このインスタンスは使えない。
  public dispose(): void {
    this.win.dispose();
    for (const tab of this.tabs) tab.dispose();
  }

  // 選べるタブを出し直してから、選択中のタブへ描画を委ねる。
  // subject が null なら操作対象が無いので、その旨だけを高度タブへ出す。
  public sync(source: AnalysisChartSource, subject: OrbitAnalysisSubject | null, nowMs: number): void {
    if (!this.throttle.due(nowMs)) return;
    const entity = subject?.entity ?? null;
    // 別の対象を見ることになるので、各タブの表示範囲を開き直す。
    if (entity !== this.drawnEntity) {
      for (const tab of this.tabs) tab.resetView();
    }
    this.drawnEntity = entity;
    if (!subject) {
      this.offerTabs([this.altitudeTab]);
      this.altitudeTab.drawMessage('操作対象がありません', source.palette);
      return;
    }

    const { reference, target } = subject;
    this.offerTabs(this.tabs.filter((tab) => tab.available(source, subject.entity, reference, target)));
    this.selected.draw(source, subject.entity, reference, target);
  }

  // 選べるタブだけをタブバーへ出し、選択中が選べなくなっていたら高度タブへ戻す。
  private offerTabs(selectable: readonly AnalysisTab[]): void {
    this.tabBar.setItems(selectable.map((tab) => [tab, tab.label] as const));
    if (selectable.includes(this.selected)) this.tabBar.setSelected(this.selected);
    else this.select(this.altitudeTab);
  }

  // タブを切り替え、表示範囲を開いた時点の状態へ戻し、そのタブの要素だけを見せる。
  private select(tab: AnalysisTab): void {
    this.selected = tab;
    tab.resetView();
    this.tabBar.setSelected(tab);
    for (const other of this.tabs) other.element.classList.toggle('hidden', other !== tab);
  }
}
