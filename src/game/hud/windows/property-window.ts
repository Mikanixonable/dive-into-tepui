// マップ上のオブジェクトを右クリックして開く、プロパティ表示付きの小窓。行一覧・操作項目・
// 関連物体一覧・改名 UI という4つの副概念を束ね、本文でのそれぞれの並び順と、本文の高さが
// 変わったときのはみ出し補正(reclamp)をいつ行うかを決める。表示専用で、プロパティの値を
// どう導出するかは呼び出し側の責務。複数存続できる想定のため ContextMenu と異なり呼び出し
// ごとに個別のインスタンスを持つ。#hud の子として window レイヤへ置くため、
// `#hud, #hud *` の margin/padding リセットに勝てるよう全セレクタを `#hud` で始める。
import { injectOnce } from '../widgets/inject-style';
import type { OverlayManager } from '../overlay-manager';
import { DraggableWindow } from './draggable-window';
import { PropertyWindowRows } from './property-window-rows';
import { PropertyWindowItems } from './property-window-items';
import { PropertyWindowRelatedItems } from './property-window-related-items';
import { PropertyWindowRename } from './property-window-rename';

const STYLE = `
#hud .prop-window-title-input {
  width: 100%; background: var(--surface-2); border: 1px solid transparent; border-radius: var(--radius-control);
  color: var(--text); font: inherit; font-weight: bold; padding: var(--space-1) var(--space-2); box-sizing: border-box;
}
#hud .dg-window.property-window { width: 560px; max-width: 560px; }
#hud .dg-window.property-window.has-expanded-panel {
  width: min(1120px, calc(100vw - 32px)); max-width: min(1120px, calc(100vw - 32px));
  max-height: calc(100dvh - 32px); overflow-y: auto;
}
#hud .prop-window-rows { padding: var(--space-2) 0; }
#hud .prop-window-row {
  display: flex; justify-content: space-between; gap: var(--space-4); padding: var(--space-2) var(--space-5); color: var(--text);
}
#hud .prop-window-row-label { opacity: 0.7; }
#hud .prop-window-row-value { text-align: right; }
#hud .prop-window-row-toggle {
  padding: var(--space-2) var(--space-5); color: var(--text); opacity: 0.6; cursor: pointer;
}
#hud .prop-window-row-toggle:hover { opacity: 1; color: var(--color-primary-hover); }
#hud .prop-window-row-group-toggle {
  padding: var(--space-2) var(--space-5); color: var(--text); opacity: 0.6; cursor: pointer;
}
#hud .prop-window-row-group-toggle:hover { opacity: 1; color: var(--color-primary-hover); }
#hud .prop-window-controls {
  padding: var(--space-4) var(--space-5);
  background: color-mix(in srgb, var(--surface-0) 28%, transparent);
}
/* .w-btn の padding は #hud 修飾を持たないため、#hud 側のリセットに詳細度で負ける。
   詰まったボタンにならないよう、#hud 修飾つきで既定の余白へ戻す。 */
#hud .prop-window-controls .w-btn { padding: var(--space-4) var(--space-5); }
#hud .prop-window-items {
  padding: var(--space-2);
  background: color-mix(in srgb, var(--surface-0) 28%, transparent);
}
#hud .prop-window-related {
  padding: var(--space-2);
  background: color-mix(in srgb, var(--surface-0) 28%, transparent);
}
#hud .prop-window-related-title {
  padding: var(--space-2) var(--space-5);
  color: var(--text); opacity: 0.6; font-size: 0.9em;
  cursor: pointer;
}
#hud .prop-window-related-title:hover { opacity: 1; color: var(--color-primary-hover); }
#hud .prop-window-related-list {
  display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-1);
}
#hud .prop-window-related-item {
  padding: var(--space-4) var(--space-5); color: var(--body); cursor: pointer;
  border: 0; border-radius: var(--radius-micro);
}
#hud .prop-window-related-item:hover, #hud .prop-window-related-item:active {
  background: var(--surface-2); color: var(--color-primary-hover);
}
#hud .prop-window-related-item:focus-visible { outline: 2px solid var(--color-focus); outline-offset: -2px; }
#hud .prop-window-item {
  padding: var(--space-4) var(--space-5); color: var(--body); cursor: pointer;
  border: 0; border-radius: var(--radius-micro);
}
#hud .prop-window-item:hover, #hud .prop-window-item:active {
  background: var(--surface-2); color: var(--color-primary-hover);
}
#hud .prop-window-item.on {
  color: var(--color-primary); background: var(--color-primary-fill);
}
#hud .prop-window-item.on::before { content: '▪ '; }
#hud .prop-window-item:focus-visible { outline: 2px solid var(--color-focus); outline-offset: -2px; }
#hud .prop-window-expanded-panel {
  display: none; padding: var(--space-2); border-top: 1px solid var(--surface-2);
  background: color-mix(in srgb, var(--surface-0) 28%, transparent);
}
#hud .prop-window-expanded-panel.open { display: block; }
@media (max-width: 720px) {
  #hud .dg-window.property-window.has-expanded-panel {
    width: 100%; max-width: 100%; max-height: 85dvh;
  }
}
`;

