// 基地パネル: 基地のプロパティウィンドウ内へ展開する運用UI。
// 格納されている船の一覧、部品の確認・修理・換装、ショップを提供する。
import type { Base } from '../../game-entity/base';
import type { Player } from '../../player/player';
import { CloseButton, TabBar } from '../widgets';
import { MQ_COMPACT, MQ_SHORT } from '../breakpoints';
import type { BasePanelContext } from './base-view-context';
import { VesselsTabController } from './base-view-vessels-tab';
import { PartsTabController } from './base-view-parts-tab';
import { ShopTabController } from './base-view-shop-tab';

const STYLE = `
/* プロパティウィンドウ内の展開パネル。 */
#base-view.base-panel {
  display: flex; width: 100%; min-width: 0;
  box-sizing: border-box;
  background: transparent;
  color: var(--body);
  font-family: var(--font-neutral, var(--font-family));
  pointer-events: auto;
}
#base-view .dock-panel {
  width: 100%; min-width: 0; min-height: 0;
  display: flex; flex-direction: column;
}
#base-view .dock-header {
  display: grid; grid-template-columns: minmax(180px, 0.72fr) minmax(300px, 1.4fr) auto;
  align-items: center; gap: var(--space-6);
  flex: 0 0 auto; padding: 15px 17px 11px;
  border-radius: var(--radius-window) var(--radius-window) 0 0;
  background: var(--surface-1);
}
#base-view .dock-title-group { min-width: 0; }
#base-view .dock-kicker {
  display: block; margin-bottom: var(--space-2);
  color: var(--color-primary); font-size: var(--font-xs); line-height: 1.3;
}
#base-view .dock-title {
  display: block; margin: 0; color: var(--title);
  font-size: var(--font-2xl); font-weight: 500; line-height: 1; letter-spacing: -0.035em;
}
#base-view .dock-subtitle {
  display: block; margin-top: var(--space-2);
  color: var(--muted); font-size: var(--font-s); line-height: 1.4;
}
#base-view .dock-tabs { min-width: 0; justify-content: center; }
#base-view .dock-tabs .w-btn {
  min-height: 34px; padding: 7px 11px;
  border: 0; border-radius: var(--radius-control);
  background: transparent; color: var(--muted);
}
#base-view .dock-tabs .w-btn:hover { background: var(--surface-2); color: var(--color-primary-hover); }
#base-view .dock-tabs .w-btn.on { background: var(--color-primary-fill); color: var(--color-primary); }
#base-view .w-close {
  width: 34px; height: 34px; border: 0; border-radius: var(--radius-control);
  background: var(--surface-2); color: var(--muted);
}
#base-view .w-close:hover { background: var(--surface-3); color: var(--color-primary-hover); }
#base-view .dock-status-bar {
  flex: 0 0 auto; padding: 0 17px 13px;
  border-radius: 0 0 var(--radius-window) var(--radius-window);
  background: var(--surface-1); color: var(--muted);
  font-size: var(--font-s); font-variant-numeric: tabular-nums;
}
#base-view .dock-status-bar::before {
  content: "∗"; margin-right: var(--space-3); color: var(--color-signal);
}
#base-view .dock-body {
  flex: 1 1 0; min-height: 0; margin-top: 9px; padding: var(--space-6) 0;
  overflow-y: auto; scrollbar-width: thin; outline: none;
}
#base-view .dock-body:focus-visible,
#base-view .dock-ship-select:focus-visible,
#base-view .dock-part-swap-select:focus-visible,
#base-view .w-btn:focus-visible,
#base-view .w-close:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 3px; }
#base-view .dock-section { display: flex; flex-direction: column; gap: 9px; }
#base-view .dock-section-head {
  display: flex; align-items: flex-end; justify-content: space-between; gap: var(--space-6);
  padding: 0 var(--space-2) var(--space-5);
}
#base-view .dock-section-copy { min-width: 0; }
#base-view .dock-section-title {
  margin: 0; color: var(--title); font-size: var(--font-xl); font-weight: 600; line-height: 1.3;
}
#base-view .dock-section-description {
  margin: var(--space-2) 0 0; color: var(--muted); font-size: var(--font-s); line-height: 1.55;
}
#base-view .dock-section-count {
  flex: 0 0 auto; padding: 5px 8px; border-radius: var(--radius-control);
  background: var(--surface-1); color: var(--muted); font-size: var(--font-xs);
  font-variant-numeric: tabular-nums;
}
#base-view .dock-empty {
  padding: var(--space-6); border-radius: var(--radius-panel);
  background: var(--surface-1); color: var(--muted); text-align: center; line-height: 1.8;
}
/* Ships tab */
#base-view .dock-ship-list { display: flex; flex-direction: column; gap: 7px; }
#base-view .dock-ship-row {
  position: relative; display: flex; align-items: center; gap: var(--space-5);
  padding: 9px 12px; border-radius: var(--radius-panel); background: var(--surface-1);
  transition: color var(--transition-fast), background var(--transition-fast), box-shadow var(--transition-fast);
}
#base-view .dock-ship-row:hover:not(.is-selected) { background: var(--surface-2); }
#base-view .dock-ship-row.is-selected {
  background: var(--glass-focus); backdrop-filter: blur(20px) saturate(82%);
  -webkit-backdrop-filter: blur(20px) saturate(82%);
  box-shadow: 0 16px 48px var(--shadow, var(--shade-1));
}
#base-view .dock-ship-row.is-selected::before {
  content: ""; position: absolute; top: 12px; bottom: 12px; left: 6px; width: 3px;
  border-radius: var(--radius-control); background: var(--color-primary);
}
#base-view .dock-ship-select {
  flex: 1 1 auto; min-width: 0; display: block; padding: var(--space-3) var(--space-4);
  border: 0; border-radius: var(--radius-control); background: transparent; color: inherit;
  font: inherit; text-align: left; cursor: pointer;
}
#base-view .dock-ship-info { flex: 1; display: flex; flex-direction: column; gap: var(--space-1); }
#base-view .dock-ship-name { color: var(--title); font-size: var(--font-l); font-weight: 500; }
#base-view .dock-ship-row:not(.is-selected) .dock-ship-select:hover .dock-ship-name { color: var(--color-primary-hover); }
#base-view .dock-ship-row.is-selected .dock-ship-name { color: var(--color-primary); }
#base-view .dock-ship-hp { color: var(--muted); font-size: var(--font-s); font-variant-numeric: tabular-nums; }
#base-view .dock-ship-row.is-critical .dock-ship-hp { color: var(--color-error); }
#base-view .dock-ship-actions { display: flex; flex: 0 0 auto; gap: 5px; }
/* Parts tab */
#base-view .dock-parts-header {
  display: flex; align-items: center; gap: var(--space-5); padding: 11px 13px;
  border-radius: var(--radius-panel); background: var(--surface-1);
}
#base-view .dock-parts-header.dock-focus-panel {
  background: var(--glass-focus); backdrop-filter: blur(20px) saturate(82%);
  -webkit-backdrop-filter: blur(20px) saturate(82%);
  box-shadow: 0 16px 48px var(--shadow, var(--shade-1));
}
#base-view .dock-ship-label { flex: 1; color: var(--body); font-size: var(--font-m); }
#base-view .dock-ship-label strong { color: var(--color-primary); font-weight: 600; }
#base-view .dock-part-list { display: flex; flex-direction: column; gap: 7px; }
#base-view .dock-part-row {
  display: flex; flex-direction: column; gap: var(--space-3); padding: 9px 11px;
  border-radius: var(--radius-panel); background: var(--surface-2);
}
#base-view .dock-part-info { display: flex; flex-direction: column; gap: var(--space-1); }
#base-view .dock-part-name { color: var(--title); font-size: var(--font-m); font-weight: 500; }
#base-view .dock-part-type { color: var(--muted); font-size: var(--font-xs); }
#base-view .dock-part-hp-meter .w-meter-track { height: 7px; border-radius: var(--radius-control); overflow: hidden; }
#base-view .dock-part-hp-meter .w-meter-fill { border-radius: var(--radius-control); transition: width var(--transition-slow); }
#base-view .dock-part-hp-text { color: var(--muted); font-size: var(--font-s); text-align: right; font-variant-numeric: tabular-nums; }
#base-view .dock-part-row-main {
  display: grid; grid-template-columns: minmax(120px, 1fr) minmax(96px, 140px);
  align-items: center; gap: var(--space-5);
}
#base-view .dock-warehouse-row-main { grid-template-columns: minmax(120px, 1fr) auto; }
#base-view .dock-part-actions {
  grid-column: 1 / -1; display: flex; align-items: center; justify-content: flex-end; gap: 5px; flex-wrap: wrap;
}
#base-view .dock-part-swap-row {
  display: flex; align-items: center; gap: var(--space-4); padding: var(--space-3);
  border-radius: var(--radius-control); background: var(--surface-1);
  color: var(--muted); font-size: var(--font-s);
}
#base-view .dock-part-swap-select {
  flex: 1; min-width: 0; padding: 7px 9px;
  border: 0; border-radius: var(--radius-control);
  background: var(--surface-3); color: var(--title); font: inherit; font-size: var(--font-s);
}
#base-view .dock-parts-columns { display: grid; grid-template-columns: 1fr 1fr; gap: 9px; }
#base-view .dock-parts-col {
  display: flex; flex-direction: column; gap: var(--space-4); min-width: 0;
  padding: 13px; border-radius: var(--radius-window); background: var(--surface-1);
}
#base-view .dock-col-title { margin: 0; color: var(--title); font-size: var(--font-m); font-weight: 600; }
/* Shop tab */
#base-view .dock-shop-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 7px; }
#base-view .dock-shop-item {
  display: flex; align-items: center; gap: var(--space-5); min-width: 0; padding: 11px 13px;
  border-radius: var(--radius-panel); background: var(--surface-1);
}
#base-view .dock-shop-info { flex: 1; display: flex; flex-direction: column; gap: var(--space-1); }
#base-view .dock-shop-name { color: var(--title); font-size: var(--font-l); font-weight: 500; }
#base-view .dock-shop-type { color: var(--muted); font-size: var(--font-xs); }
#base-view .dock-shop-props { color: var(--body); font-size: var(--font-s); line-height: 1.45; }
#base-view .dock-shop-stats { color: var(--muted); font-size: var(--font-xs); font-variant-numeric: tabular-nums; }
#base-view .dock-shop-actions { display: flex; flex-direction: column; align-items: flex-end; gap: var(--space-2); }
#base-view .dock-shop-price { color: var(--title); font-size: var(--font-m); font-variant-numeric: tabular-nums; }
/* ドック内の操作は Borderless。主要操作、サービス完了系、補助操作の三段に分ける。 */
#base-view span.dock-btn {
  padding: 7px 10px; border: 0; border-radius: var(--radius-control);
  background: var(--surface-2); color: var(--body); white-space: nowrap;
}
#base-view span.dock-btn:hover { background: var(--surface-3); color: var(--color-primary-hover); }
#base-view span.dock-btn-primary { background: var(--color-primary-fill); color: var(--color-primary); }
#base-view span.dock-btn-primary:hover { background: var(--color-primary-fill-strong); color: var(--color-primary-hover); }
#base-view span.dock-btn-service { color: var(--body); }
#base-view span.dock-btn-service:hover { background: var(--surface-3); color: var(--color-primary-hover); }
#base-view span.dock-btn-complete.disabled { opacity: 0.72; color: var(--color-signal); }
#base-view span.dock-btn-quiet { color: var(--muted); }

@media ${MQ_COMPACT} {
  #base-view.base-view-overlay {
    align-items: flex-end; padding: max(var(--space-4), var(--safe-t)) 0 0;
  }
  #base-view .dock-panel {
    height: 94dvh; max-height: 100%; overflow: hidden; border-radius: var(--radius-window) var(--radius-window) 0 0;
    background: var(--surface-0);
  }
  #base-view .dock-header {
    grid-template-columns: minmax(0, 1fr) auto; gap: var(--space-4);
    padding: 13px 13px 9px;
  }
  #base-view .dock-title { font-size: var(--font-xl); }
  #base-view .dock-subtitle { display: none; }
  #base-view .dock-tabs {
    grid-column: 1 / -1; grid-row: 2; justify-content: flex-start;
    overflow-x: auto; scrollbar-width: none;
  }
  #base-view .dock-tabs::-webkit-scrollbar { display: none; }
  #base-view .dock-tabs .w-btn { flex: 1 0 auto; text-align: center; }
  #base-view .dock-status-bar { padding: 0 13px 11px; }
  #base-view .dock-body { margin-top: 0; padding: 13px; }
  #base-view .dock-section-head { align-items: flex-start; padding-inline: 0; }
  #base-view .dock-ship-row { align-items: stretch; flex-direction: column; gap: var(--space-3); }
  #base-view .dock-ship-actions { display: grid; grid-template-columns: 1fr 1fr; }
  #base-view .dock-ship-actions .dock-btn { justify-content: center; text-align: center; }
  #base-view .dock-parts-header { align-items: flex-start; flex-direction: column; }
  #base-view .dock-parts-header .dock-btn { align-self: stretch; text-align: center; }
  #base-view .dock-parts-columns, #base-view .dock-shop-list { grid-template-columns: 1fr; }
  #base-view .dock-parts-col { padding: 11px; }
  #base-view .dock-part-row-main { grid-template-columns: minmax(0, 1fr) auto; gap: var(--space-4); }
  #base-view .dock-part-row-main:not(.dock-warehouse-row-main) .dock-part-hp-meter { grid-column: 1 / -1; grid-row: 2; }
  #base-view .dock-warehouse-row-main .dock-part-actions { grid-column: 1 / -1; justify-content: flex-end; }
  #base-view .dock-part-swap-row { align-items: stretch; flex-wrap: wrap; }
  #base-view .dock-part-swap-select { flex-basis: calc(100% - 80px); }
  #base-view .dock-shop-item { align-items: stretch; flex-direction: column; }
  #base-view .dock-shop-actions { align-items: center; flex-direction: row; justify-content: space-between; }
}

@media ${MQ_SHORT} {
  #base-view.base-view-overlay { padding-top: var(--space-3); }
  #base-view .dock-header { padding-top: 9px; padding-bottom: 7px; }
  #base-view .dock-subtitle { display: none; }
  #base-view .dock-status-bar { padding-bottom: 9px; }
  #base-view .dock-body { padding-top: 9px; padding-bottom: 9px; }
}
`;

