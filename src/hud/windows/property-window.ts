// マップ上のオブジェクトを右クリックして開く、プロパティ表示付きの小窓。行一覧・操作項目・
// 関連物体一覧・改名 UI という4つの副概念を束ね、本文でのそれぞれの並び順と、本文の高さが
// 変わったときのはみ出し補正(reclamp)をいつ行うかを決める。表示専用で、プロパティの値を
// どう導出するかは呼び出し側の責務。複数存続できる想定のため ContextMenu と異なり呼び出し
// ごとに個別のインスタンスを持つ。#hud の子として window レイヤへ置くため、
// `#hud, #hud *` の margin/padding リセットに勝てるよう全セレクタを `#hud` で始める。
import { injectOnce } from '../inject-style';
import type { OverlayManager } from '../overlay-manager';
import { DraggableWindow } from './draggable-window';
import { PropertyWindowRows } from './property-window-rows';
import { PropertyWindowItems } from './property-window-items';
import { PropertyWindowRelatedItems } from './property-window-related-items';
import { PropertyWindowRename } from './property-window-rename';
import type {
  PropertyRow, PropertyWindowContent, PropertyWindowItem, PropertyWindowRelatedItem,
} from './property-window-content';

const STYLE = `
#hud .prop-window-title-input {
  width: 100%; background: var(--glass-control); border: 1px solid var(--glass-edge); border-radius: var(--radius-control);
  color: var(--text); font: inherit; font-weight: bold; padding: var(--space-1) var(--space-2); box-sizing: border-box;
}
#hud .dg-window.property-window { width: 560px; max-width: 560px; }
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
  background: var(--glass-inset);
}
/* .w-btn の padding は #hud 修飾を持たないため、#hud 側のリセットに詳細度で負ける。
   詰まったボタンにならないよう、#hud 修飾つきで既定の余白へ戻す。 */
#hud .prop-window-controls .w-btn { padding: var(--space-4) var(--space-5); }
#hud .prop-window-items {
  padding: var(--space-2);
  background: var(--glass-inset);
}
#hud .prop-window-related {
  padding: var(--space-2);
  background: var(--glass-inset);
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
  border: 1px solid transparent; border-radius: var(--radius-control);
}
#hud .prop-window-related-item:hover, #hud .prop-window-related-item:active {
  background: var(--glass-control-hover); color: var(--color-primary-hover);
}
#hud .prop-window-related-item:focus-visible { outline: 2px solid var(--color-focus); outline-offset: -2px; }
#hud .prop-window-item {
  padding: var(--space-4) var(--space-5); color: var(--body); cursor: pointer;
  border: 1px solid transparent; border-radius: var(--radius-control);
}
#hud .prop-window-item:hover, #hud .prop-window-item:active {
  background: var(--glass-control-hover); color: var(--color-primary-hover);
}
#hud .prop-window-item.on {
  border-color: var(--color-primary-edge-soft); color: var(--color-primary); background: var(--color-primary-fill);
}
#hud .prop-window-item.on::before { content: '▪ '; }
#hud .prop-window-item:focus-visible { outline: 2px solid var(--color-focus); outline-offset: -2px; }
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
    // ここでは行と操作項目だけを固定の順で本文へ組み込む。
    this.controlsEl = document.createElement('div');
    this.controlsEl.className = 'prop-window-controls';
    this.win.element.classList.add('property-window');
    this.win.body.appendChild(this.rows.element);
    this.win.body.appendChild(this.items.element);

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