export interface PropertyRow {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  // 立てると「詳細」トグルの下に畳まれ、既定では隠れる。
  readonly collapsible?: boolean;
  // 指定すると同名の行同士がグループ見出しの下にまとめられ、既定では畳まれる。
  // 描画順は rows 中でその名前が最初に現れた順。
  readonly group?: string;
}

export interface PropertyWindowItem<A extends string = string> {
  readonly label: string;
  readonly act: A;
  readonly shortcut?: string;
  readonly selected?: boolean;
  readonly keepOpen?: boolean;
}

export interface PropertyWindowRelatedItem {
  readonly id: string;
  readonly label: string;
  readonly onFocus: () => void;
  readonly onContextMenu: (clientX: number, clientY: number) => void;
}

export interface PropertyWindowContent<A extends string = string> {
  readonly title: string;
  readonly subtitle?: string;
  // タイトル前に添える対象種別のグリフ。省略すると添えない。
  readonly icon?: string;
  readonly rows: readonly PropertyRow[];
  readonly items: readonly PropertyWindowItem<A>[];
  // 対象に関連する物体を本文上部へ表示する。ダブルクリック/右クリックの動作は呼び出し側が持つ。
  readonly relatedItems?: readonly PropertyWindowRelatedItem[];
  readonly relatedTitle?: string;
  // 指定すると、タイトル横に改名ボタンが現れる。確定した新しい名前を受け取る。
  readonly onRename?: (name: string) => void;
}

export class PropertyWindow<A extends string = string> {
  private readonly win: DraggableWindow;
  private readonly rows: PropertyWindowRows;
  private readonly items: PropertyWindowItems<A>;
  private readonly relatedItems: PropertyWindowRelatedItems;
  private readonly rename: PropertyWindowRename;
  private readonly controlsEl: HTMLDivElement;
  private readonly expandedPanelEl: HTMLDivElement;

  // 閉じられた(dispose 済み)ことを知らせる。ESC・外側クリック・✕ ボタンのどの経路で
  // 閉じても等しく発火する。
  public onClose: (() => void) | null = null;
  // クリップボタンで状態が反転したことを通知する。
  public onClipChange: ((clipped: boolean) => void) | null = null;

