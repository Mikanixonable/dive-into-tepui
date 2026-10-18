// プロパティウィンドウの操作。2値の設定はトグルスイッチの行、そのほかはキー付きのボタンの列で並べ、
// 選ばれたら onSelect へ通知する。項目ショートカットとキー入力の一致判定(dispatchShortcut)も持つ。
import { shortcutKeyLabel } from './shortcut-hint';
import { Button, ToggleSwitch } from '../widgets';
import type { PropertyWindowItem, PropertyWindowToggle } from './property-window-content';

export class PropertyWindowItems<A extends string = string> {
  public readonly element: HTMLDivElement;
  private readonly togglesEl: HTMLDivElement;
  private readonly actionsEl: HTMLDivElement;
  // 前回描画したボタン・トグルの構成の直列化。同じなら DOM を組み直さない。
  private lastItemsKey = '';
  private lastTogglesKey = '';
  private readonly toggleSwitches = new Map<A, ToggleSwitch>();
  // 直近の sync で受けた項目。ショートカット配送はここを走査する。
  private items: readonly PropertyWindowItem<A>[] = [];
  // 項目クリックまたは一致したショートカットのたびに呼ばれる。keepOpen は選択された項目自身の
  // PropertyWindowItem.keepOpen の値。トグルは常に true で呼ぶ。
  public onSelect: ((act: A, keepOpen: boolean) => void) | null = null;

  // 操作を差し込む要素を用意する。中身は sync / syncToggles が呼ばれるまで空。
  public constructor() {
    this.element = document.createElement('div');
    this.element.className = 'prop-window-items';
    this.togglesEl = document.createElement('div');
    this.togglesEl.className = 'prop-window-toggles';
    this.actionsEl = document.createElement('div');
    this.actionsEl.className = 'ui-actions prop-window-actions';
    this.element.append(this.togglesEl, this.actionsEl);
  }

  // ボタンの集合・ラベル・ショートカットが変わったときだけ DOM を組み直す。クリップ済み
  // ウィンドウでは操作対象の状態に応じて毎フレーム内容が更新されることがある。
  public sync(items: readonly PropertyWindowItem<A>[]): void {
    this.items = items;
    // 描画に効く項目だけを直列化して比べる。
    const key = items.map((it) => `${it.act} ${it.label} ${it.shortcut ?? ''} ${it.tone ?? ''} ${it.disabled ?? ''} ${it.keepOpen ?? ''}`).join('|');
    if (key === this.lastItemsKey) return;
    this.lastItemsKey = key;
    this.actionsEl.replaceChildren();
    for (const it of items) {
      const keyLabel = it.shortcut === undefined ? undefined : shortcutKeyLabel(it.shortcut);
      const button = new Button(it.label, () => this.onSelect?.(it.act, it.keepOpen === true), undefined, it.tone, keyLabel);
      button.element.classList.add('prop-window-item');
      button.setEnabled(it.disabled !== true);
      this.actionsEl.appendChild(button.element);
    }
  }

  // トグルの集合・ラベルが変わったときだけ DOM を組み直し、そうでなければ ON/OFF の表示だけを合わせる。
  public syncToggles(toggles: readonly PropertyWindowToggle<A>[]): void {
    // 構成が同じなら、押しかけのスイッチを作り直さず表示だけ合わせる。
    const key = toggles.map((t) => `${t.act} ${t.label}`).join('|');
    if (key !== this.lastTogglesKey) {
      this.lastTogglesKey = key;
      this.togglesEl.replaceChildren();
      this.toggleSwitches.clear();
      for (const toggle of toggles) {
        const switchEl = new ToggleSwitch(toggle.label, () => this.onSelect?.(toggle.act, true));
        switchEl.element.classList.add('prop-window-toggle');
        this.toggleSwitches.set(toggle.act, switchEl);
        this.togglesEl.appendChild(switchEl.element);
      }
    }
    for (const toggle of toggles) this.toggleSwitches.get(toggle.act)?.setOn(toggle.on);
  }

  // code に一致するショートカットを持つ項目を選択されたものとして扱う。一致した項目があれば
  // onSelect を呼んで true を返す。disabled の項目に一致したときは発火せずに消費だけする。
  public dispatchShortcut(code: string): boolean {
    for (const it of this.items) {
      if (it.shortcut !== code) continue;
      if (it.disabled === true) return true;
      this.onSelect?.(it.act, it.keepOpen === true);
      return true;
    }
    return false;
  }
}
