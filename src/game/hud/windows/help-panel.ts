// [H] と常設の起動ボタンで開閉する操作説明のモーダル。章ごとに、タッチ・マウスの操作とキーボードの操作を
// この順に並べる。
import { KEY_MAPPING as K } from '../../../input/key-mapping';
import { injectOnce } from '../../../hud/inject-style';
import { createKeyCap } from '../../../hud/key-cap';
import { injectCommonUiStyle } from '../../../hud/style/common-ui-style';
import { CloseButton } from '../../../hud/widgets/close-button';
import { TabBar } from '../../../hud/widgets/tab-bar';
import { stopDragPropagation } from '../../../hud/widgets/widget-base';
import { HELP_PANEL_STYLE } from '../style/help-panel-style';
import { helpRowGroups, type HelpCategory, type HelpRow, type HelpTextPart } from './help-content';
import { SYSTEM_MODAL_GROUP } from '../../../hud/overlay-manager';
import type { OverlayHandle, OverlayManager } from '../../../hud/overlay-manager';

const HELP_TABS: readonly (readonly [HelpCategory, string])[] = [
  ['flight', '飛行'],
  ['camera', '視点'],
  ['combat', '戦闘'],
  ['map', 'マップ'],
  ['system', 'システム'],
];

// 入力の表記の区切り「または」。
const INPUT_OR = '/';

// 説明文の断片を、文字列はそのまま・キーはキーキャップとして parent へ並べる。
function appendTextParts(parent: HTMLElement, parts: readonly HelpTextPart[]): void {
  for (const part of parts) {
    parent.append(typeof part === 'string' ? document.createTextNode(part) : createKeyCap(part.key));
  }
}

// 対応表の1行を組む。入力欄はジェスチャなら丸い札、キーならキーキャップ。
function buildReferenceRow(row: HelpRow): HTMLElement {
  const item = document.createElement('div');
  item.className = 'help-reference-row';
  // 入力欄: ジェスチャは丸い札を「または」で区切って並べ、キーはキーキャップを並べる。
  const input = document.createElement('div');
  input.className = 'help-reference-input';
  if (row.input.kind === 'gesture') {
    row.input.chips.forEach((chip, index) => {
      if (index > 0) {
        const or = document.createElement('span');
        or.className = 'help-or';
        or.textContent = INPUT_OR;
        input.appendChild(or);
      }
      const chipEl = document.createElement('span');
      chipEl.className = 'ui-chip';
      chipEl.textContent = chip;
      input.appendChild(chipEl);
    });
  } else {
    for (const key of row.input.keys) input.appendChild(createKeyCap(key));
  }
  const command = document.createElement('div');
  command.className = 'help-reference-command';
  const label = document.createElement('strong');
  label.textContent = row.label;
  const description = document.createElement('p');
  appendTextParts(description, row.description);
  command.append(label, description);
  item.append(input, command);
  return item;
}

// OverlayManager の台帳上の id。開いているかどうかは登録の有無が正本。
const OVERLAY_ID = 'help';

export class HelpPanel implements OverlayHandle {
  private readonly el: HTMLElement;
  private readonly tabs: TabBar<HelpCategory>;
  private readonly sections = new Map<HelpCategory, HTMLElement>();
  private readonly contextEl: HTMLElement;

  // 操作説明の DOM を組み立てる。要素は開くまで DOM へ挿さず、overlayManager が modal の層へ置く。
  // 閉じた状態で始まる。
  public constructor(private readonly overlayManager: OverlayManager) {
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
    const title = document.createElement('h3');
    title.id = 'hud-help-title';
    title.textContent = '操作';
    this.contextEl = document.createElement('span');
    this.contextEl.className = 'help-context ui-pip on';
    header.append(title, this.contextEl, new CloseButton(() => this.close()).element);
    this.el.appendChild(header);

    this.tabs = new TabBar<HelpCategory>(HELP_TABS, (category) => this.setCategory(category));
    this.tabs.element.classList.add('help-tabs', 'w-tabs--neutral', 'is-dense');
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
      const { gestures, keys } = helpRowGroups(category);
      // 片方の群しか持たない章は、小見出しで区切らない。
      const heading = gestures.length > 0 && keys.length > 0;
      for (const [groupLabel, rows] of [['タッチ・マウス', gestures], ['キーボード', keys]] as const) {
        if (rows.length === 0) continue;
        if (heading) {
          const sub = document.createElement('div');
          sub.className = 'ui-sub';
          sub.textContent = groupLabel;
          list.appendChild(sub);
        }
        for (const row of rows) list.appendChild(buildReferenceRow(row));
      }
      section.appendChild(list);
      body.appendChild(section);
      this.sections.set(category, section);
    }
    this.el.appendChild(body);
    this.setCategory('flight');
    stopDragPropagation(this.el);
  }

  // 開いているかどうか。台帳への登録の有無が正本。
  public get isOpen(): boolean { return this.overlayManager.isOverlayOpen(OVERLAY_ID); }

  // 章を切り替え、その章の節だけを表示する。
  private setCategory(category: HelpCategory): void {
    this.tabs.setSelected(category);
    for (const [candidate, section] of this.sections) section.hidden = candidate !== category;
  }

  // router から [H] の単発入力を受け取って開閉を切り替える。
  public handleCommand(commandId: string): void {
    if (commandId !== K.help.code) return;
    if (this.isOpen) this.close();
    else this.open();
  }

  // パネルを開く。既に開いていれば何もしない。
  public open(): void {
    if (this.isOpen) return;
    const workspace = document.getElementById('hud')?.dataset['workspace'];
    const category: HelpCategory = workspace === 'map' ? 'map' : 'flight';
    const workspaceName = workspace === 'map' ? 'マップ' : workspace === 'construction' ? '建造' : '飛行';
    this.contextEl.textContent = `いま ${workspaceName}`;
    for (const [candidate] of HELP_TABS) {
      this.tabs.buttonFor(candidate)?.classList.toggle('is-here', candidate === category);
    }
    this.setCategory(category);
    this.el.style.display = 'flex';
    // 系のモーダル(ヘルプ・一時停止など)は同じ排他グループに属し、同時に1つしか開かない。
    this.overlayManager.open(OVERLAY_ID, this.el, this, {
      kind: 'modal', closeOnEscape: true, closeOnOutsideClick: false, gatesInput: true, exclusiveGroup: SYSTEM_MODAL_GROUP,
    });
  }

  // パネルを閉じる。既に閉じていれば何もしない。
  public close(): void {
    if (!this.isOpen) return;
    this.el.style.display = 'none';
    this.overlayManager.close(OVERLAY_ID);
  }

  // 指定したノードがこのパネルの DOM 内にあるかを判定する。
  public contains(target: Node): boolean {
    return this.el.contains(target);
  }
}
