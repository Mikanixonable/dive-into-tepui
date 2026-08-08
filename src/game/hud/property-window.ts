// マップ上のオブジェクトを右クリックして開く、プロパティ表示付きのドラッグ可能な小窓。
// ヘッダ(タイトル・サブタイトル・クリップボタン・✕ボタン)/ プロパティ行 / 操作項目の
// 3段で構成される。表示専用で、プロパティの値をどう導出するかは呼び出し側の責務。
// 複数存続できる想定のため ContextMenu と異なり呼び出しごとに個別のインスタンスを持つ。
import { ACCENT, ACCENT_RGB, ACCENT_SOFT, EDGE, SURFACE, TEXT as INK, FONT } from '../theme';
import { CLICK_MOVE_THRESHOLD } from '../const';
import { clampOverlayPosition, Point2 } from './layout';

const STYLE = `
.prop-window {
  position: fixed; display: block; min-width: 200px; max-width: 280px; z-index: 11;
  pointer-events: auto; background: ${SURFACE}; border: 1px solid ${EDGE};
  border-radius: 4px; overflow: hidden; font-size: 12px;
  font-family: ${FONT}; user-select: none;
  -webkit-user-select: none;
}
.prop-window-header {
  display: flex; align-items: flex-start; gap: 6px;
  padding: 8px 8px 8px 12px;
  border-bottom: 1px solid ${EDGE};
  background: rgba(0, 0, 0, 0.2);
  cursor: move;
}
.prop-window-title { flex: 1; min-width: 0; }
.prop-window-title-main { color: ${INK}; font-weight: bold; overflow-wrap: break-word; }
.prop-window-title-sub { color: ${INK}; opacity: 0.7; font-size: 11px; margin-top: 2px; }
.prop-window-btn {
  flex: none; width: 18px; height: 18px; line-height: 18px; text-align: center;
  border: 1px solid ${EDGE}; border-radius: 3px; background: transparent; color: ${INK};
  cursor: pointer; font-size: 11px; padding: 0;
}
.prop-window-btn:hover { background: rgba(${ACCENT_RGB}, 0.18); color: ${ACCENT_SOFT}; }
.prop-window-btn.clipped { border-color: ${ACCENT}; color: ${ACCENT}; }
.prop-window-rows { padding: 4px 0; }
.prop-window-row {
  display: flex; justify-content: space-between; gap: 10px; padding: 3px 12px; color: ${INK};
}
.prop-window-row-label { opacity: 0.7; }
.prop-window-row-value { text-align: right; }
.prop-window-items { border-top: 1px solid ${EDGE}; }
.prop-window-item {
  padding: 9px 14px; color: ${INK}; cursor: pointer; border-bottom: 1px solid ${EDGE};
}
.prop-window-item:last-child { border-bottom: none; }
.prop-window-item:hover, .prop-window-item:active {
  background: rgba(${ACCENT_RGB}, 0.18); color: ${ACCENT_SOFT};
}
`;

let styleInjected = false;
// ウィンドウのスタイルシートを document.head へ一度だけ挿入する。
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
}

export interface PropertyWindowItem<A extends string = string> {
  readonly label: string;
  readonly act: A;
}

export interface PropertyWindowContent<A extends string = string> {
  readonly title: string;
  readonly subtitle?: string;
  readonly rows: readonly PropertyRow[];
  readonly items: readonly PropertyWindowItem<A>[];
}

export class PropertyWindow<A extends string = string> {
  private readonly el: HTMLDivElement;
  private readonly titleMainEl: HTMLDivElement;
  private readonly titleSubEl: HTMLDivElement;
  private readonly clipBtnEl: HTMLButtonElement;
  private readonly rowsEl: HTMLDivElement;
  private readonly itemsEl: HTMLDivElement;
  // 前フレームに描画した行の値。同じ値なら DOM に触れない差分更新のための記録。
  private lastRowValues = new Map<string, string>();
  private _clipped = false;
  private disposed = false;

  private dragPointerId: number | null = null;
  private dragStartClient: Point2 | null = null;
  private dragStartWindowPos: Point2 = { x: 0, y: 0 };
  private dragging = false;

  private readonly onOutsidePointerDown: (e: PointerEvent) => void;
  private readonly onResize: () => void;

