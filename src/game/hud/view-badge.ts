import type { ViewId, ViewManager } from '../view-manager';
import { ContextMenu, MenuItem } from './context-menu';
import type { OverlayManager } from './overlay-manager';
import { Button } from './widgets';
import packageJson from '../../../package.json';

const GAME_TITLE = 'Dive into Tepui';
const GAME_VERSION = `v${packageJson.version}`;

const VIEW_LABELS: Record<ViewId, string> = { combat: 'Combat', map: 'Map', dock: 'Vessel' };

// 語ごとの先頭だけ大文字化する。selectLabel が 'CREATIVE' / 'stage 1' のように
// 大小文字混じりで来るので、表示用に体裁だけ揃える。
function titleCase(s: string): string {
  return s.replace(/\S+/g, (w) => (w[0] ?? '').toUpperCase() + w.slice(1).toLowerCase());
}

// 画面右上のバッジ: ゲームタイトル・現在のモード・現在のビュー(クリックで遷移メニュー)。
export class ViewBadge {
  private readonly el: HTMLElement;
  private readonly modeEl: HTMLElement;
  private readonly viewButton: Button;
  // ContextMenu は target !== null であることを onSelect 発火の条件にしているので、
  // 対象を持たないこのメニューでも null 以外のダミー値を渡す。
  private readonly menu: ContextMenu<true, string>;

  // バッジの DOM を root へ、遷移メニューを popupLayer へ組み立てて配線する。
  public constructor(
    root: HTMLElement, popupLayer: HTMLElement, private readonly viewManager: ViewManager,
    overlayManager: OverlayManager,
  ) {
    this.menu = new ContextMenu<true, string>(popupLayer, overlayManager);
    // タイトル・モード名・ビュー切替ボタンの3つを横に並べる。
    const badge = document.createElement('div');
    badge.id = 'hud-viewbadge';
    badge.setAttribute('role', 'navigation');
    badge.setAttribute('aria-label', 'ビュー切り替え');
    badge.addEventListener('pointerdown', (e) => e.stopPropagation());

    const title = document.createElement('span');
    title.className = 'vb-title';
    title.textContent = `${GAME_TITLE} ${GAME_VERSION}`;
    this.modeEl = document.createElement('span');
    this.modeEl.className = 'vb-mode';
    this.viewButton = new Button('', () => this.openMenu());
    this.viewButton.element.classList.add('vb-view-btn');
    this.viewButton.element.setAttribute('aria-haspopup', 'menu');
    this.viewButton.element.setAttribute('aria-label', '表示するビューを選ぶ');
    this.viewButton.element.setAttribute('aria-expanded', 'false');

    for (const el of [title, this.modeEl, this.viewButton.element]) badge.appendChild(el);
    root.appendChild(badge);
    this.el = badge;

    this.menu.onSelect = (act) => {
      const item = this.viewManager.getSelectableMenuItems().find((m) => m.id === act);
      if (item) this.viewManager.selectMenuItem(item);
    };
    this.menu.onClose = () => this.viewButton.element.setAttribute('aria-expanded', 'false');
  }

  // バッジの DOM と遷移メニューを片付ける。
  public dispose(): void {
    this.menu.dispose();
    this.el.remove();
  }

  // モード名とビューボタンの表示を反映する。
  public sync(modeLabel: string): void {
    this.modeEl.textContent = `Mode: ${titleCase(modeLabel)}`;
    this.viewButton.setLabel(`View: ${VIEW_LABELS[this.viewManager.current]} ▾`);
  }

  // 遷移できるビューが1つも無ければメニュー自体を開かない。
  private openMenu(): void {
    const selectable = this.viewManager.getSelectableMenuItems();
    const items: MenuItem<string>[] = selectable.map((item) => ({ label: item.label, act: item.id }));
    if (items.length === 0) return;
    const rect = this.viewButton.element.getBoundingClientRect();
    this.viewButton.element.setAttribute('aria-expanded', 'true');
    this.menu.open(rect.right, rect.bottom, true, items);
  }
}
