import type { ViewId, ViewManager } from '../view-manager';
import { ContextMenu, MenuItem } from './context-menu';

const GAME_TITLE = 'Dive into Tepui';
const GAME_VERSION = 'v0.0.1';

const VIEW_LABELS: Record<ViewId, string> = { combat: 'Combat', map: 'Map', dock: 'Dock' };

// 語ごとの先頭だけ大文字化する。selectLabel が 'CREATIVE' / 'stage 1' のように
// 大小文字混じりで来るので、表示用に体裁だけ揃える。
function titleCase(s: string): string {
  return s.replace(/\S+/g, (w) => (w[0] ?? '').toUpperCase() + w.slice(1).toLowerCase());
}

// 画面右上のバッジ: ゲームタイトル・現在のモード・現在のビュー(クリックで遷移メニュー)。
export class ViewBadge {
  private readonly modeEl: HTMLElement;
  private readonly viewButton: HTMLButtonElement;
  // ContextMenu は target !== null であることを onSelect 発火の条件にしているので、
  // 対象を持たないこのメニューでも null 以外のダミー値を渡す。
  private readonly menu = new ContextMenu<true, ViewId>();
  private combatAvailable = false;

  // バッジの DOM を組み立てて root へ追加し、ビュー選択メニューを配線する。
  constructor(root: HTMLElement, private readonly viewManager: ViewManager) {
    // タイトル・モード名・ビュー切替ボタンの3つを横に並べる。
    const badge = document.createElement('div');
    badge.id = 'hud-viewbadge';
    badge.addEventListener('pointerdown', (e) => e.stopPropagation());

    const title = document.createElement('span');
    title.className = 'vb-title';
    title.textContent = `${GAME_TITLE} ${GAME_VERSION}`;
    this.modeEl = document.createElement('span');
    this.modeEl.className = 'vb-mode';
    this.viewButton = document.createElement('button');
    this.viewButton.className = 'vb-view-btn';
    this.viewButton.addEventListener('click', () => this.openMenu());

    for (const el of [title, this.modeEl, this.viewButton]) badge.appendChild(el);
    root.appendChild(badge);

    this.menu.onSelect = (view) => this.viewManager.setView(view);
  }

  // モード名とビューボタンの表示を反映する。combatAvailable は戦闘ビューへ入れるか
  // ([M] と同じ判定 — activeStage.isPlaying && 操作艦が生存)。
  sync(modeLabel: string, combatAvailable: boolean): void {
    this.modeEl.textContent = `Mode: ${titleCase(modeLabel)}`;
    this.viewButton.textContent = `View: ${VIEW_LABELS[this.viewManager.current]} ▾`;
    this.combatAvailable = combatAvailable;
  }

  // 遷移できるビューが1つも無ければメニュー自体を開かない。
  private openMenu(): void {
    const items: MenuItem<ViewId>[] = this.viewManager
      .selectableViews(this.combatAvailable)
      .map((v) => ({ label: VIEW_LABELS[v], act: v }));
    if (items.length === 0) return;
    const rect = this.viewButton.getBoundingClientRect();
    this.menu.open(rect.right, rect.bottom, true, items);
  }
}