let styleInjected = false;
// 基地パネルのスタイルシートを document.head へ一度だけ挿入する。
function ensureStyle(): void {
  if (styleInjected) return;
  styleInjected = true;
  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.appendChild(style);
}

export type DockTab = 'ships' | 'parts' | 'shop';

const TAB_ITEMS: readonly (readonly [DockTab, string])[] = [
  ['ships', '格納艦艇'],
  ['parts', '部品'],
  ['shop', 'ショップ'],
];

export class BasePanel {
  private readonly el: HTMLElement;
  private readonly tabBar: TabBar<DockTab>;
  private readonly moneyLabel: HTMLElement;
  private readonly bodyEl: HTMLElement;
  private _visible = false;
  private currentBase: Base | null = null;
  private currentVessel: Player | null = null;
  private currentTab: DockTab = 'ships';
  private freeProcurement = false;

  private readonly vesselsTab: VesselsTabController;
  private readonly partsTab: PartsTabController;
  private readonly shopTab: ShopTabController;

  // 外部コールバック
  public onLaunchVessel: ((ship: Player, base: Base) => void) | null = null;
  // 「新造」ボタン。実際の艦の生成は Docking 側が行う(BasePanel は UI のみ)。
  public onBuildVessel: ((base: Base) => void) | null = null;
  public onClose: (() => void) | null = null;

