// マップ上のオブジェクトを右クリックして開く、プロパティ表示付きのドラッグ可能な小窓。
// ヘッダ(タイトル・サブタイトル・クリップボタン・✕ボタン)/ プロパティ行 / 操作項目の
// 3段で構成される。表示専用で、プロパティの値をどう導出するかは呼び出し側の責務。
// 複数存続できる想定のため ContextMenu と異なり呼び出しごとに個別のインスタンスを持つ。
// #hud の子として window レイヤへ置くため、`#hud, #hud *` の margin/padding
// リセットに勝てるよう全セレクタを `#hud` で始める。
import { CLICK_MOVE_THRESHOLD } from '../const';
import { clampOverlayPosition, Point2 } from './layout';
import { shortcutKeyLabel } from './shortcut-hint';
import { bringToFront as bringOverlayToFront } from './overlay-layer';
import { COLLAPSE_COLLAPSED_GLYPH, COLLAPSE_EXPANDED_GLYPH } from './dom';
import { Button, CloseButton, ValueInput } from './widgets';

const STYLE = `
#hud .prop-window {
  position: fixed; display: block; min-width: 200px; max-width: 280px;
  pointer-events: auto; background: var(--surface); border: 1px solid var(--edge);
  border-radius: var(--radius-m); overflow: hidden; font-size: var(--font-m);
  font-family: var(--font-family); user-select: none;
  -webkit-user-select: none;
}
#hud .prop-window-header {
  display: flex; align-items: flex-start; gap: var(--space-3);
  padding: var(--space-4) var(--space-4) var(--space-4) var(--space-5);
  border-bottom: 1px solid var(--edge);
  background: var(--shade-1);
  cursor: move;
}
#hud .prop-window-title { flex: 1; min-width: 0; }
#hud .prop-window-title-main { color: var(--text); font-weight: bold; overflow-wrap: break-word; }
#hud .prop-window-title-sub { color: var(--text); opacity: 0.7; font-size: var(--font-s); margin-top: var(--space-1); }
#hud .prop-window-title-input {
  width: 100%; background: var(--surface); border: 1px solid var(--accent); border-radius: var(--radius-s);
  color: var(--text); font: inherit; font-weight: bold; padding: var(--space-1) var(--space-2); box-sizing: border-box;
}
#hud .prop-window-btn {
  flex: none; width: 18px; height: 18px; line-height: 18px; text-align: center;
  border: 1px solid var(--edge); border-radius: var(--radius-s); background: transparent; color: var(--text);
  cursor: pointer; font-size: var(--font-s); padding: 0;
}
#hud .prop-window-btn:hover { background: var(--accent-fill); color: var(--accent-soft); }
#hud .prop-window-btn.clipped { border-color: var(--accent); color: var(--accent); }
#hud .prop-window-rows { padding: var(--space-2) 0; }
#hud .prop-window-row {
  display: flex; justify-content: space-between; gap: var(--space-4); padding: var(--space-2) var(--space-5); color: var(--text);
}
#hud .prop-window-row-label { opacity: 0.7; }
#hud .prop-window-row-value { text-align: right; }
#hud .prop-window-row-toggle {
  padding: var(--space-2) var(--space-5); color: var(--text); opacity: 0.6; cursor: pointer;
}
#hud .prop-window-row-toggle:hover { opacity: 1; color: var(--accent-soft); }
#hud .prop-window-row-group-toggle {
  padding: var(--space-2) var(--space-5); color: var(--text); opacity: 0.6; cursor: pointer;
}
#hud .prop-window-row-group-toggle:hover { opacity: 1; color: var(--accent-soft); }
#hud .prop-window-items { border-top: 1px solid var(--edge); }
#hud .prop-window-item {
  padding: var(--space-4) var(--space-5); color: var(--text); cursor: pointer; border-bottom: 1px solid var(--edge);
}
#hud .prop-window-item:last-child { border-bottom: none; }
#hud .prop-window-item:hover, #hud .prop-window-item:active {
  background: var(--accent-fill); color: var(--accent-soft);
}
#hud .prop-window-item.on {
  color: var(--accent); background: var(--accent-fill-weak);
}
#hud .prop-window-item.on::before { content: '▪ '; }
`;

let styleInjected = false;
// ウィンドウのスタイルシートを document.head へ一度だけ挿入する。
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

