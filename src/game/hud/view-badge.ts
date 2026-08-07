import { MapModeToggler } from '../map-mode-toggler';
import { DockView } from './dock-view';
import { ContextMenu, MenuItem } from './context-menu';

const GAME_TITLE = 'Dive into Tepui';
const GAME_VERSION = 'v0.0.1';

type ViewId = 'combat' | 'map' | 'dock';
const VIEW_LABELS: Record<ViewId, string> = { combat: 'Combat', map: 'Map', dock: 'Dock' };

// 語ごとの先頭だけ大文字化する。selectLabel が 'CREATIVE' / 'stage 1' のように
// 大小文字混じりで来るので、表示用に体裁だけ揃える。
function titleCase(s: string): string {
  return s.replace(/\S+/g, (w) => (w[0] ?? '').toUpperCase() + w.slice(1).toLowerCase());
}

// マップモード右上のバッジ: ゲームタイトル・現在のモード・現在のビュー(クリックで遷移メニュー)。
export class ViewBadge {
  private readonly modeEl: HTMLElement;
  private readonly viewButton: HTMLButtonElement;
  // ContextMenu は target !== null であることを onSelect 発火の条件にしているので、
  // 対象を持たないこのメニューでも null 以外のダミー値を渡す。
  private readonly menu = new ContextMenu<true, ViewId>();
  private canToggleView = false;

  constructor(
    root: HTMLElement,
    private readonly mapModeToggler: MapModeToggler,
    private readonly dockView: DockView,
  ) {
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

    this.menu.onSelect = (view) => this.selectView(view);
  }

  private currentView(): ViewId {
    if (this.dockView.visible) return 'dock';
    return this.mapModeToggler.mapMode ? 'map' : 'combat';
  }

  // モード名とビューボタンの表示を反映する。canToggleView は Combat/Map 間を遷移できるか
  // ([M] キーと同じ判定 — activeStage.isPlaying && 操作艦が生存)。
  sync(modeLabel: string, canToggleView: boolean): void {
    this.modeEl.textContent = `Mode: ${titleCase(modeLabel)}`;
    this.viewButton.textContent = `View: ${VIEW_LABELS[this.currentView()]} ▾`;
    this.canToggleView = canToggleView;
  }

  private openMenu(): void {
    if (!this.canToggleView) return;
    const current = this.currentView();
    const items: MenuItem<ViewId>[] = (['combat', 'map'] as const)
      .filter((v) => v !== current)
      .map((v) => ({ label: VIEW_LABELS[v], act: v }));
    const rect = this.viewButton.getBoundingClientRect();
    this.menu.open(rect.right, rect.bottom, true, items);
  }

  private selectView(view: ViewId): void {
    if (view === 'map') this.mapModeToggler.ensureOpen();
    else this.mapModeToggler.forceClose();
  }
}