  // clientX/clientY を左上角として root の子として開き、content の内容で組み立てる。
  // tempWindowGroup を渡すと、クリップされていない間だけ OverlayManager 上の排他グループに
  // 参加する一時ウィンドウになる(ESC・外側クリックで自動的に閉じ、同グループの他方も追い出す)。
  // 省略すると ESC・外側クリックのどちらでも閉じない常設ウィンドウになる。
  public constructor(
    root: HTMLElement, clientX: number, clientY: number, content: PropertyWindowContent<A>,
    overlayManager: OverlayManager, tempWindowGroup?: string,
  ) {
    injectOnce('property-window', STYLE);
    this.win = new DraggableWindow(root, clientX, clientY, {
      title: content.title, subtitle: content.subtitle, icon: content.icon, tempWindowGroup,
    }, overlayManager);
    this.win.onClose = () => this.onClose?.();
    this.win.onClipChange = (clipped) => this.onClipChange?.(clipped);

    // 4つの副概念を組み立てる。項目のショートカット配送だけは DraggableWindow からの
    // 呼び出しなのでここで配線する。
    this.rows = new PropertyWindowRows(this.win);
    this.items = new PropertyWindowItems<A>();
    this.win.onShortcut = (code) => this.items.dispatchShortcut(code);
    this.relatedItems = new PropertyWindowRelatedItems(this.win);
    this.rename = new PropertyWindowRename(this.win, content.title, content.onRename ?? null);

    // 関連物体一覧は非空になった時点で自分の sync 経由で本文へ差し込まれるため、
    // ここでは行・操作項目・展開パネルだけを固定の順で本文へ組み込む。
    this.controlsEl = document.createElement('div');
    this.controlsEl.className = 'prop-window-controls';
    this.expandedPanelEl = document.createElement('div');
    this.expandedPanelEl.className = 'prop-window-expanded-panel';
    this.win.element.classList.add('property-window');
    this.win.body.appendChild(this.rows.element);
    this.win.body.appendChild(this.items.element);
    this.win.body.appendChild(this.expandedPanelEl);

    this.syncRelatedItems(content.relatedItems ?? [], content.relatedTitle);
    this.syncRows(content.rows);
    this.syncItems(content.items);
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

  public syncBadge(isTarget: boolean): void {
    this.win.setBadge(isTarget);
  }

  // プロパティ行の値だけを毎フレーム差分更新する。行構成が変わった場合のみ DOM を組み直す。
  public syncRows(rows: readonly PropertyRow[]): void {
    this.rows.sync(rows);
    this.reclamp();
  }

  // 操作項目の集合・ラベル・ショートカットが変わったときだけ DOM を組み直す。
  public syncItems(items: readonly PropertyWindowItem<A>[]): void {
    this.items.sync(items);
    this.reclamp();
  }

  // 対象に関連する物体の集合が変わったときだけ DOM を組み直す。欄は常にプロパティ行より上に置く。
  public syncRelatedItems(items: readonly PropertyWindowRelatedItem[], relatedTitle = '周回物体'): void {
    this.relatedItems.sync(items, relatedTitle);
    if (this.relatedItems.element.childElementCount > 0 && !this.relatedItems.element.parentElement) {
      this.win.body.insertBefore(this.relatedItems.element, this.rows.element);
    }
    this.reclamp();
  }

  public get clipped(): boolean {
    return this.win.clipped;
  }

  // 呼び出し側が組んだ操作ウィジェットを本文の先頭へ載せる。プロパティ行が伸びても押しに行ける
  // 位置に置くため、行より上に入る。ウィジェット本体の所有権は呼び出し側に残し、null で外す。
  public setControls(controls: HTMLElement | null): void {
    this.controlsEl.replaceChildren();
    if (controls === null) {
      this.controlsEl.remove();
    } else {
      this.controlsEl.appendChild(controls);
      if (!this.controlsEl.parentElement) this.win.body.insertBefore(this.controlsEl, this.win.body.firstChild);
    }
    this.reclamp();
  }

  // プロパティウィンドウの操作項目から展開する補助パネルを本文末尾へ接続する。
  // パネル本体の所有権は呼び出し側に残し、null で元の非展開サイズへ戻す。
  public setExpandedPanel(panel: HTMLElement | null): void {
    this.expandedPanelEl.replaceChildren();
    if (panel) this.expandedPanelEl.appendChild(panel);
    const open = panel !== null;
    this.expandedPanelEl.classList.toggle('open', open);
    this.win.element.classList.toggle('has-expanded-panel', open);
    this.reclamp();
  }

  // window レイヤ内で最前面にする。
  public bringToFront(): void {
    this.win.bringToFront();
  }

  // 本文の変化でウィンドウの高さが伸びたときに、画面外へのはみ出しだけ戻す。
  private reclamp(): void {
    this.moveTo(this.win.element.offsetLeft, this.win.element.offsetTop);
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

  // ✕ ボタンと同じ「破棄して呼び出し側へ通知する」経路。ESC・外側クリックどちらで閉じても
  // ここを通るので、onClose の発火経路は一本化される。
  public close(): void {
    this.win.close();
  }
}
