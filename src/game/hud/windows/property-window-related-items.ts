// プロパティウィンドウの関連物体一覧。対象に関連する物体をタイトル付きの折りたたみ一覧として
// 組み立て、ダブルクリック/右クリックが起きたら渡されたコールバックをそのまま呼ぶ。一覧が
// 空のときは自分自身を DOM から外し、非空になれば内容を組み立て直す。
import { COLLAPSE_COLLAPSED_GLYPH, COLLAPSE_EXPANDED_GLYPH } from '../widgets';
import type { DraggableWindow } from './draggable-window';
import type { PropertyWindowRelatedItem } from './property-window';

export class PropertyWindowRelatedItems {
  public readonly element: HTMLDivElement;
  private listEl: HTMLDivElement | null = null;
  private titleEl: HTMLDivElement | null = null;
  private expanded = false;
  private items: readonly PropertyWindowRelatedItem[] = [];
  private title = '';
  private lastItemsKey = '';

  // 一覧を差し込む要素を用意する。win は自分が開閉した際のはみ出し補正にだけ使う。
  public constructor(private readonly win: DraggableWindow) {
    this.element = document.createElement('div');
    this.element.className = 'prop-window-related';
  }

  // 対象に関連する物体の集合が変わったときだけ DOM を組み直す。空集合になったら自分自身を
  // DOM から外し、再び非空になったら呼び出し側が差し込み直せるよう組み立て直す。
  public sync(items: readonly PropertyWindowRelatedItem[], title: string): void {
    const key = `${title}|${items.map((it) => `${it.id} ${it.label}`).join('|')}`;
    if (key === this.lastItemsKey) return;
    this.lastItemsKey = key;
    this.element.innerHTML = '';
    this.items = items;
    this.title = title;
    if (items.length === 0) {
      this.element.remove();
      this.listEl = null;
      this.titleEl = null;
      return;
    }

    // 折りたたみ見出し。クリック/Enter/Space のいずれでも開閉を切り替える。
    const titleEl = document.createElement('div');
    titleEl.className = 'prop-window-related-title';
    titleEl.setAttribute('role', 'button');
    titleEl.tabIndex = 0;
    titleEl.setAttribute('aria-expanded', String(this.expanded));
    titleEl.addEventListener('click', (e) => {
      e.stopPropagation();
      this.setExpanded(!this.expanded);
    });
    titleEl.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      this.setExpanded(!this.expanded);
    });
    this.element.appendChild(titleEl);

    // 一覧本体。ダブルクリック/右クリックは呼び出し側が渡したコールバックへそのまま委ねる。
    const list = document.createElement('div');
    list.className = 'prop-window-related-list';
    for (const it of items) {
      const row = document.createElement('div');
      row.className = 'prop-window-related-item';
      row.setAttribute('role', 'button');
      row.tabIndex = 0;
      row.textContent = it.label;
      row.title = 'ダブルクリック: フォーカス · 右クリック: プロパティ';
      row.addEventListener('dblclick', (e) => {
        e.preventDefault();
        e.stopPropagation();
        it.onFocus();
      });
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        it.onContextMenu(e.clientX, e.clientY);
      });
      row.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        it.onFocus();
      });
      list.appendChild(row);
    }
    this.element.appendChild(list);
    this.listEl = list;
    this.titleEl = titleEl;
    this.syncToggleLabel();
    this.setExpanded(this.expanded, false);
  }

  // 折りたたみ見出しの文字列を、開閉状態と件数へ合わせて書き換える。
  private syncToggleLabel(): void {
    if (!this.titleEl) return;
    this.titleEl.textContent =
      `${this.expanded ? COLLAPSE_EXPANDED_GLYPH : COLLAPSE_COLLAPSED_GLYPH} ${this.title} (${this.items.length})`;
    this.titleEl.setAttribute('aria-expanded', String(this.expanded));
  }

  // 一覧の開閉状態を切り替え、一覧の表示と見出し文字列へ反映する。
  private setExpanded(expanded: boolean, reclamp = true): void {
    this.expanded = expanded;
    if (this.listEl) this.listEl.style.display = expanded ? 'grid' : 'none';
    this.syncToggleLabel();
    if (reclamp) this.reclamp();
  }

  // 本文の変化でウィンドウの高さが伸びたときに、画面外へのはみ出しだけ戻す。
  private reclamp(): void {
    this.win.moveTo(this.win.element.offsetLeft, this.win.element.offsetTop);
  }
}
