// プロパティウィンドウの関連物体一覧。対象に関連する物体をタイトル付きの折りたたみ一覧として
// 組み立て、ダブルクリック/右クリックが起きたら渡されたコールバックをそのまま呼ぶ。一覧が
// 空のときは自分自身を DOM から外し、非空になれば内容を組み立て直す。
import { COLLAPSE_COLLAPSED_GLYPH, COLLAPSE_EXPANDED_GLYPH } from '../widgets';
import { bindActivation, stopDragPropagation } from '../widgets/widget-base';
import type { ReclampingWindow } from './draggable-window';
import type { PropertyWindowRelatedItem } from './property-window-content';

// 一覧の行の頭に置く記号。
const RELATED_ITEM_GLYPH = '▪';

export class PropertyWindowRelatedItems {
  public readonly element: HTMLDivElement;
  private listEl: HTMLDivElement | null = null;
  private titleEl: HTMLDivElement | null = null;
  private titleLabelEl: HTMLSpanElement | null = null;
  private titleGlyphEl: HTMLSpanElement | null = null;
  private titleCountEl: HTMLSpanElement | null = null;
  private expanded = false;
  private items: readonly PropertyWindowRelatedItem[] = [];
  private title = '';
  private lastItemsKey = '';

  // 一覧を差し込む要素を用意する。win は自分が開閉した際のはみ出し補正にだけ使う。
  public constructor(private readonly win: ReclampingWindow) {
    this.element = document.createElement('div');
    this.element.className = 'prop-window-related';
  }

  // 対象に関連する物体の集合が変わったときだけ DOM を組み直す。空集合になったら自身を
  // DOM から取り外し、再び非空になったタイミングで再挿入できる状態に再構築する。
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
      this.titleLabelEl = null;
      this.titleGlyphEl = null;
      this.titleCountEl = null;
      return;
    }

    // 折りたたみ見出し。クリック/Enter/Space のいずれでも開閉を切り替える。
    const titleEl = document.createElement('div');
    titleEl.className = 'prop-window-related-title ui-fold';
    titleEl.setAttribute('role', 'button');
    titleEl.tabIndex = 0;
    titleEl.setAttribute('aria-expanded', String(this.expanded));
    const titleGlyph = document.createElement('span');
    const titleLabel = document.createElement('span');
    const titleCount = document.createElement('span');
    titleCount.className = 'ui-fold-n';
    titleEl.append(titleGlyph, titleLabel, titleCount);
    stopDragPropagation(titleEl);
    bindActivation(titleEl, () => {
      this.setExpanded(!this.expanded);
    });
    this.element.appendChild(titleEl);

    // 一覧本体。ダブルクリック/右クリックは引数で渡されたコールバックへ委譲する。
    const list = document.createElement('div');
    list.className = 'prop-window-related-list';
    for (const it of items) {
      const row = document.createElement('div');
      row.className = 'prop-window-related-item ui-item ui-selectable';
      row.setAttribute('role', 'button');
      row.tabIndex = 0;
      const rowGlyph = document.createElement('span');
      rowGlyph.className = 'ui-item-glyph';
      rowGlyph.textContent = RELATED_ITEM_GLYPH;
      const rowLabel = document.createElement('span');
      rowLabel.className = 'ui-item-name';
      rowLabel.textContent = it.label;
      row.append(rowGlyph, rowLabel);
      row.title = 'ダブルクリック: フォーカス · 右クリック: プロパティ';
      stopDragPropagation(row);
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
    this.titleLabelEl = titleLabel;
    this.titleGlyphEl = titleGlyph;
    this.titleCountEl = titleCount;
    this.syncToggleLabel();
    this.setExpanded(this.expanded, false);
  }

  // 折りたたみ見出しの文字列を、開閉状態と件数へ合わせて書き換える。
  private syncToggleLabel(): void {
    if (!this.titleEl || !this.titleLabelEl || !this.titleGlyphEl || !this.titleCountEl) return;
    this.titleGlyphEl.textContent = this.expanded ? COLLAPSE_EXPANDED_GLYPH : COLLAPSE_COLLAPSED_GLYPH;
    this.titleLabelEl.textContent = this.title;
    this.titleCountEl.textContent = String(this.items.length);
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
    this.win.reclamp();
  }
}
