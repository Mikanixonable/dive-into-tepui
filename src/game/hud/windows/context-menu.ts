// 画面座標に絶対配置する汎用コンテキストメニュー。開いた対象 T を保持し、項目クリック/
// 項目ショートカットで onSelect(act, target) を発火して閉じる。
// #hud の子として popup レイヤへ置くため、`#hud, #hud *` の margin/padding リセットに
// 勝てるよう全セレクタを `#hud` で始める。
import { clampOverlayPosition } from '../../../hud/layout';
import { shortcutKeyLabel } from '../../../hud/windows/shortcut-hint';
import { bringToFront } from '../../../hud/overlay-layer';
import { onViewportChange } from '../../../hud/viewport';
import type { OverlayHandle, OverlayManager } from '../../../hud/overlay-manager';
import { injectOnce } from '../../../hud/widgets/inject-style';

const STYLE = `
#hud .ctx-menu {
  position: fixed; display: none; min-width: 168px;
  pointer-events: auto; padding: var(--space-2); background: var(--glass-focus); border: 0;
  border-radius: var(--radius-panel); overflow: hidden; font-size: var(--font-m);
  font-family: var(--font-family); user-select: none;
  box-shadow: 0 16px 48px var(--shade-1); backdrop-filter: blur(20px) saturate(82%);
  -webkit-user-select: none;
}
#hud .ctx-menu-item {
  padding: var(--space-4) var(--space-5); color: var(--body); cursor: pointer;
  border: 0; border-radius: var(--radius-micro);
}
#hud .ctx-menu-item:hover, #hud .ctx-menu-item:active {
  background: var(--surface-2); color: var(--color-primary-hover);
}
#hud .ctx-menu-item:focus-visible { outline: 2px solid var(--color-focus); outline-offset: -2px; }
#hud .ctx-menu-header {
  padding: var(--space-4) var(--space-5);
  border: 0; background: transparent; color: var(--title); font-weight: 600;
}
#hud .ctx-menu-header-sub {
  font-size: var(--font-s);
  opacity: 0.7;
  margin-top: var(--space-1);
  font-weight: normal;
}
`;

export interface MenuItem<A extends string = string> {
  type?: 'item' | 'header';
  label: string;
  act?: A;
  shortcut?: string;
  subLabel?: string;
  // 排他選択グループの現在値を示す強調フラグ。
  readonly selected?: boolean;
  // 選んでも開いたままにしたい排他選択グループの項目に立てるフラグ。選択肢を見比べながら
  // 切り替え直せるようにする。
  readonly keepOpen?: boolean;
}

export class ContextMenu<T, A extends string = string> implements OverlayHandle {
  private static nextId = 0;
  private readonly overlayId: string;
  private readonly el: HTMLDivElement;
  // 開いているメニューの対象。閉じると破棄されるので、選択結果は必ず開いた対象へ届く。
  private target: T | null = null;
  private requestedX = 0;
  private requestedY = 0;
  private previouslyFocused: HTMLElement | null = null;
  private disposed = false;
  private readonly unsubscribeViewport: () => void;
  public onSelect: ((act: A, target: T) => void) | null = null;
  public onClose: (() => void) | null = null;

  // メニュー要素を popupLayer(#hud の popup レイヤ)へ追加し、overlayManager へ登録する。
  public constructor(popupLayer: HTMLElement, private readonly overlayManager: OverlayManager) {
    this.overlayId = `ctx-menu-${ContextMenu.nextId++}`;
    injectOnce('ctx-menu', STYLE);
    // メニュー要素を組み立てて popupLayer へ追加する。
    this.el = document.createElement('div');
    this.el.className = 'ctx-menu';
    this.el.setAttribute('role', 'menu');
    popupLayer.appendChild(this.el);
    this.el.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.el.addEventListener('contextmenu', (e) => e.preventDefault());
    this.el.addEventListener('keydown', (event) => this.handleMenuNavigation(event));
    // ビューポートが変わるたびに、開いていれば位置を求め直す。
    this.unsubscribeViewport = onViewportChange(() => {
      if (this.target !== null) this.positionWithinViewport();
    });
  }

  // OverlayHandle 実装。target がメニュー要素の内部かどうかを返す。
  public contains(target: Node): boolean {
    return this.el.contains(target);
  }

