// マップ上のオブジェクトを右クリックして開く、プロパティ表示付きの小窓。外枠(ドラッグ移動・
// クリップ・ヘッダ・OverlayManager 登録)は DraggableWindow に委譲し、このクラスはプロパティ行 /
// 操作項目の2段と改名 UI だけを持つ。表示専用で、プロパティの値をどう導出するかは呼び出し側の責務。
// 複数存続できる想定のため ContextMenu と異なり呼び出しごとに個別のインスタンスを持つ。
// #hud の子として window レイヤへ置くため、`#hud, #hud *` の margin/padding
// リセットに勝てるよう全セレクタを `#hud` で始める。
import { shortcutKeyLabel } from './shortcut-hint';
import { COLLAPSE_COLLAPSED_GLYPH, COLLAPSE_EXPANDED_GLYPH } from '../hud-root';
import { Button, ValueInput } from '../widgets';
import type { OverlayManager } from '../overlay-manager';
import { DraggableWindow } from './draggable-window';

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

let styleInjected = false;
// 行グループ見出しの文字列を組む。
function groupToggleLabel(name: string, rowCount: number, expanded: boolean): string {
  return expanded
    ? `${COLLAPSE_EXPANDED_GLYPH} ${name}`
    : `${COLLAPSE_COLLAPSED_GLYPH} ${name} (${rowCount})`;
}

function ensureStyle(): void {
  if (styleInjected) return;
  styleInjected = true;
  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.appendChild(style);
}

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
  // 指定すると、タイトル横に改名ボタンが現れる。呼び出し側は確定した新しい名前を
  // 実体へ書き戻すところまでを行う — このクラスは編集 UI の開閉のみを持つ。
  readonly onRename?: (name: string) => void;
}

export class PropertyWindow<A extends string = string> {
  private readonly win: DraggableWindow;
  private readonly rowsEl: HTMLDivElement;
  private readonly itemsEl: HTMLDivElement;
  private readonly relatedEl: HTMLDivElement;
  private readonly expandedPanelEl: HTMLDivElement;
  private titleMainEl: HTMLElement;
  // 前フレームに描画した行の値。同じ値なら DOM に触れない差分更新のための記録。
  private lastRowValues = new Map<string, string>();
  // 前フレームの行構成(key・group・collapsible の並び)。DOM 組み直しの要否判定に使う。
  private lastRowShapeKey = '';
  private collapsibleContainerEl: HTMLDivElement | null = null;
  private toggleEl: HTMLDivElement | null = null;
  private collapsibleExpanded = false;
  private relatedListEl: HTMLDivElement | null = null;
  private relatedTitleEl: HTMLDivElement | null = null;
  private relatedExpanded = false;
  private relatedTitle = '';
  private relatedCount = 0;
  // グループ名ごとの開閉状態。syncRows の再構築をまたいで保つ。
  private readonly groupExpanded = new Map<string, boolean>();
  // 前回描画した操作項目の直列化(act/label/shortcut)。同じなら DOM を組み直さない。
  private lastItemsKey = '';
  private lastRelatedItemsKey = '';
  private readonly renameCallback: ((name: string) => void) | null;
  private renaming = false;
  private lastTitle: string;

  // keepOpen はクリックした項目自身の PropertyWindowItem.keepOpen — 呼び出し側はこれを見て
  // 自動クローズを抑制するかを判断する(クリップ状態は別に呼び出し側が持つ)。
  public onSelect: ((act: A, keepOpen: boolean) => void) | null = null;
  // 閉じられた(dispose 済み)ことを呼び出し側の管理台帳へ知らせる。ESC・外側クリック・
  // ✕ ボタンのどの経路で閉じても等しく発火する。
  public onClose: (() => void) | null = null;
  // クリップボタンで状態が反転したことを通知する。呼び出し側が状態に応じた見た目の
  // 追従(一覧の表示等)を行うためだけの通知で、排他は overlayManager 自身が持つ。
  public onClipChange: ((clipped: boolean) => void) | null = null;