export interface PropertyWindowContent<A extends string = string> {
  readonly title: string;
  readonly subtitle?: string;
  readonly rows: readonly PropertyRow[];
  readonly items: readonly PropertyWindowItem<A>[];
  // 指定すると、タイトル横に改名ボタンが現れる。呼び出し側は確定した新しい名前を
  // 実体へ書き戻すところまでを行う — このクラスは編集 UI の開閉のみを持つ。
  readonly onRename?: (name: string) => void;
}

export class PropertyWindow<A extends string = string> {
  private static readonly UNSET = Symbol('unset');
  private readonly el: HTMLDivElement;
  private readonly titleMainEl: HTMLDivElement;
  private readonly titleSubEl: HTMLDivElement;
  private readonly clipBtn: Button;
  private readonly rowsEl: HTMLDivElement;
  private readonly itemsEl: HTMLDivElement;
  // 前フレームに描画したタイトル・サブタイトル。同じ値なら DOM に触れない差分更新のための記録。
  // サブタイトルは「まだ一度も描画していない」を表す専用の初期値を持つ — `undefined`(サブタイトル
  // 無し)と区別できないと、最初の syncHeader 呼び出しが「変化なし」と判定され titleSubEl の
  // display が一度も設定されないままになる。
  private lastTitle = '';
  private lastSubtitle: string | undefined | typeof PropertyWindow.UNSET = PropertyWindow.UNSET;
  // 前フレームに描画した行の値。同じ値なら DOM に触れない差分更新のための記録。
  private lastRowValues = new Map<string, string>();
  // 前フレームの行構成(key・group・collapsible の並び)。DOM 組み直しの要否判定に使う。
  private lastRowShapeKey = '';
  private collapsibleContainerEl: HTMLDivElement | null = null;
  private toggleEl: HTMLDivElement | null = null;
  private collapsibleExpanded = false;
  // グループ名ごとの開閉状態。syncRows の再構築をまたいで保つ。
  private readonly groupExpanded = new Map<string, boolean>();
  // 前回描画した操作項目の直列化(act/label/shortcut)。同じなら DOM を組み直さない。
  private lastItemsKey = '';
  private _clipped = false;
  private disposed = false;
  private readonly renameCallback: ((name: string) => void) | null;
  private renaming = false;

  private dragPointerId: number | null = null;
  private dragStartClient: Point2 | null = null;
  private dragStartWindowPos: Point2 = { x: 0, y: 0 };
  private dragging = false;

  private readonly onOutsidePointerDown: (e: PointerEvent) => void;
  private readonly onResize: () => void;

  // keepOpen はクリックした項目自身の PropertyWindowItem.keepOpen — 呼び出し側はこれを見て
  // 自動クローズを抑制するかを判断する(クリップ状態は別に呼び出し側が持つ)。
  onSelect: ((act: A, keepOpen: boolean) => void) | null = null;
  // ✕ ボタンで閉じられた(dispose 済み)ことを呼び出し側の管理台帳へ知らせる。
  onClose: (() => void) | null = null;
  // ウィンドウ外での pointerdown を通知するのみで、閉じる/閉じないの判断は呼び出し側が行う。
  onOutsideClick: (() => void) | null = null;
  // クリップボタンで状態が反転したことを通知する。一時ウィンドウの台帳(高々1枚)は
  // 呼び出し側が持つので、その入れ替えは通知を受けて呼び出し側が行う。
  onClipChange: ((clipped: boolean) => void) | null = null;

