import type { ViewId, ViewManager } from '../view-manager';
import { ContextMenu, MenuItem } from './windows/context-menu';
import type { OverlayManager } from './overlay-manager';
import { Button } from './widgets';
import packageJson from '../../../package.json';

const GAME_TITLE = 'Dive into Tepui';
const GAME_VERSION = `v${packageJson.version}`;

const VIEW_LABELS: Record<ViewId, string> = { combat: 'Combat', map: 'Map' };

export interface ViewBadgeContext {
  readonly focus: string | null;
  readonly control: string | null;
  readonly target: string | null;
}

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
  private readonly contextEls: Record<keyof ViewBadgeContext, HTMLElement>;
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
    // タイトル・モード名・ビュー切替ボタンと、現在の対象コンテキストを横に並べる。
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

    const contextEls = {} as Record<keyof ViewBadgeContext, HTMLElement>;
    const contextLabels: Record<keyof ViewBadgeContext, string> = {
      focus: 'Focus', control: 'Control', target: 'Target',
    };
    const contextParts: HTMLElement[] = [];
    for (const key of Object.keys(contextLabels) as (keyof ViewBadgeContext)[]) {
      const group = document.createElement('span');
      group.className = 'vb-context';
      const label = document.createElement('span');
      label.className = 'vb-context-k';
      label.textContent = `${contextLabels[key]}:`;
      const value = document.createElement('span');
      value.className = 'vb-context-v';
      value.textContent = '—';
      group.append(label, value);
      contextEls[key] = value;
      contextParts.push(group);
    }
    this.contextEls = contextEls;

    container.append(title, this.modeEl, this.viewButton.element);
    for (const part of contextParts) {
      const separator = document.createElement('span');
      separator.className = 'vb-sep';
      separator.setAttribute('aria-hidden', 'true');
      separator.textContent = '·';
      container.append(separator, part);
    }
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

  // モード名・ビューボタン・現在の対象コンテキストを反映する。
  public sync(modeLabel: string, context: ViewBadgeContext): void {
    this.modeEl.textContent = `Mode: ${titleCase(modeLabel)}`;
    this.viewButton.setLabel(`View: ${VIEW_LABELS[this.viewManager.current]} ▾`);
    for (const key of Object.keys(this.contextEls) as (keyof ViewBadgeContext)[]) {
      const value = context[key] ?? '—';
      if (this.contextEls[key].textContent !== value) this.contextEls[key].textContent = value;
    }
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