  public get visible(): boolean { return this._visible; }
  public get element(): HTMLElement { return this.el; }

  public constructor() {
    ensureStyle();

    const ctx: BasePanelContext = {
      base: () => this.currentBase!,
      freeProcurement: () => this.freeProcurement,
      vessel: () => this.currentVessel,
      selectVessel: (v) => { this.currentVessel = v; },
      switchToPartsTab: () => { this.currentTab = 'parts'; this.refresh(); },
      refresh: () => this.refresh(),
      notifyLaunch: (ship, base) => this.onLaunchVessel?.(ship, base),
      notifyBuildVessel: (base) => this.onBuildVessel?.(base),
    };
    this.vesselsTab = new VesselsTabController(ctx);
    this.partsTab = new PartsTabController(ctx);
    this.shopTab = new ShopTabController(ctx);

    this.el = document.createElement('div');
    this.el.id = 'base-view';
    this.el.className = 'base-panel';
    this.el.style.display = 'none';
    this.el.setAttribute('role', 'region');
    this.el.setAttribute('aria-labelledby', 'base-view-title');

    const panel = document.createElement('div');
    panel.className = 'dock-panel';

    const header = document.createElement('header');
    header.className = 'dock-header';

    const titleGroup = document.createElement('div');
    titleGroup.className = 'dock-title-group';
    const kicker = document.createElement('span');
    kicker.className = 'dock-kicker';
    kicker.textContent = 'Base operations';
    const title = document.createElement('h1');
    title.id = 'base-view-title';
    title.className = 'dock-title';
    title.textContent = 'Base';
    const subtitle = document.createElement('span');
    subtitle.className = 'dock-subtitle';
    subtitle.textContent = '艦の整備、補給、調達';
    titleGroup.append(kicker, title, subtitle);
    header.appendChild(titleGroup);

    this.tabBar = new TabBar<DockTab>(TAB_ITEMS, (tab) => {
      this.currentTab = tab;
      this.refresh();
    });
    this.tabBar.element.classList.add('dock-tabs');
    this.tabBar.element.setAttribute('aria-label', 'ドックの区画');
    this.tabBar.element.querySelectorAll<HTMLElement>('[role="tab"]').forEach((tab, index) => {
      const item = TAB_ITEMS[index];
      if (!item) return;
      tab.id = `dock-tab-${item[0]}`;
      tab.setAttribute('aria-controls', 'dock-panel-content');
    });
    header.appendChild(this.tabBar.element);

    // 閉じる操作は、プロパティウィンドウ側へパネル収納を要求する。
    const closeBtn = new CloseButton(() => this.onClose?.());
    header.appendChild(closeBtn.element);
    panel.appendChild(header);

    const statusBar = document.createElement('div');
    statusBar.className = 'dock-status-bar';
    statusBar.setAttribute('role', 'status');
    statusBar.setAttribute('aria-live', 'polite');
    this.moneyLabel = document.createElement('span');
    this.moneyLabel.textContent = '利用可能クレジット ---';
    statusBar.appendChild(this.moneyLabel);
    panel.appendChild(statusBar);

    this.bodyEl = document.createElement('main');
    this.bodyEl.id = 'dock-panel-content';
    this.bodyEl.className = 'dock-body';
    this.bodyEl.setAttribute('role', 'tabpanel');
    this.bodyEl.tabIndex = 0;
    panel.appendChild(this.bodyEl);

    this.el.appendChild(panel);
  }