  // clientX/clientY を左上角として root の子として開き、content の内容で組み立てる。
  // ヘッダ・行・操作項目の3段を構築してから DOM に追加し、外側クリック/resize の
  // グローバルリスナを登録する。
  constructor(root: HTMLElement, clientX: number, clientY: number, content: PropertyWindowContent<A>) {
    ensureStyle();
    this.el = document.createElement('div');
    this.el.className = 'prop-window';

    const header = document.createElement('div');
    header.className = 'prop-window-header';
    const title = document.createElement('div');
    title.className = 'prop-window-title';
    this.titleMainEl = document.createElement('div');
    this.titleMainEl.className = 'prop-window-title-main';
    this.titleSubEl = document.createElement('div');
    this.titleSubEl.className = 'prop-window-title-sub';
    title.appendChild(this.titleMainEl);
    title.appendChild(this.titleSubEl);

    this.renameCallback = content.onRename ?? null;
    let renameBtn: Button | null = null;
    if (this.renameCallback) {
      renameBtn = new Button('✎', () => this.startRename());
      renameBtn.element.classList.add('prop-window-btn');
      renameBtn.element.title = '名前を変更';
      renameBtn.element.setAttribute('aria-label', '名前を変更');
    }

    this.clipBtn = new Button('📌', () => this.setClipped(!this._clipped));
    this.clipBtn.element.classList.add('prop-window-btn');
    this.clipBtn.element.title = 'クリップ';
    this.clipBtn.element.setAttribute('aria-label', 'クリップ');

    // ✕ は他の3窓(格納庫/セーブブラウザ/設定)と同じ見た目に統一する。
    const closeBtn = new CloseButton(() => {
      this.dispose();
      this.onClose?.();
    });

    header.appendChild(title);
    if (renameBtn) header.appendChild(renameBtn.element);
    header.appendChild(this.clipBtn.element);
    header.appendChild(closeBtn.element);
    header.addEventListener('pointerdown', this.handleHeaderPointerDown);
    header.addEventListener('pointermove', this.handleHeaderPointerMove);
    header.addEventListener('pointerup', this.handleHeaderPointerUp);
    header.addEventListener('pointercancel', this.handleHeaderPointerUp);

    this.rowsEl = document.createElement('div');
    this.rowsEl.className = 'prop-window-rows';
    this.itemsEl = document.createElement('div');
    this.itemsEl.className = 'prop-window-items';

    this.el.appendChild(header);
    this.el.appendChild(this.rowsEl);
    this.el.appendChild(this.itemsEl);
    this.el.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.el.addEventListener('contextmenu', (e) => e.preventDefault());
    root.appendChild(this.el);

    this.onOutsidePointerDown = (e: PointerEvent) => {
      if (e.target instanceof Node && this.el.contains(e.target)) return;
      this.onOutsideClick?.();
    };
    // キャプチャ段階で拾うことで、途中の要素が stopPropagation していても届く。
    document.addEventListener('pointerdown', this.onOutsidePointerDown, true);
    this.onResize = () => this.moveTo(this.el.offsetLeft, this.el.offsetTop);
    window.addEventListener('resize', this.onResize);
    window.addEventListener('keydown', this.handleKeyDown);

    this.syncHeader(content.title, content.subtitle);
    this.syncRows(content.rows);
    this.syncItems(content.items);
    this.moveTo(clientX, clientY);
    this.bringToFront();
  }

  // タイトル・サブタイトルを変化があった要素だけ差分更新する。
  syncHeader(title: string, subtitle: string | undefined): void {
    if (title !== this.lastTitle) {
      this.lastTitle = title;
      this.titleMainEl.textContent = title;
    }
    if (subtitle !== this.lastSubtitle) {
      this.lastSubtitle = subtitle;
      this.titleSubEl.textContent = subtitle ?? '';
      this.titleSubEl.style.display = subtitle ? 'block' : 'none';
      this.reclamp();
    }
  }