  onSelect: ((act: A) => void) | null = null;
  // ✕ ボタンで閉じられた(dispose 済み)ことを呼び出し側の管理台帳へ知らせる。
  onClose: (() => void) | null = null;
  // ウィンドウ外での pointerdown を通知するのみで、閉じる/閉じないの判断は呼び出し側が行う。
  onOutsideClick: (() => void) | null = null;

  // clientX/clientY を左上角として開き、content の内容で1回だけ組み立てる。
  // ヘッダ・行・操作項目の3段を構築してから DOM に追加し、外側クリック/resize の
  // グローバルリスナを登録する。
  constructor(clientX: number, clientY: number, content: PropertyWindowContent<A>) {
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

    this.clipBtnEl = document.createElement('button');
    this.clipBtnEl.className = 'prop-window-btn';
    this.clipBtnEl.textContent = '📌';
    this.clipBtnEl.title = 'クリップ';
    this.clipBtnEl.addEventListener('click', (e) => {
      e.stopPropagation();
      this.setClipped(!this._clipped);
    });

    const closeBtn = document.createElement('button');
    closeBtn.className = 'prop-window-btn';
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.dispose();
      this.onClose?.();
    });

    header.appendChild(title);
    header.appendChild(this.clipBtnEl);
    header.appendChild(closeBtn);
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
    document.body.appendChild(this.el);

    this.onOutsidePointerDown = (e: PointerEvent) => {
      if (e.target instanceof Node && this.el.contains(e.target)) return;
      this.onOutsideClick?.();
    };
    // キャプチャ段階で拾うことで、途中の要素が stopPropagation していても届く。
    document.addEventListener('pointerdown', this.onOutsidePointerDown, true);
    this.onResize = () => this.moveTo(this.el.offsetLeft, this.el.offsetTop);
    window.addEventListener('resize', this.onResize);

    this.titleMainEl.textContent = content.title;
    this.titleSubEl.textContent = content.subtitle ?? '';
    this.titleSubEl.style.display = content.subtitle ? 'block' : 'none';
    this.syncRows(content.rows);
    this.buildItems(content.items);
    this.moveTo(clientX, clientY);
  }

  // 操作項目を1回だけ描画する。クリックは onSelect(act) を発火するのみで、閉じるかどうかは
  // 呼び出し側(クリップ状態)が決める。
  private buildItems(items: readonly PropertyWindowItem<A>[]): void {
    for (const it of items) {
      const row = document.createElement('div');
      row.className = 'prop-window-item';
      row.textContent = it.label;
      row.addEventListener('click', (e) => {
        // 外側 pointerdown 検出のキャプチャリスナへ伝播しないようにする。
        e.stopPropagation();
        this.onSelect?.(it.act);
      });
      this.itemsEl.appendChild(row);
    }
  }

  // プロパティ行の値だけを毎フレーム差分更新する。行集合(key の並び)が変わった場合のみ
  // 行 DOM 全体を組み直す — 操作項目・ヘッダのリスナには触れないので副作用はない。
  syncRows(rows: readonly PropertyRow[]): void {
    // key 集合が前回と同じなら値だけ書き換え、変わっていれば行 DOM ごと組み直す。
    const sameShape =
      rows.length === this.lastRowValues.size && rows.every((r) => this.lastRowValues.has(r.key));
    if (!sameShape) {
      this.rowsEl.innerHTML = '';
      this.lastRowValues.clear();
      for (const r of rows) {
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
        this.rowsEl.appendChild(rowEl);
        this.lastRowValues.set(r.key, r.value);
      }
      return;
    }
    for (const r of rows) {
      if (this.lastRowValues.get(r.key) === r.value) continue;
      this.lastRowValues.set(r.key, r.value);
      const valueEl = this.rowsEl.querySelector<HTMLElement>(
        `.prop-window-row[data-key="${r.key}"] .prop-window-row-value`,
      );
      if (valueEl) valueEl.textContent = r.value;
    }
  }

  get clipped(): boolean {
    return this._clipped;
  }

  // クリップボタンからのみ呼ばれる。自動クローズ対象から外すかどうかの判断は呼び出し側の仕事で、
  // ここでは状態とボタンの見た目を切り替えるだけ。
  private setClipped(clipped: boolean): void {
    this._clipped = clipped;
    this.clipBtnEl.classList.toggle('clipped', clipped);
  }

  // DOM 順を末尾へ動かして最前面にする(z-index は増やさない)。
  bringToFront(): void {
    document.body.appendChild(this.el);
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
    this.el.remove();
  }
}