  // clientX/clientY を左上角として root の子として開き、content の内容で組み立てる。
  // tempWindowGroup を渡すと、クリップされていない間だけ OverlayManager 上の排他グループに
  // 参加する一時ウィンドウになる(ESC・外側クリックで自動的に閉じ、同グループの他方も追い出す)。
  // 省略すると(例: 負荷確認ウィンドウ)ESC・外側クリックのどちらでも閉じない常設ウィンドウになる。
  public constructor(
    root: HTMLElement, clientX: number, clientY: number, content: PropertyWindowContent<A>,
    overlayManager: OverlayManager, tempWindowGroup?: string,
  ) {
    ensureStyle();
    this.lastTitle = content.title;
    this.win = new DraggableWindow(root, clientX, clientY, {
      title: content.title, subtitle: content.subtitle, icon: content.icon, tempWindowGroup,
    }, overlayManager);
    this.win.onClose = () => this.onClose?.();
    this.win.onClipChange = (clipped) => this.onClipChange?.(clipped);
    this.win.onShortcut = (code) => this.dispatchShortcut(code);
    this.titleMainEl = this.win.element.querySelector<HTMLElement>('.dg-window-title-main')!;

    this.renameCallback = content.onRename ?? null;
    if (this.renameCallback) {
      const renameBtn = new Button('✎', () => this.startRename());
      renameBtn.element.classList.add('dg-window-btn');
      renameBtn.element.title = '名前を変更';
      renameBtn.element.setAttribute('aria-label', '名前を変更');
      this.win.headerExtras.appendChild(renameBtn.element);
    }

    this.rowsEl = document.createElement('div');
    this.rowsEl.className = 'prop-window-rows';
    this.itemsEl = document.createElement('div');
    this.itemsEl.className = 'prop-window-items';
    this.relatedEl = document.createElement('div');
    this.relatedEl.className = 'prop-window-related';
    this.expandedPanelEl = document.createElement('div');
    this.expandedPanelEl.className = 'prop-window-expanded-panel';
    this.win.element.classList.add('property-window');
    this.win.body.appendChild(this.rowsEl);
    this.win.body.appendChild(this.itemsEl);
    this.win.body.appendChild(this.expandedPanelEl);

    this.syncRelatedItems(content.relatedItems ?? [], content.relatedTitle);
    this.syncRows(content.rows);
    this.syncItems(content.items);
  }

  public contains(target: Node): boolean {
    return this.win.contains(target);
  }

  // 項目ショートカットの一致判定。クリップ中に配送しないかどうかは DraggableWindow が持つ。
  private dispatchShortcut(code: string): boolean {
    const items = this.itemsEl.querySelectorAll<HTMLElement>('.prop-window-item');
    for (const item of Array.from(items)) {
      if (item.dataset['shortcut'] !== code) continue;
      this.onSelect?.(item.dataset['act'] as A, item.dataset['keepOpen'] === '1');
      return true;
    }
    return false;
  }

  // タイトル・サブタイトルを DraggableWindow へ差分更新で渡す。
  public syncHeader(title: string, subtitle: string | undefined): void {
    this.lastTitle = title;
    this.win.setHeader(title, subtitle);
  }

  public syncBadge(kind: 'tgt' | 'on' | null): void {
    this.win.setBadge(kind);
  }

  // タイトルを編集用の入力欄へ差し替え、確定(Enter/blur)で renameCallback へ通知して表示へ戻す。
  private startRename(): void {
    if (this.renaming || !this.renameCallback) return;
    this.renaming = true;
    const input = new ValueInput(
      { type: 'text' },
      (text) => this.finishRename(input, text),
      () => this.finishRename(input, null),
    );
    input.element.classList.add('prop-window-title-input');
    input.element.maxLength = 40;
    input.setValue(this.lastTitle);
    this.titleMainEl.replaceWith(input.element);
    this.titleMainEl = input.element;
    input.element.focus();
    input.element.select();
  }

  // リネーム入力欄を終える。value が確定文字列なら(かつ現在のタイトルと異なれば)
  // renameCallback へ通知し、表示をタイトル要素へ戻す。破棄(Escape/無効値)は value が null。
  private finishRename(input: ValueInput, value: string | null): void {
    if (!this.renaming) return;
    this.renaming = false;
    const displayEl = this.win.element.querySelector<HTMLElement>('.dg-window-title-main')!;
    input.element.replaceWith(displayEl);
    this.titleMainEl = displayEl;
    const trimmed = value?.trim();
    if (trimmed && trimmed !== this.lastTitle) this.renameCallback?.(trimmed);
  }

