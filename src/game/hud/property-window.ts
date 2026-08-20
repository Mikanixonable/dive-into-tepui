// マップ上のオブジェクトを右クリックして開く、プロパティ表示付きのウィンドウ。
// `draggable-window.ts` のドラッグ・📌クリップ・✕・OverlayManager 登録を土台に、
// プロパティ行 / 操作項目の2段を組み立てる。表示専用で、プロパティの値をどう導出するかは
// 呼び出し側の責務。複数存続できる想定のため ContextMenu と異なり呼び出しごとに個別の
// インスタンスを持つ。
// #hud の子として window レイヤへ置くため、`#hud, #hud *` の margin/padding
// リセットに勝てるよう全セレクタを `#hud` で始める。
import { DraggableWindow } from './draggable-window';
import { shortcutKeyLabel } from './shortcut-hint';
import { COLLAPSE_COLLAPSED_GLYPH, COLLAPSE_EXPANDED_GLYPH } from './hud-root';
import type { OverlayHandle, OverlayManager } from './overlay-manager';

const STYLE = `
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
#hud .prop-window-items {
  padding: var(--space-2);
  background: color-mix(in srgb, var(--surface-0) 28%, transparent);
}
#hud .prop-window-item {
  padding: var(--space-4) var(--space-5); color: var(--body); cursor: pointer;
  border: 0; border-radius: var(--radius-micro);
}
#hud .prop-window-item:hover, #hud .prop-window-item:active {
  background: var(--surface-2); color: var(--accent-near);
}
#hud .prop-window-item.on {
  color: var(--accent); background: var(--accent-fill);
}
#hud .prop-window-item.on::before { content: '▪ '; }
#hud .prop-window-item:focus-visible { outline: 2px solid var(--accent-near); outline-offset: -2px; }
`;

let styleInjected = false;

function ensureStyle(): void {
  if (styleInjected) return;
  styleInjected = true;
  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.appendChild(style);
}

// 行グループ見出しの文字列を組む。
function groupToggleLabel(name: string, rowCount: number, expanded: boolean): string {
  return expanded
    ? `${COLLAPSE_EXPANDED_GLYPH} ${name}`
    : `${COLLAPSE_COLLAPSED_GLYPH} ${name} (${rowCount})`;
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

export class PropertyWindow<A extends string = string> implements OverlayHandle {
  private readonly win: DraggableWindow;
  private readonly rowsEl: HTMLDivElement;
  private readonly itemsEl: HTMLDivElement;
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
  // 行・操作項目の2段を構築してから DraggableWindow の body へ足す。
  // tempWindowGroup を渡すと、クリップされていない間だけ OverlayManager 上の排他グループに
  // 参加する一時ウィンドウになる(ESC・外側クリックで自動的に閉じ、同グループの他方も追い出す)。
  // 省略すると(例: 負荷確認ウィンドウ)ESC・外側クリックのどちらでも閉じない常設ウィンドウになる。
  public constructor(
    root: HTMLElement, clientX: number, clientY: number, content: PropertyWindowContent<A>,
    overlayManager: OverlayManager, tempWindowGroup?: string,
  ) {
    ensureStyle();
    this.win = new DraggableWindow(
      root, clientX, clientY,
      { title: content.title, subtitle: content.subtitle, onRename: content.onRename },
      overlayManager, tempWindowGroup,
    );
    this.win.onClose = () => this.onClose?.();
    this.win.onClipChange = (clipped) => this.onClipChange?.(clipped);
    this.win.onHandleShortcut = (code) => this.selectItemByShortcut(code);

    this.rowsEl = document.createElement('div');
    this.rowsEl.className = 'prop-window-rows';
    this.itemsEl = document.createElement('div');
    this.itemsEl.className = 'prop-window-items';
    this.win.body.appendChild(this.rowsEl);
    this.win.body.appendChild(this.itemsEl);

    this.syncRows(content.rows);
    this.syncItems(content.items);
  }

  public contains(target: Node): boolean {
    return this.win.contains(target);
  }

  // OverlayManager からの項目ショートカット配送を受ける。クリップ中は DraggableWindow 側で
  // 断られるので、ここへ届くのはクリップされていないときだけ。
  public handleShortcut(code: string): boolean {
    return this.win.handleShortcut(code);
  }

  // handleShortcut/DraggableWindow.onHandleShortcut から呼ばれる実処理。開いている
  // 操作項目の中から一致するショートカットを探し、あれば選択したのと同じ経路で発火する。
  private selectItemByShortcut(code: string): boolean {
    const items = this.itemsEl.querySelectorAll<HTMLElement>('.prop-window-item');
    for (const item of Array.from(items)) {
      if (item.dataset['shortcut'] !== code) continue;
      this.onSelect?.(item.dataset['act'] as A, item.dataset['keepOpen'] === '1');
      return true;
    }
    return false;
  }

  // タイトル・サブタイトルを変化があった要素だけ差分更新する。
  public syncHeader(title: string, subtitle: string | undefined): void {
    this.win.syncHeader(title, subtitle);
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
    this.win.reclamp();
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
    this.win.reclamp();
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
      this.win.reclamp();
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
    this.win.reclamp();
  }

  public get clipped(): boolean {
    return this.win.clipped;
  }

  // window レイヤ内で最前面にする。
  public bringToFront(): void {
    this.win.bringToFront();
  }

  // 要求座標をビューポート内へクランプして配置する。ドラッグ・resize 再クランプ・
  // 既存ウィンドウを右クリック位置へ動かす呼び出し元の全てから呼ぶ。
  public moveTo(clientX: number, clientY: number): void {
    this.win.moveTo(clientX, clientY);
  }

  // DOM ノードと登録したグローバルリスナを取り除き、overlayManager からも外す。
  // 以後このインスタンスは使えない。
  public dispose(): void {
    this.win.dispose();
  }

  // OverlayHandle 実装: ✕ ボタンと同じ「破棄して呼び出し側へ通知する」経路。ESC・外側クリック
  // どちらで閉じてもここを通るので、onClose の発火経路は一本化される。
  public close(): void {
    this.win.close();
  }
}
