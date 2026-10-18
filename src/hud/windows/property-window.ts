// マップ上のオブジェクトを右クリックして開く、プロパティ表示付きの小窓。行一覧・操作項目・
// 関連物体一覧・改名 UI という4つの副概念を束ね、本文でのそれぞれの並び順と、本文の高さが
// 変わったときのはみ出し補正(reclamp)をいつ行うかを決める。表示専用で、プロパティの値を
// 対応するコンポーネントが導出する。複数存続できる想定のため ContextMenu と異なり呼び出し
// ごとに個別のインスタンスを持つ。#hud の子として window レイヤへ置くため、
// HUD 内の他ウィンドウとスコープを分けるため、主要セレクタを `#hud` から始める。
import { injectOnce } from '../inject-style';
import { MQ_COARSE, MQ_COMPACT } from '../breakpoints';
import type { OverlayManager } from '../overlay-manager';
import { DraggableWindow, type WindowRole } from './draggable-window';
import { PropertyWindowRows } from './property-window-rows';
import { PropertyWindowItems } from './property-window-items';
import { PropertyWindowRelatedItems } from './property-window-related-items';
import { PropertyWindowRename } from './property-window-rename';
import type {
  PropertyRow, PropertyWindowContent, PropertyWindowItem, PropertyWindowRelatedItem, PropertyWindowToggle,
} from './property-window-content';

const STYLE = `
#hud .prop-window-title-input {
  flex: 1 1 auto; min-width: 0; background: var(--glass-control); border: 0; border-radius: var(--radius-control);
  color: var(--text); font: inherit; font-weight: bold; padding: var(--space-1) var(--space-2); box-sizing: border-box;
}
#hud .dg-window.property-window {
  width: min(560px, calc(100vw - 24px)); max-width: calc(100vw - 24px);
}
#hud .prop-window-body {
  display: grid; gap: var(--space-4); padding: var(--space-2) var(--space-6) var(--space-6);
}
#hud .prop-window-rows { display: grid; gap: var(--space-4); }
#hud .prop-window-rows:empty { display: none; }
/* 主読み値と、その脇の主要行。 */
#hud .prop-window-summary {
  display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: center; column-gap: var(--space-6);
}
#hud .prop-window-summary > :only-child { grid-column: 1 / -1; }
#hud .prop-window-heroes { display: grid; gap: var(--space-3); }
#hud .prop-window-majors { min-width: 0; }
#hud .prop-window-metrics, #hud .prop-window-section {
  grid-template-columns: repeat(2, minmax(0, 1fr)); column-gap: var(--space-6);
}
/* ターゲット中の対象は、主読み値とメーターも第二色を帯びる。 */
#hud .dg-window.is-tgt .ui-readout-value { color: var(--role-target); }
#hud .dg-window.is-tgt .w-meter-fill { background: var(--role-target); }
#hud .prop-window-controls .w-btn { padding: var(--space-4) var(--space-5); }
#hud .prop-window-controls:empty { display: none; }
#hud .prop-window-items { display: grid; gap: var(--space-4); }
#hud .prop-window-items:not(:has(.prop-window-toggle, .prop-window-item)) { display: none; }
#hud .prop-window-toggles { display: grid; }
#hud .prop-window-toggle { justify-content: space-between; min-height: var(--row-min-h-s); }
#hud .prop-window-toggle .w-toggle-title { color: var(--role-label); font-size: var(--font-xs); }
#hud .prop-window-related { display: grid; }
#hud .prop-window-related-list { grid-template-columns: repeat(2, minmax(0, 1fr)); column-gap: var(--space-6); }
#hud .prop-window-related-item { cursor: pointer; }
#hud .prop-window-related-item:focus-visible { outline: 2px solid var(--color-focus); outline-offset: -2px; }
@media ${MQ_COARSE} {
  #hud .prop-window-related-item { min-height: var(--hit-target-min); }
}
#hud .property-window.property-window-monitor {
  width: 340px; max-width: 340px;
}
#hud .property-window.property-window-monitor .prop-window-metrics {
  grid-template-columns: minmax(0, 1fr);
}
#hud .property-window.property-window-monitor .prop-window-row-group-toggle,
#hud .property-window.property-window-monitor .prop-window-section,
#hud .property-window.property-window-monitor .prop-window-related,
#hud .property-window.property-window-monitor .prop-window-items,
#hud .property-window.property-window-monitor .prop-window-controls {
  display: none !important;
}
@media ${MQ_COMPACT} {
  #hud .dg-window.property-window { width: 100%; max-width: 100%; }
  #hud .prop-window-metrics, #hud .prop-window-section, #hud .prop-window-related-list {
    grid-template-columns: minmax(0, 1fr);
  }
}
`;

export class PropertyWindow<A extends string = string> {
  private readonly win: DraggableWindow;
  private readonly rows: PropertyWindowRows;
  private readonly items: PropertyWindowItems<A>;
  private readonly relatedItems: PropertyWindowRelatedItems;
  private readonly rename: PropertyWindowRename;
  private readonly controlsEl: HTMLDivElement;

  // 閉じられた(dispose 済み)ことを知らせる。ESC・外側クリック・✕ ボタンのどの経路で
  // 閉じても等しく発火する。
  public onClose: (() => void) | null = null;
  // クリップボタンで状態が反転したことを通知する。
  public onClipChange: ((clipped: boolean) => void) | null = null;

