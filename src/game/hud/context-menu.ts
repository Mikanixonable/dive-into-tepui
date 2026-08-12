// 画面座標に絶対配置する汎用コンテキストメニュー。開いた対象 T を保持し、項目クリックで
// onSelect(act, target) を発火して自動で閉じる。
// #hud の子として popup レイヤへ置くため、`#hud, #hud *` の margin/padding リセットに
// 勝てるよう全セレクタを `#hud` で始める。
import { clampOverlayPosition } from './layout';
import { shortcutKeyLabel } from './shortcut-hint';
import { bringToFront } from './overlay-layer';

const STYLE = `
#hud .ctx-menu {
  position: fixed; display: none; min-width: 168px;
  pointer-events: auto; background: var(--surface); border: 1px solid var(--edge);
  border-radius: var(--radius-m); overflow: hidden; font-size: var(--font-m);
  font-family: var(--font-family); user-select: none;
  -webkit-user-select: none;
}
#hud .ctx-menu-item {
  padding: var(--space-4) var(--space-5); color: var(--text); cursor: pointer;
  border-bottom: 1px solid var(--edge);
}
#hud .ctx-menu-item:last-child { border-bottom: none; }
#hud .ctx-menu-item:hover, #hud .ctx-menu-item:active {
  background: var(--accent-fill); color: var(--accent-soft);
}
#hud .ctx-menu-header {
  padding: var(--space-4) var(--space-5);
  border-bottom: 1px solid var(--edge);
  background: var(--shade-1);
  color: var(--text);
  font-weight: bold;
}
#hud .ctx-menu-header-sub {
  font-size: var(--font-s);
  opacity: 0.7;
  margin-top: var(--space-1);
  font-weight: normal;
}
`;

let styleInjected = false;
// メニューのスタイルシートを document.head へ一度だけ挿入する。
function ensureStyle(): void {
  if (styleInjected) return;
  styleInjected = true;
  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.appendChild(style);
}

export interface MenuItem<A extends string = string> {
  type?: 'item' | 'header';
  label: string;
  act?: A;
  shortcut?: string;
  subLabel?: string;
  // 排他選択肢の現在値を示す強調フラグ。ContextMenu 自身は使わず PropertyWindow が読む。
  readonly selected?: boolean;
  // 選ばれても(PropertyWindow に限り)自動で閉じない。選択肢を見比べながら切り替え直したい
  // 排他選択グループの項目に立てる。ContextMenu は選べば常に閉じるので無視する。
  readonly keepOpen?: boolean;
}

export class ContextMenu<T, A extends string = string> {
  private readonly el: HTMLDivElement;
  // 開いているメニューの対象。閉じると破棄されるので、選択結果は必ず開いた対象へ届く。
  private target: T | null = null;
  private requestedX = 0;
  private requestedY = 0;
  onSelect: ((act: A, target: T) => void) | null = null;

  // メニュー要素を popupLayer(#hud の popup レイヤ)へ追加する。要素外へのポインタ操作で自動的に閉じる。
  constructor(popupLayer: HTMLElement) {
    ensureStyle();
    this.el = document.createElement('div');
    this.el.className = 'ctx-menu';
    popupLayer.appendChild(this.el);
    this.el.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.el.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('resize', () => {
      if (this.target !== null) this.positionWithinViewport();
    });
    // キャプチャ段階で拾うことで、途中の要素が stopPropagation していても届く。
    document.addEventListener(
      'pointerdown',
      (e) => {
        if (e.target instanceof Node && this.el.contains(e.target)) return;
        this.close();
      },
      true,
    );
    window.addEventListener('keydown', this.handleKeyDown);
  }

  // 開いている項目の shortcut に一致するキー入力を選択として扱う。
  private handleKeyDown = (e: KeyboardEvent) => {
    if (this.target === null || this.el.style.display === 'none') return;
    const items = this.el.querySelectorAll<HTMLElement>('.ctx-menu-item');
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item) continue;
      if (item.dataset['shortcut'] === e.key) {
        e.stopImmediatePropagation();
        e.preventDefault();
        const act = item.dataset['act'] as A;
        const t = this.target;
        this.close();
        if (t !== null) this.onSelect?.(act, t);
        return;
      }
    }
  };

  // target を対象として items を描画し、指定した画面座標に開く。項目クリックで
  // onSelect(act, target) を発火して閉じる。
  open(clientX: number, clientY: number, target: T, items: readonly MenuItem<A>[]): void {
    this.target = target;
    this.requestedX = clientX;
    this.requestedY = clientY;
    // 項目 DOM を組み立てる。ラベルには改名可能な名前が流れうるので textContent で入れる。
    this.el.replaceChildren();
    for (const it of items) {
      if (it.type === 'header') {
        const header = document.createElement('div');
        header.className = 'ctx-menu-header';
        const main = document.createElement('div');
        main.textContent = it.label;
        header.appendChild(main);
        if (it.subLabel) {
          const sub = document.createElement('div');
          sub.className = 'ctx-menu-header-sub';
          sub.textContent = it.subLabel;
          header.appendChild(sub);
        }
        this.el.appendChild(header);
        continue;
      }
      const item = document.createElement('div');
      item.className = 'ctx-menu-item';
      item.dataset['act'] = it.act || '';
      item.dataset['shortcut'] = it.shortcut || '';
      item.textContent = it.label + (it.shortcut ? ` [${shortcutKeyLabel(it.shortcut)}]` : '');
      // クリックされた項目の act を、開いた時点の対象とともに通知して閉じる
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        const act = item.dataset['act'] as A;
        const t = this.target;
        this.close();
        if (t !== null) this.onSelect?.(act, t);
      });
      this.el.appendChild(item);
    }
    this.el.style.display = 'block';
    bringToFront(this.el);
    this.positionWithinViewport();
  }

  private positionWithinViewport(): void {
    const margin = 6;
    const rect = this.el.getBoundingClientRect();
    const pos = clampOverlayPosition(
      { x: this.requestedX, y: this.requestedY },
      rect,
      { width: window.innerWidth, height: window.innerHeight },
      margin,
    );
    this.el.style.left = `${pos.x}px`;
    this.el.style.top = `${pos.y}px`;
  }

  // メニューを閉じ、保持中の対象を破棄する。
  close(): void {
    this.el.style.display = 'none';
    this.target = null;
  }
}
