import type { ViewId, ViewManager } from '../view-manager';
import { ContextMenu, MenuItem } from './windows/context-menu';
import type { OverlayManager } from './overlay-manager';
import { Button } from './widgets';
import packageJson from '../../../package.json';

const GAME_TITLE = 'Dive into Tepui';
const GAME_VERSION = `v${packageJson.version}`;

const VIEW_LABELS: Record<ViewId, string> = { combat: 'Combat', map: 'Map', dock: 'Base' };

// 語ごとの先頭だけ大文字化する。selectLabel が 'CREATIVE' / 'stage 1' のように
// 大小文字混じりで来るので、表示用に体裁だけ揃える。
function titleCase(s: string): string {
  return s.replace(/\S+/g, (w) => (w[0] ?? '').toUpperCase() + w.slice(1).toLowerCase());
}

// グローバルステータスバー1行目のバッジ: ゲームタイトル・現在のモード・現在のビュー(クリックで遷移メニュー)。
export class ViewBadge {
  private readonly el: HTMLElement;
  private readonly modeEl: HTMLElement;
  private readonly viewButton: Button;
  // ContextMenu は target !== null であることを onSelect 発火の条件にしているので、
  // 対象を持たないこのメニューでも null 以外のダミー値を渡す。
  private readonly menu: ContextMenu<true, string>;
  private readonly stopPointerDown = (e: Event): void => e.stopPropagation();

  // container(グローバルステータスバー1行目の行)へバッジの中身を、遷移メニューを popupLayer へ組み立てて配線する。
  public constructor(
    container: HTMLElement, popupLayer: HTMLElement, private readonly viewManager: ViewManager,
    overlayManager: OverlayManager,
  ) {
    this.menu = new ContextMenu<true, string>(popupLayer, overlayManager);
    // タイトル・モード名・ビュー切替ボタンの3つを横に並べる。
    container.setAttribute('role', 'navigation');
    container.setAttribute('aria-label', 'ビュー切り替え');
    container.addEventListener('pointerdown', this.stopPointerDown);

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

    for (const el of [title, this.modeEl, this.viewButton.element]) container.appendChild(el);
    this.el = container;

    this.menu.onSelect = (act) => {
      const item = this.viewManager.getSelectableMenuItems().find((m) => m.id === act);
      if (item) this.viewManager.selectMenuItem(item);
    };
    this.menu.onClose = () => this.viewButton.element.setAttribute('aria-expanded', 'false');
  }

  // 遷移メニューを片付け、container(Hud が持ち続ける行)から自分が足した中身だけを取り除く。
  public dispose(): void {
    this.menu.dispose();
    this.el.removeEventListener('pointerdown', this.stopPointerDown);
    this.el.replaceChildren();
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