  // clientX/clientY を左上角として開き、content の内容で組み立てる。
  // unclippedWindowGroup を渡すと、クリップされていない間だけ OverlayManager 上の排他グループに
  // 参加する一時ウィンドウになる(ESC・外側クリックで自動的に閉じ、同グループの他方も追い出す)。
  // 省略すると ESC・外側クリックのどちらでも閉じない常設ウィンドウになる。
  public constructor(
    clientX: number, clientY: number, content: PropertyWindowContent<A>,
    overlayManager: OverlayManager, unclippedWindowGroup?: string,
  ) {
    injectOnce('property-window', STYLE);
    const tag = [content.kindCode, content.kindLabel].filter((part) => part !== undefined).join(' · ');
    this.win = new DraggableWindow(clientX, clientY, {
      title: content.title, subtitle: content.subtitle, icon: content.icon,
      tag: tag === '' ? undefined : tag, unclippedWindowGroup,
    }, overlayManager);
    this.win.onClose = () => this.onClose?.();
    this.win.onClipChange = (clipped) => {
      if (content.monitorWhenClipped === true) {
        this.win.element.classList.toggle('property-window-monitor', clipped);
        this.win.reclamp();
      }
      this.onClipChange?.(clipped);
    };

    // 4つの副概念を組み立てる。項目のショートカット配送だけは DraggableWindow からの
    // 呼び出しなのでここで配線する。
    this.rows = new PropertyWindowRows(this.win);
    this.items = new PropertyWindowItems<A>();
    this.win.onShortcut = (code) => this.items.dispatchShortcut(code);
    this.relatedItems = new PropertyWindowRelatedItems(this.win);
    this.rename = new PropertyWindowRename(this.win, content.title, content.onRename ?? null);

    // 関連物体一覧は非空になった時点で自分の sync 経由で本文へ差し込まれるため、
    // ここでは行と操作項目だけを固定の順で本文へ組み込む。
    this.controlsEl = document.createElement('div');
    this.controlsEl.className = 'prop-window-controls';
    this.win.element.classList.add('property-window');
    this.win.body.classList.add('prop-window-body');
    if (content.monitorWhenClipped === true && this.win.clipped) {
      this.win.element.classList.add('property-window-monitor');
    }

    this.win.body.appendChild(this.rows.element);
    this.win.body.appendChild(this.items.element);

    this.syncRelatedItems(content.relatedItems ?? [], content.relatedTitle);
    this.syncRows(content.rows);
    this.syncItems(content.items);
    this.syncToggles(content.toggles ?? []);
  }

  public contains(target: Node): boolean {
    return this.win.contains(target);
  }

  // 項目クリックまたは一致したショートカットのたびに呼ばれる。
  public get onSelect(): ((act: A, keepOpen: boolean) => void) | null {
    return this.items.onSelect;
  }

  public set onSelect(value: ((act: A, keepOpen: boolean) => void) | null) {
    this.items.onSelect = value;
  }

  // タイトル・サブタイトルを DraggableWindow へ差分更新で渡す。
  public syncHeader(title: string, subtitle: string | undefined): void {
    this.rename.updateTitle(title);
    this.win.setHeader(title, subtitle);
  }

  // 対象と操作対象・ターゲットとの関係を題名の色とピップへ反映する。
  public syncRole(role: WindowRole): void {
    this.win.setRole(role);
  }

  // プロパティ行の値だけを毎フレーム差分更新する。行構成が変わった場合のみ DOM を組み直す。
  public syncRows(rows: readonly PropertyRow[]): void {
    this.rows.sync(rows);
    this.win.reclamp();
  }

  // 操作ボタンの集合・ラベル・ショートカットが変わったときだけ DOM を組み直す。
  public syncItems(items: readonly PropertyWindowItem<A>[]): void {
    this.items.sync(items);
    this.win.reclamp();
  }

  // 2値の設定の集合が変わったときだけ DOM を組み直し、ON/OFF の表示を合わせる。
  public syncToggles(toggles: readonly PropertyWindowToggle<A>[]): void {
    this.items.syncToggles(toggles);
    this.win.reclamp();
  }

  // 対象に関連する物体の集合が変わったときだけ DOM を組み直す。欄は常にプロパティ行より上に置く。
  public syncRelatedItems(items: readonly PropertyWindowRelatedItem[], relatedTitle = '周回物体'): void {
    this.relatedItems.sync(items, relatedTitle);
    if (this.relatedItems.element.childElementCount > 0 && !this.relatedItems.element.parentElement) {
      this.win.body.insertBefore(this.relatedItems.element, this.rows.element);
    }
    this.win.reclamp();
  }

  public get clipped(): boolean {
    return this.win.clipped;
  }

  // 操作ウィジェットを本文の先頭に起き、プロパティ行が伸びても先頭から操作できる位置に置く。
  // 所有権は導入元に残り、null で取り外す。
  public setControls(controls: HTMLElement | null): void {
    this.controlsEl.replaceChildren();
    if (controls === null) {
      this.controlsEl.remove();
    } else {
      this.controlsEl.appendChild(controls);
      if (!this.controlsEl.parentElement) this.win.body.insertBefore(this.controlsEl, this.win.body.firstChild);
    }
    this.win.reclamp();
  }

  // window レイヤ内で最前面にする。
  public bringToFront(): void {
    this.win.bringToFront();
  }

  // 要求座標をビューポート内へクランプして配置する。
  public moveTo(clientX: number, clientY: number): void {
    this.win.moveTo(clientX, clientY);
  }

  // DOM ノードと登録したグローバルリスナを取り除き、overlayManager からも外す。
  // 以後このインスタンスは使えない。
  public dispose(): void {
    this.win.dispose();
  }

  // ✕ ボタンと同一経路で破棄し、onClose を発火する。
  // ESC・外側クリックいずれで閉じてもここを経由するため、発火経路は一本化される。
  public close(): void {
    this.win.close();
  }
}