  // タイトルを編集用の入力欄へ差し替え、確定(Enter/blur)で renameCallback へ通知して
  // 表示へ戻す。ValueInput 自身が keydown を止めるので、window の全体ショートカット
  // (handleKeyDown 含む)には届かない。
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
    input.element.focus();
    input.element.select();
  }

  // リネーム入力欄を終える。value が確定文字列なら(かつ現在のタイトルと異なれば)
  // renameCallback へ通知し、表示をタイトル要素へ戻す。破棄(Escape/無効値)は value が null。
  private finishRename(input: ValueInput, value: string | null): void {
    if (!this.renaming) return;
    this.renaming = false;
    input.element.replaceWith(this.titleMainEl);
    const trimmed = value?.trim();
    if (trimmed && trimmed !== this.lastTitle) this.renameCallback?.(trimmed);
  }

  // 操作項目の集合・ラベル・ショートカットが変わったときだけ DOM を組み直す。クリップ済み
  // ウィンドウでは可変な状態(操作対象か等)に応じて呼び出し側から毎フレーム渡されうる。
  syncItems(items: readonly PropertyWindowItem<A>[]): void {
    const key = items.map((it) => `${it.act} ${it.label} ${it.shortcut ?? ''} ${it.selected ?? ''} ${it.keepOpen ?? ''}`).join('|');
    if (key === this.lastItemsKey) return;
    this.lastItemsKey = key;
    this.itemsEl.innerHTML = '';
    for (const it of items) {
      const row = document.createElement('div');
      row.className = 'prop-window-item';
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
      this.itemsEl.appendChild(row);
    }
    this.reclamp();
  }

  // ショートカットは一時ウィンドウ(非クリップ)でのみ効く。一時ウィンドウは高々1枚なので
  // 複数ウィンドウが同じキーを取り合う曖昧さは生じない。
  private readonly handleKeyDown = (e: KeyboardEvent): void => {
    if (this._clipped) return;
    const items = this.itemsEl.querySelectorAll<HTMLElement>('.prop-window-item');
    for (const item of Array.from(items)) {
      if (item.dataset['shortcut'] === e.key) {
        e.stopImmediatePropagation();
        e.preventDefault();
        this.onSelect?.(item.dataset['act'] as A, item.dataset['keepOpen'] === '1');
        return;
      }
    }
  };

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
  syncRows(rows: readonly PropertyRow[]): void {
    const shapeKey = rows.map((r) => `${r.key}${r.group ?? ''}${r.collapsible ?? ''}`).join('');
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

  get clipped(): boolean {
    return this._clipped;
  }

  // クリップボタンからのみ呼ばれる。ボタンの見た目を切り替えたうえで onClipChange を発火する
  // — 自動クローズ対象・一時ウィンドウ台帳からの出し入れは呼び出し側の仕事。
  private setClipped(clipped: boolean): void {
    this._clipped = clipped;
    this.clipBtn.element.classList.toggle('clipped', clipped);
    this.onClipChange?.(clipped);
  }

  // window レイヤ内で最前面にする。
  bringToFront(): void {
    bringOverlayToFront(this.el);
  }

  // 現在位置を要求座標としてビューポート内へクランプし直す。内容の変化でサイズが伸びた
  // ときに使う — ドラッグで動かした位置はそのまま尊重しつつ、画面外へのはみ出しだけ戻す。
  private reclamp(): void {
    this.moveTo(this.el.offsetLeft, this.el.offsetTop);
  }

  // 要求座標をビューポート内へクランプして配置する。ドラッグ・resize 再クランプ・
  // 既存ウィンドウを右クリック位置へ動かす呼び出し元の全てから呼ぶ。
  moveTo(clientX: number, clientY: number): void {
    const rect = this.el.getBoundingClientRect();
    const pos = clampOverlayPosition(
      { x: clientX, y: clientY },
      { width: rect.width, height: rect.height },
      { width: window.innerWidth, height: window.innerHeight },
    );
    this.el.style.left = `${pos.x}px`;
    this.el.style.top = `${pos.y}px`;
  }

  // ボタン上からは開始せず、ドラッグ開始点とポインタキャプチャだけ確保する。
  private handleHeaderPointerDown = (e: PointerEvent): void => {
    if (e.target instanceof Element && e.target.closest('button')) return;
    this.dragPointerId = e.pointerId;
    this.dragStartClient = { x: e.clientX, y: e.clientY };
    this.dragStartWindowPos = { x: this.el.offsetLeft, y: this.el.offsetTop };
    this.dragging = false;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  // しきい値(CLICK_MOVE_THRESHOLD)を超えて動くまではドラッグ開始とみなさない。
  private handleHeaderPointerMove = (e: PointerEvent): void => {
    if (this.dragPointerId !== e.pointerId || this.dragStartClient === null) return;
    const dx = e.clientX - this.dragStartClient.x;
    const dy = e.clientY - this.dragStartClient.y;
    if (!this.dragging && Math.hypot(dx, dy) < CLICK_MOVE_THRESHOLD) return;
    this.dragging = true;
    this.moveTo(this.dragStartWindowPos.x + dx, this.dragStartWindowPos.y + dy);
  };

  // ポインタキャプチャを解放してドラッグ状態を終える。
  private handleHeaderPointerUp = (e: PointerEvent): void => {
    if (this.dragPointerId !== e.pointerId) return;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    this.dragPointerId = null;
    this.dragStartClient = null;
    this.dragging = false;
  };

  // DOM ノードと登録したグローバルリスナを取り除く。以後このインスタンスは使えない。
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    document.removeEventListener('pointerdown', this.onOutsidePointerDown, true);
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('keydown', this.handleKeyDown);
    this.el.remove();
  }
}
