// トップバー1行目のバッジ: ゲームタイトル・現在のモード・現在のビュー(クリックで遷移メニュー)・
// 画面全体の見せ方(写実/模式図)を切り替えるトグル・注視/操作/ターゲットの対象名。
import type { ViewMode } from '../view/view-mode';
import type { ViewCommands } from '../viewer/view-commands';
import { ContextMenu, MenuItem } from './windows/context-menu';
import type { OverlayManager } from '../../hud/overlay-manager';
import { Button } from '../../hud/widgets';

const VIEW_LABELS: Record<ViewMode, string> = { combat: 'Combat', map: 'Map' };

// 対象が定まっていない欄の表示。
const NO_VALUE = '—';

// 語ごとに先頭を大文字、残りを小文字にする('CREATIVE' → 'Creative')。
function titleCase(s: string): string {
  return s.replace(/\S+/g, (w) => (w[0] ?? '').toUpperCase() + w.slice(1).toLowerCase());
}

// 「· Focus: 月」の1欄を container の末尾へ組み、値側の要素を返す。
function appendField(container: HTMLElement, label: string): HTMLElement {
  // 読み上げない区切りの「·」。
  const separator = document.createElement('span');
  separator.className = 'vb-sep';
  separator.setAttribute('aria-hidden', 'true');
  separator.textContent = '·';
  // 「ラベル: 値」の欄。値は未定の表示で始める。
  const field = document.createElement('span');
  field.className = 'vb-field';
  const key = document.createElement('span');
  key.textContent = `${label}:`;
  const value = document.createElement('span');
  value.textContent = NO_VALUE;
  field.append(key, value);
  container.append(separator, field);
  return value;
}

// 欄の値を書く。null なら未定の表示にする。
function setFieldValue(el: HTMLElement, value: string | null): void {
  const text = value ?? NO_VALUE;
  if (el.textContent !== text) el.textContent = text;
  el.parentElement?.classList.toggle('hidden', value === null);
}

// ビューバッジが1フレームに映す値。名前の欄は、対象が定まっていなければ null。
export interface ViewBadgeViewModel {
  readonly modeLabel: string;
  readonly view: ViewMode;
  // 遷移メニューに並べるビュー。いま入れるものだけが入る。
  readonly selectableViews: readonly ViewMode[];
  readonly focusName: string | null;
  readonly controlName: string | null;
  readonly targetName: string | null;
}

export class ViewBadge {
  private readonly el: HTMLElement;
  private readonly modeEl: HTMLElement;
  private readonly viewButton: Button;
  private readonly focusEl: HTMLElement;
  private readonly controlEl: HTMLElement;
  private readonly targetEl: HTMLElement;
  // ビュー遷移メニューは特定の対象を持たないので、target には固定で true を使う。
  private readonly menu: ContextMenu<true, ViewMode>;
  private readonly stopPointerDown = (e: Event): void => e.stopPropagation();
  // 直近の sync が受けた値。遷移メニューはフレームの外で開くので、遷移先をここから引く。
  private view: ViewBadgeViewModel | null = null;
  // container(トップバー1行目の行)へバッジの中身を、遷移メニューを popupLayer へ組み立てて配線する。
  // 遷移メニューの選択は commands へ返す。見せ方のトグルは sync で合わせる。
  public constructor(
    container: HTMLElement, popupLayer: HTMLElement, overlayManager: OverlayManager,
    private readonly commands: Pick<ViewCommands, 'select'>,
  ) {
    this.menu = new ContextMenu<true, ViewMode>(popupLayer, overlayManager);
    // タイトル・モード名・ビュー切替ボタンと、現在の対象の欄を横に並べる。
    container.setAttribute('role', 'navigation');
    container.setAttribute('aria-label', 'ビュー切り替え');
    container.addEventListener('pointerdown', this.stopPointerDown);

    this.modeEl = document.createElement('span');
    this.modeEl.className = 'vb-mode';
    this.viewButton = new Button('', () => this.openMenu());
    this.viewButton.element.classList.add('vb-view-btn');
    this.viewButton.element.setAttribute('aria-haspopup', 'menu');
    this.viewButton.element.setAttribute('aria-label', '表示するビューを選ぶ');
    this.viewButton.element.setAttribute('aria-expanded', 'false');

    container.append(this.modeEl, this.viewButton.element);
    this.focusEl = appendField(container, 'Focus');
    this.controlEl = appendField(container, 'Control');
    this.targetEl = appendField(container, 'Target');
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

  // モード名・ビューボタン・見せ方のトグルと、注視対象・操作対象・ターゲットの名前を反映する。
  public sync(view: ViewBadgeViewModel): void {
    this.view = view;
    this.modeEl.textContent = titleCase(view.modeLabel).toUpperCase();
    this.viewButton.setLabel(`${VIEW_LABELS[view.view].toUpperCase()} ▾`);
    setFieldValue(this.focusEl, view.focusName);
    setFieldValue(this.controlEl, view.controlName);
    setFieldValue(this.targetEl, view.targetName);
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