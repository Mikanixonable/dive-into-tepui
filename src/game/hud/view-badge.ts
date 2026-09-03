import type { ViewManager } from '../view/view-manager';
import type { View } from '../view/view';
import { ContextMenu, MenuItem } from './windows/context-menu';
import type { OverlayManager } from '../../hud/overlay-manager';
import { Button, ToggleSwitch } from '../../hud/widgets';
import type { RenderStyleSetting } from '../../render/render-style';
import { frameRoleOf } from '../../physics/frame';
import { frameRoleName } from './frame/frame-labels';
import { focusTargetId, type FocusTarget } from '../camera/focus-target';
import type { Controllable } from '../dynamic/dynamic-entity/controllable';
import type { DynamicSystem } from '../dynamic/dynamic-system';
import type { CelestialSystem } from '../celestial/celestial-system';

const GAME_TITLE = 'Dive into Tepui';
const GAME_VERSION = `v${__APP_VERSION__}`;

const VIEW_LABELS: Record<View, string> = { combat: 'Combat', map: 'Map' };

// 対象が定まっていない欄の表示。
const NO_VALUE = '—';

// 語ごとの先頭だけ大文字化する。selectLabel が 'CREATIVE' / 'stage 1' のように
// 大小文字混じりで来るので、表示用に体裁だけ揃える。
function titleCase(s: string): string {
  return s.replace(/\S+/g, (w) => (w[0] ?? '').toUpperCase() + w.slice(1).toLowerCase());
}

// 「· Focus: 月」の1欄を container の末尾へ組み、値側の要素を返す。
function appendField(container: HTMLElement, label: string): HTMLElement {
  const separator = document.createElement('span');
  separator.className = 'vb-sep';
  separator.setAttribute('aria-hidden', 'true');
  separator.textContent = '·';
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

function setFieldValue(el: HTMLElement, value: string | null): void {
  const text = value ?? NO_VALUE;
  if (el.textContent !== text) el.textContent = text;
}

// トップバー1行目のバッジ: ゲームタイトル・現在のモード・現在のビュー(クリックで遷移メニュー)・
// 画面全体の見せ方(写実/模式図)を切り替えるトグル・注視/操作/ターゲットの対象名。
export class ViewBadge {
  private readonly el: HTMLElement;
  private readonly modeEl: HTMLElement;
  private readonly viewButton: Button;
  private readonly styleToggle: ToggleSwitch;
  private readonly focusEl: HTMLElement;
  private readonly controlEl: HTMLElement;
  private readonly targetEl: HTMLElement;
  // ビュー遷移メニューは特定の対象を持たないので、target には固定で true を使う。
  private readonly menu: ContextMenu<true, View>;
  private readonly stopPointerDown = (e: Event): void => e.stopPropagation();
  private readonly unsubscribeRenderStyle: () => void;

  // container(トップバー1行目の行)へバッジの中身を、遷移メニューを popupLayer へ組み立てて配線する。
  // dynamicSystem と celestialSystem は注視対象の表示名を引くために持つ。
  public constructor(
    container: HTMLElement, popupLayer: HTMLElement, private readonly viewManager: ViewManager,
    overlayManager: OverlayManager, renderStyle: RenderStyleSetting,
    private readonly dynamicSystem: DynamicSystem, private readonly celestialSystem: CelestialSystem,
  ) {
    this.menu = new ContextMenu<true, View>(popupLayer, overlayManager);
    // タイトル・モード名・ビュー切替ボタンと、現在の対象の欄を横に並べる。
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

    this.styleToggle = new ToggleSwitch(
      '模式図', (on) => renderStyle.set(on ? 'schematic' : 'realistic'),
    );
    this.styleToggle.element.classList.add('vb-style-toggle');

    container.append(title, this.modeEl, this.viewButton.element, this.styleToggle.element);
    this.focusEl = appendField(container, 'Focus');
    this.controlEl = appendField(container, 'Control');
    this.targetEl = appendField(container, 'Target');
    this.el = container;

    this.menu.onSelect = (act) => { this.viewManager.setView(act); };
    this.menu.onClose = () => this.viewButton.element.setAttribute('aria-expanded', 'false');
    this.unsubscribeRenderStyle = renderStyle.subscribe((style) => this.styleToggle.setOn(style === 'schematic'));
  }

  // 遷移メニューを片付け、container へ足した中身を取り除く。
  public dispose(): void {
    this.menu.dispose();
    this.unsubscribeRenderStyle();
    this.el.removeEventListener('pointerdown', this.stopPointerDown);
    this.el.replaceChildren();
  }

  // モード名・ビューボタンと、注視対象・操作対象・ターゲットの名前を反映する。
  public sync(
    modeLabel: string, focus: FocusTarget, control: Controllable | null, targetName: string | null,
  ): void {
    this.modeEl.textContent = `Mode: ${titleCase(modeLabel)}`;
    this.viewButton.setLabel(`View: ${VIEW_LABELS[this.viewManager.current]} ▾`);
    setFieldValue(this.focusEl, this.focusName(focus));
    setFieldValue(this.controlEl, control?.name ?? null);
    setFieldValue(this.targetEl, targetName);
  }

  // 注視対象は天体・エンティティだけでなく、アプシス/交点などの一時マーカーも指しうる。
  // まず現在の ObjectPickable と実体を引き、最後に天体名(未登録なら id)を出すことで、
  // マップ候補が更新されていない戦闘ビューや一時的に非表示の対象でも空欄にしない。
  private focusName(focus: FocusTarget): string {
    const id = focusTargetId(focus);
    if (id === undefined) return '固定点';
    const role = frameRoleOf(id);
    if (role !== null) return frameRoleName(role);
    const pickable = this.viewManager.activeView.pickables.find((item) => item.id === id);
    if (pickable) return pickable.name;
    const entity = this.dynamicSystem.all().find((item) => item.id === id);
    if (entity) return entity.name;
    return this.celestialSystem.nameOf(id);
  }

  // 遷移できるビューが1つも無ければメニュー自体を開かない。
  private openMenu(): void {
    const items: MenuItem<View>[] = this.viewManager.selectableViews()
      .map((v) => ({ label: VIEW_LABELS[v], act: v }));
    if (items.length === 0) return;
    const rect = this.viewButton.element.getBoundingClientRect();
    this.viewButton.element.setAttribute('aria-expanded', 'true');
    this.menu.open(rect.right, rect.bottom, true, items);
  }
}