  // 基地パネルを開く。
  public open(base: Base, inspectShip: Player | null, freeProcurement: boolean): void {
    this.currentBase = base;
    this.freeProcurement = freeProcurement;
    // inspectShip が基地に格納されていれば選択状態にする
    if (inspectShip && base.baseState.dockedVessels.some((s) => s.id === inspectShip.id)) {
      this.currentVessel = inspectShip;
    } else {
      this.currentVessel = null;
    }
    this.currentTab = 'ships';
    this.refresh();
    this.el.style.display = 'flex';
    this._visible = true;
    this.focusEntry();
  }

  public close(): void {
    this.el.style.display = 'none';
    this._visible = false;
    this.currentBase = null;
    this.currentVessel = null;
  }

  private focusEntry(): void {
    const selectedTab = this.tabBar.element.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    (selectedTab ?? this.bodyEl).focus({ preventScroll: true });
  }

  private refresh(): void {
    if (!this.currentBase) return;

    this.moneyLabel.textContent = this.freeProcurement
      ? `${this.currentBase.name} · 調達コストなし`
      : `${this.currentBase.name} · ${this.currentBase.baseState.money.toLocaleString()} Cr 利用可能`;
    this.tabBar.setSelected(this.currentTab);
    this.bodyEl.setAttribute('aria-labelledby', `dock-tab-${this.currentTab}`);

    this.bodyEl.innerHTML = '';
    switch (this.currentTab) {
      case 'ships': this.bodyEl.appendChild(this.vesselsTab.build()); break;
      case 'parts': this.bodyEl.appendChild(this.partsTab.build()); break;
      case 'shop': this.bodyEl.appendChild(this.shopTab.build()); break;
    }
    // 操作した行を再構築してフォーカス要素がDOMから外れた場合も、背面HUDへ落とさない。
    if (this._visible && !this.el.contains(document.activeElement)) this.focusEntry();
  }

  public dispose(): void {
    this.el.remove();
  }
}