  // 操作項目の集合・ラベル・ショートカットが変わったときだけ DOM を組み直す。クリップ済み
  // ウィンドウでは可変な状態(操作対象か等)に応じて呼び出し側から毎フレーム渡されうる。
  public syncItems(items: readonly PropertyWindowItem<A>[]): void {
    const key = items.map((it) => `${it.act} ${it.label} ${it.shortcut ?? ''} ${it.selected ?? ''} ${it.keepOpen ?? ''}`).join('|');
    if (key === this.lastItemsKey) return;
    this.lastItemsKey = key;
    this.itemsEl.innerHTML = '';
    for (const it of items) {
      const row = document.createElement('div');
      row.className = 'prop-window-item';
      row.setAttribute('role', 'button');
      row.tabIndex = 0;
      row.classList.toggle('on', it.selected === true);
      row.textContent = it.label + (it.shortcut ? ` [${shortcutKeyLabel(it.shortcut)}]` : '');
      row.dataset['act'] = it.act;
      row.dataset['shortcut'] = it.shortcut ?? '';
      row.dataset['keepOpen'] = it.keepOpen === true ? '1' : '';
      row.addEventListener('click', (e) => {
        // 外側 pointerdown 検出のキャプチャリスナへ伝播しないようにする。
        e.stopPropagation();
        this.onSelect?.(it.act, it.keepOpen === true);
      });
      row.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        row.click();
      });
      this.itemsEl.appendChild(row);
    }
    this.reclamp();
  }

  // 対象に関連する物体の集合が変わったときだけ DOM を組み直す。欄は常にプロパティ行より上に置く。
  public syncRelatedItems(items: readonly PropertyWindowRelatedItem[], relatedTitle = '周回物体'): void {
    const key = `${relatedTitle}|${items.map((it) => `${it.id} ${it.label}`).join('|')}`;
    if (key === this.lastRelatedItemsKey) return;
    this.lastRelatedItemsKey = key;
    this.relatedEl.innerHTML = '';
    if (items.length === 0) {
      this.relatedEl.remove();
      this.relatedListEl = null;
      this.relatedTitleEl = null;
      this.relatedTitle = '';
      this.relatedCount = 0;
      return;
    }
    const title = document.createElement('div');
    title.className = 'prop-window-related-title';
    title.setAttribute('role', 'button');
    title.tabIndex = 0;
    title.setAttribute('aria-expanded', String(this.relatedExpanded));
    title.addEventListener('click', (e) => {
      e.stopPropagation();
      this.setRelatedExpanded(!this.relatedExpanded);
    });
    title.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      this.setRelatedExpanded(!this.relatedExpanded);
    });
    this.relatedEl.appendChild(title);
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
    this.relatedEl.appendChild(list);
    this.relatedListEl = list;
    this.relatedTitleEl = title;
    this.relatedTitle = relatedTitle;
    this.relatedCount = items.length;
    this.syncRelatedToggleLabel(relatedTitle, items.length);
    this.setRelatedExpanded(this.relatedExpanded, false);
    if (!this.relatedEl.parentElement) this.win.body.insertBefore(this.relatedEl, this.rowsEl);
    this.reclamp();
  }

  private syncRelatedToggleLabel(name: string, count: number): void {
    if (!this.relatedTitleEl) return;
    this.relatedTitleEl.textContent = `${this.relatedExpanded ? COLLAPSE_EXPANDED_GLYPH : COLLAPSE_COLLAPSED_GLYPH} ${name} (${count})`;
    this.relatedTitleEl.setAttribute('aria-expanded', String(this.relatedExpanded));
  }

  private setRelatedExpanded(expanded: boolean, reclamp = true): void {
    this.relatedExpanded = expanded;
    if (this.relatedListEl) this.relatedListEl.style.display = expanded ? 'grid' : 'none';
    this.syncRelatedToggleLabel(this.relatedTitle, this.relatedCount);
    if (reclamp) this.reclamp();
  }

  // key/label/value の行 div を組み立てて container へ足し、値を lastRowValues へ記録する。
  private appendRowEl(container: HTMLElement, r: PropertyRow): void {
    const rowEl = document.createElement('div');
    rowEl.className = 'prop-window-row';
    rowEl.dataset['key'] = r.key;
    const labelEl = document.createElement('div');
    labelEl.className = 'prop-window-row-label';
    labelEl.textContent = r.label;
    const valueEl = document.createElement('div');
    valueEl.className = 'prop-window-row-value';
    valueEl.textContent = r.value;
    rowEl.appendChild(labelEl);
    rowEl.appendChild(valueEl);
    container.appendChild(rowEl);
    this.lastRowValues.set(r.key, r.value);
  }

  // プロパティ行の値だけを毎フレーム差分更新する。行構成(key・group・collapsible の並び)が
  // 変わった場合のみ行 DOM 全体を組み直す — 操作項目・ヘッダのリスナには触れないので副作用はない。
  // 描画順は「group を持つ行(グループ見出し単位、初出順)」→「無印の行」→「collapsible な行
  // (末尾の「詳細」トグルの下)」。グループ・詳細トグルの開閉状態はウィンドウが自分で持つ。
  public syncRows(rows: readonly PropertyRow[]): void {
    const shapeKey = rows.map((r) => `${r.key}${r.group ?? ''}${r.collapsible ?? ''}`).join('');
    if (shapeKey === this.lastRowShapeKey) {
      for (const r of rows) {
        if (this.lastRowValues.get(r.key) === r.value) continue;
        this.lastRowValues.set(r.key, r.value);
        const valueEl = this.rowsEl.querySelector<HTMLElement>(
          `.prop-window-row[data-key="${r.key}"] .prop-window-row-value`,
        );
        if (valueEl) valueEl.textContent = r.value;
      }
      return;
    }
    this.lastRowShapeKey = shapeKey;
    this.rowsEl.innerHTML = '';
    this.lastRowValues.clear();
    this.collapsibleContainerEl = null;
    this.toggleEl = null;

    const groupNames: string[] = [];
    const groupRows = new Map<string, PropertyRow[]>();
    const plainRows: PropertyRow[] = [];
    const collapsibleRows: PropertyRow[] = [];
    for (const r of rows) {
      if (r.group !== undefined) {
        let list = groupRows.get(r.group);
        if (!list) { list = []; groupRows.set(r.group, list); groupNames.push(r.group); }
        list.push(r);
      } else if (r.collapsible) {
        collapsibleRows.push(r);
      } else {
        plainRows.push(r);
      }
    }

    for (const name of groupNames) this.appendGroupEl(name, groupRows.get(name) ?? []);
    for (const r of plainRows) this.appendRowEl(this.rowsEl, r);
    if (collapsibleRows.length > 0) {
      const toggle = document.createElement('div');
      toggle.className = 'prop-window-row-toggle';
      toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        this.setCollapsibleExpanded(!this.collapsibleExpanded);
      });
      this.rowsEl.appendChild(toggle);
      this.toggleEl = toggle;
      const container = document.createElement('div');
      for (const r of collapsibleRows) this.appendRowEl(container, r);
      this.rowsEl.appendChild(container);
      this.collapsibleContainerEl = container;
      this.syncToggleLabel(collapsibleRows.length);
      container.style.display = this.collapsibleExpanded ? '' : 'none';
    }
    this.reclamp();
  }

  // 1グループ分の見出しボタンと行コンテナを rowsEl へ足す。開閉状態は groupExpanded に
  // 名前で記録し、既定は畳んだ状態(未登録なら false)。
  private appendGroupEl(name: string, rows: readonly PropertyRow[]): void {
    const expanded = this.groupExpanded.get(name) ?? false;
    const toggle = document.createElement('div');
    toggle.className = 'prop-window-row-group-toggle';
    toggle.textContent = groupToggleLabel(name, rows.length, expanded);
    const container = document.createElement('div');
    container.style.display = expanded ? '' : 'none';
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      const next = !(this.groupExpanded.get(name) ?? false);
      this.groupExpanded.set(name, next);
      toggle.textContent = groupToggleLabel(name, rows.length, next);
      container.style.display = next ? '' : 'none';
      this.reclamp();
    });
    this.rowsEl.appendChild(toggle);
    for (const r of rows) this.appendRowEl(container, r);
    this.rowsEl.appendChild(container);
  }

  private syncToggleLabel(count: number): void {
    if (!this.toggleEl) return;
    this.toggleEl.textContent = this.collapsibleExpanded
      ? `${COLLAPSE_EXPANDED_GLYPH} 詳細を隠す`
      : `${COLLAPSE_COLLAPSED_GLYPH} 詳細を表示 (${count})`;
  }

  private setCollapsibleExpanded(expanded: boolean): void {
    this.collapsibleExpanded = expanded;
    if (this.collapsibleContainerEl) this.collapsibleContainerEl.style.display = expanded ? '' : 'none';
    this.syncToggleLabel(this.collapsibleContainerEl?.childElementCount ?? 0);
    this.reclamp();
  }

  public get clipped(): boolean {
    return this.win.clipped;
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

  // 要求座標をビューポート内へクランプして配置する。既存ウィンドウを右クリック位置へ
  // 動かす呼び出し元から呼ぶ。
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
