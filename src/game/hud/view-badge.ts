// 全体ステータスバーの先頭: ステージ名・ビュー切替バッジと、操作対象と違うときだけ出す注視対象の名前。
import type { ViewMode } from '../view/view-mode';
import type { ViewCommands } from '../viewer/view-commands';
import { ContextMenu, type MenuItem } from './windows/context-menu';
import type { OverlayManager } from '../../hud/overlay-manager';
import { Button } from '../../hud/widgets';

const VIEW_LABELS: Record<ViewMode, string> = { combat: 'Combat', map: 'Map' };

// 注視対象の名前の前に添える記号。
const FOCUS_GLYPH = '◎';

// ビューバッジが1フレームに映す値。
export interface ViewBadgeViewModel {
  readonly modeLabel: string;
  readonly view: ViewMode;
  // 遷移メニューに並べるビュー。いま入れるものだけが入る。
  readonly selectableViews: readonly ViewMode[];
  // 注視対象の名前。操作対象と同じなら null。
  readonly focusName: string | null;
}

export class ViewBadge {
  private readonly el: HTMLElement;
  private readonly modeEl: HTMLElement;
  private readonly viewButton: Button;
  private readonly focusEl: HTMLElement;
  // ビュー遷移メニューは特定の対象を持たないので、target には固定で true を使う。
  private readonly menu: ContextMenu<true, ViewMode>;
  private readonly stopPointerDown = (e: Event): void => e.stopPropagation();
  // 直近の sync が受けた値。遷移メニューはフレームの外で開くので、遷移先をここから引く。
  private view: ViewBadgeViewModel | null = null;

  // container(全体ステータスバーの先頭の欄)へステージ名・ビューボタン・注視対象の欄を組み立て、
  // 遷移メニューは overlayManager へ登録する。遷移メニューの選択は commands へ返す。
  public constructor(
    container: HTMLElement, overlayManager: OverlayManager,
    private readonly commands: Pick<ViewCommands, 'select'>,
  ) {
    this.menu = new ContextMenu<true, ViewMode>(overlayManager);
    container.setAttribute('role', 'navigation');
    container.setAttribute('aria-label', 'ビュー切り替え');
    container.addEventListener('pointerdown', this.stopPointerDown);

    this.modeEl = document.createElement('span');
    this.modeEl.className = 'vb-mode';
    this.viewButton = new Button('', () => this.openMenu(), undefined, 'dense');
    this.viewButton.element.classList.add('vb-view-btn');
    this.viewButton.element.setAttribute('aria-haspopup', 'menu');
    this.viewButton.element.setAttribute('aria-label', '表示するビューを選ぶ');
    this.viewButton.element.setAttribute('aria-expanded', 'false');
    this.focusEl = document.createElement('span');
    this.focusEl.className = 'vb-focus hidden';

    container.append(this.modeEl, this.viewButton.element, this.focusEl);
    this.el = container;

    this.menu.onSelect = (act) => { this.commands.select(act); };
    this.menu.onClose = () => this.viewButton.element.setAttribute('aria-expanded', 'false');
  }

  // 遷移メニューを片付け、container へ足した中身を取り除く。
  public dispose(): void {
    this.menu.dispose();
    this.el.removeEventListener('pointerdown', this.stopPointerDown);
    this.el.replaceChildren();
  }

  // ステージ名・ビューボタンと、注視対象の名前を反映する。
  public sync(view: ViewBadgeViewModel): void {
    this.view = view;
    const mode = view.modeLabel.toUpperCase();
    if (this.modeEl.textContent !== mode) this.modeEl.textContent = mode;
    this.viewButton.setLabel(`${VIEW_LABELS[view.view].toUpperCase()} ▾`);
    this.focusEl.classList.toggle('hidden', view.focusName === null);
    const focus = view.focusName === null ? '' : `${FOCUS_GLYPH} ${view.focusName}`;
    if (this.focusEl.textContent !== focus) this.focusEl.textContent = focus;
  }

  // ビュー遷移メニューをボタンの下に開く。遷移できるビューが無ければ開かない。
  private openMenu(): void {
    const items: MenuItem<ViewMode>[] = (this.view?.selectableViews ?? [])
      .map((v) => ({ label: VIEW_LABELS[v], act: v }));
    if (items.length === 0) return;
    const rect = this.viewButton.element.getBoundingClientRect();
    this.viewButton.element.setAttribute('aria-expanded', 'true');
    this.menu.open(rect.right, rect.bottom, true, items);
  }
}