  // OverlayHandle 実装。ショートカットコードに一致する項目があれば、クリックと同じ経路
  // (close→onSelect)で選択したことにする。
  public handleShortcut(code: string): boolean {
    if (this.target === null) return false;
    // 各項目のクリックリスナは自分自身を閉包で持つが、ここはコード文字列しか受け取らない
    // ので、開いた項目の DOM を dataset 経由で引き直す。
    const items = this.el.querySelectorAll<HTMLElement>('.ctx-menu-item');
    for (const item of Array.from(items)) {
      if (item.dataset['shortcut'] !== code) continue;
      const act = item.dataset['act'] as A;
      const t = this.target;
      this.close();
      if (t !== null) this.onSelect?.(act, t);
      return true;
    }
    return false;
  }

  // target を対象として items を描画し、指定した画面座標に開く。項目クリックで
  // onSelect(act, target) を発火して閉じる。
  public open(clientX: number, clientY: number, target: T, items: readonly MenuItem<A>[]): void {
    this.previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.target = target;
    this.requestedX = clientX;
    this.requestedY = clientY;
    // 項目 DOM を組み立てる。ラベルには改名可能な名前が流れうるので textContent で入れる。
    this.el.replaceChildren();
    for (const it of items) {
      if (it.type === 'header') {
        const header = document.createElement('div');
        header.className = 'ctx-menu-header';
        header.setAttribute('role', 'presentation');
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
      item.setAttribute('role', 'menuitem');
      item.tabIndex = -1;
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
      item.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        item.click();
      });
      item.addEventListener('focus', () => this.setRovingItem(item));
      this.el.appendChild(item);
    }
    this.el.style.display = 'block';
    bringToFront(this.el);
    this.positionWithinViewport();
    this.overlayManager.open(this.overlayId, this, {
      kind: 'popup', closeOnEscape: true, closeOnOutsideClick: true, gatesInput: false,
    });
    const firstItem = this.el.querySelector<HTMLElement>('.ctx-menu-item');
    if (firstItem) {
      this.setRovingItem(firstItem);
      firstItem.focus({ preventScroll: true });
    }
  }

  // 矢印キー・Home/End で項目間のフォーカスを移し、Tab では閉じる。
  private handleMenuNavigation(event: KeyboardEvent): void {
    if (event.key === 'Tab') {
      this.close();
      return;
    }
    // 現在フォーカス中の項目を基準に、押されたキーに応じた移動先を求める。
    const menuItems = Array.from(this.el.querySelectorAll<HTMLElement>('.ctx-menu-item'));
    if (menuItems.length === 0) return;
    const currentIndex = Math.max(0, menuItems.indexOf(document.activeElement as HTMLElement));
    let nextIndex: number | null = null;
    if (event.key === 'ArrowDown') nextIndex = (currentIndex + 1) % menuItems.length;
    if (event.key === 'ArrowUp') nextIndex = (currentIndex - 1 + menuItems.length) % menuItems.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = menuItems.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    // 求めた移動先へフォーカスを移す。
    const nextItem = menuItems[nextIndex]!;
    this.setRovingItem(nextItem);
    nextItem.focus({ preventScroll: true });
  }

  // フォーカス対象の項目だけ tabIndex 0 にし、それ以外を -1 にする(roving tabindex)。
  private setRovingItem(activeItem: HTMLElement): void {
    for (const item of Array.from(this.el.querySelectorAll<HTMLElement>('.ctx-menu-item'))) {
      item.tabIndex = item === activeItem ? 0 : -1;
    }
  }

  // 要求座標を基準に、ビューポート内へ収まるようメニューの位置を決める。
  private positionWithinViewport(): void {
    const margin = 6;
    const rect = this.el.getBoundingClientRect();
    // メニューの実寸とビューポートに収まるよう要求座標をクランプする。
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
  public close(): void {
    const wasOpen = this.target !== null;
    this.el.style.display = 'none';
    this.target = null;
    this.overlayManager.close(this.overlayId);
    const focusTarget = this.previouslyFocused;
    this.previouslyFocused = null;
    if (focusTarget?.isConnected) focusTarget.focus({ preventScroll: true });
    if (wasOpen) this.onClose?.();
  }

  // 開いていれば閉じ、要素とビューポート変化の購読を取り除く。以後このインスタンスは使えない。
  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.close();
    this.unsubscribeViewport();
    this.el.remove();
  }
}
