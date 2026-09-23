// [H] と常設の起動ボタンで開閉する操作説明のモーダル。章ごとの2列Reference Listとして出す。
import { KEY_MAPPING as K } from '../../../input/key-mapping';
import { injectOnce } from '../../../hud/inject-style';
import { injectCommonUiStyle } from '../../../hud/style/common-ui-style';
import { CloseButton } from '../../../hud/widgets/close-button';
import { TabBar } from '../../../hud/widgets/tab-bar';
import { stopDragPropagation } from '../../../hud/widgets/widget-base';
import { HELP_PANEL_STYLE } from '../style/help-panel-style';
import { helpRows, type HelpRow } from './help-content';
import type { OverlayHandle, OverlayManager } from '../../../hud/overlay-manager';

type HelpCategory = 'flight' | 'camera' | 'combat' | 'map' | 'system';

const HELP_TABS: readonly (readonly [HelpCategory, string])[] = [
  ['flight', 'FLIGHT'],
  ['camera', 'CAMERA'],
  ['combat', 'COMBAT'],
  ['map', 'MAP & ORBIT'],
  ['system', 'SYSTEM'],
];

function helpCategory(row: HelpRow): HelpCategory {
  const label = row.label;
  if (label.includes('視点') || label.includes('フォーカス')) return 'camera';
  if (label.includes('ターゲット') || label.includes('照準') || label.includes('機関砲') || label.includes('装填')) return 'combat';
  if (label.includes('ノード') || label.includes('時間加速') || label.includes('ビュー切替')
    || label.includes('プロパティ・メニュー')) return 'map';
  if (label.includes('ヘルプ') || label.includes('ESC') || label.includes('デバッグ')
    || label.includes('セーブ') || label.includes('再出撃')) return 'system';
  return 'flight';
}

export class HelpPanel implements OverlayHandle {
  private readonly el: HTMLElement;
  private readonly tabs: TabBar<HelpCategory>;
  private readonly sections = new Map<HelpCategory, HTMLElement>();
  private readonly contextEl: HTMLElement;
  private _isOpen = false;

  // 操作説明の DOM を組み立てて root へ追加する。閉じた状態で始まる。
  public constructor(root: HTMLElement, private readonly overlayManager: OverlayManager) {
    injectCommonUiStyle();
    injectOnce('help-panel', HELP_PANEL_STYLE);
    this.el = document.createElement('div');
    this.el.id = 'hud-help';
    this.el.className = 'panel ui-surface-focus';
    this.el.setAttribute('role', 'dialog');
    this.el.setAttribute('aria-modal', 'true');
    this.el.setAttribute('aria-labelledby', 'hud-help-title');
    const header = document.createElement('div');
    header.className = 'help-header';
    header.innerHTML = `
      <div class="help-heading">
        <div><span class="ui-section-code" aria-hidden="true">HLP</span><span class="help-kicker">REFERENCE</span></div>
        <h3 id="hud-help-title">FLIGHT REFERENCE</h3>
        <div class="help-context ui-data-context">CURRENT CONTEXT · <span>FLIGHT</span></div>
      </div>`;
    header.appendChild(new CloseButton(() => this.close()).element);
    this.el.appendChild(header);
    this.contextEl = header.querySelector<HTMLElement>('.help-context > span')!;

    this.tabs = new TabBar<HelpCategory>(HELP_TABS, (category) => this.setCategory(category));
    this.tabs.element.classList.add('help-tabs');
    this.tabs.element.setAttribute('aria-label', 'ヘルプの章');
    this.el.appendChild(this.tabs.element);

    const body = document.createElement('div');
    body.className = 'help-body';
    for (const [category, label] of HELP_TABS) {
      const section = document.createElement('section');
      section.className = 'help-section';
      section.dataset['category'] = category;
      section.setAttribute('role', 'tabpanel');
      section.setAttribute('aria-label', label);
      const list = document.createElement('div');
      list.className = 'help-reference-list';
      section.appendChild(list);
      body.appendChild(section);
      this.sections.set(category, section);
    }

    for (const row of helpRows()) {
      const list = this.sections.get(helpCategory(row))?.querySelector<HTMLElement>('.help-reference-list');
      if (list === null || list === undefined) continue;
      const item = document.createElement('div');
      item.className = 'help-reference-row';
      const input = document.createElement('div');
      input.className = 'help-reference-input';
      const inputCode = document.createElement('span');
      inputCode.className = 'help-input-code';
      inputCode.textContent = row.input;
      input.appendChild(inputCode);
      const command = document.createElement('div');
      command.className = 'help-reference-command';
      const label = document.createElement('strong');
      label.textContent = row.label;
      const description = document.createElement('p');
      description.textContent = row.description;
      command.append(label, description);
      item.append(input, command);
      list.appendChild(item);
    }
    this.el.appendChild(body);
    this.setCategory('flight');
    root.appendChild(this.el);
    stopDragPropagation(this.el);
  }

  public get isOpen(): boolean { return this._isOpen; }

  private setCategory(category: HelpCategory): void {
    this.tabs.setSelected(category);
    for (const [candidate, section] of this.sections) section.hidden = candidate !== category;
    const label = HELP_TABS.find(([key]) => key === category)?.[1] ?? 'FLIGHT';
    const title = this.el.querySelector<HTMLElement>('#hud-help-title');
    if (title) title.textContent = `${label} REFERENCE`;
  }

  // router から [H] の単発入力を受け取って開閉を切り替える。
  public handleCommand(commandId: string): void {
    if (commandId !== K.help.code) return;
    if (this._isOpen) this.close();
    else this.open();
  }

  // パネルを開く。既に開いていれば何もしない。
  public open(): void {
    if (this._isOpen) return;
    this._isOpen = true;
    const workspace = document.getElementById('hud')?.dataset['workspace'];
    const category: HelpCategory = workspace === 'map' ? 'map' : 'flight';
    this.contextEl.textContent = workspace === 'map' ? 'MAP' : workspace === 'construction' ? 'BUILD' : 'FLIGHT';
    this.setCategory(category);
    this.el.style.display = 'flex';
    // 系のモーダル(ヘルプ・一時停止など)は同じ排他グループに属し、同時に1つしか開かない。
    this.overlayManager.open('help', this, {
      kind: 'modal', closeOnEscape: true, closeOnOutsideClick: false, gatesInput: true, exclusiveGroup: 'system-modal',
    });
  }

  // パネルを閉じる。既に閉じていれば何もしない。
  public close(): void {
    if (!this._isOpen) return;
    this._isOpen = false;
    this.el.style.display = 'none';
    this.overlayManager.close('help');
  }

  // 指定したノードがこのパネルの DOM 内にあるかを判定する。
  public contains(target: Node): boolean {
    return this.el.contains(target);
  }
}
