// プロパティウィンドウの操作項目一覧。項目の集合・ラベル・ショートカットが変わったときだけ
// DOM を組み直し、選択されたら onSelect へ通知する。項目ショートカット文字列とキー入力の一致
// 判定(dispatchShortcut)も併せて持つ。
import { shortcutKeyLabel } from './shortcut-hint';
import { bindActivation, expandHitTarget, stopDragPropagation } from '../widgets/widget-base';
import type { PropertyWindowItem } from './property-window-content';

export class PropertyWindowItems<A extends string = string> {
  public readonly element: HTMLDivElement;
  // 前回描画した操作項目の直列化(act/label/shortcut)。同じなら DOM を組み直さない。
  private lastItemsKey = '';
  // 項目クリックまたは一致したショートカットのたびに呼ばれる。keepOpen は選択された項目自身の
  // PropertyWindowItem.keepOpen の値。
  public onSelect: ((act: A, keepOpen: boolean) => void) | null = null;

  // 操作項目一覧を差し込む要素を用意する。中身は sync が呼ばれるまで空。
  public constructor() {
    this.element = document.createElement('div');
    this.element.className = 'prop-window-items';
  }

  // 操作項目の集合・ラベル・ショートカットが変わったときだけ DOM を組み直す。クリップ済み
  // ウィンドウでは操作対象の状態に応じて毎フレーム内容が更新されることがある。
  public sync(items: readonly PropertyWindowItem<A>[]): void {
    const key = items.map((it) => `${it.act} ${it.label} ${it.shortcut ?? ''} ${it.selected ?? ''} ${it.disabled ?? ''} ${it.keepOpen ?? ''}`).join('|');
    if (key === this.lastItemsKey) return;
    this.lastItemsKey = key;
    this.element.innerHTML = '';
    let index = 1;
    for (const it of items) {
      const row = document.createElement('div');
      row.className = 'prop-window-item ui-selectable editorial-index-row';
      row.dataset['index'] = String(index++).padStart(2, '0');
      row.setAttribute('role', 'button');
      row.tabIndex = 0;
      row.classList.toggle('on', it.selected === true);
      row.classList.toggle('is-active', it.selected === true);
      row.classList.toggle('disabled', it.disabled === true);
      row.setAttribute('aria-disabled', String(it.disabled === true));
      const label = document.createElement('span');
      label.className = 'w-hit prop-window-item-label';
      label.textContent = it.label;
      expandHitTarget(label);
      row.appendChild(label);
      if (it.shortcut) {
        const shortcut = document.createElement('span');
        shortcut.className = 'prop-window-item-shortcut editorial-index-status';
        shortcut.textContent = shortcutKeyLabel(it.shortcut);
        row.appendChild(shortcut);
      }
      row.dataset['act'] = it.act;
      row.dataset['shortcut'] = it.shortcut ?? '';
      row.dataset['keepOpen'] = it.keepOpen === true ? '1' : '';
      row.dataset['disabled'] = it.disabled === true ? '1' : '';
      stopDragPropagation(row);
      bindActivation(row, () => {
        if (it.disabled === true) return;
        this.onSelect?.(it.act, it.keepOpen === true);
      });
      this.element.appendChild(row);
    }
  }

  // code に一致するショートカットを持つ項目を選択されたものとして扱う。一致した項目があれば
  // onSelect を呼んで true を返す。
  public dispatchShortcut(code: string): boolean {
    const items = this.element.querySelectorAll<HTMLElement>('.prop-window-item');
    for (const item of Array.from(items)) {
      if (item.dataset['shortcut'] !== code) continue;
      if (item.dataset['disabled'] === '1') return true;
      this.onSelect?.(item.dataset['act'] as A, item.dataset['keepOpen'] === '1');
      return true;
    }
    return false;
  }
}
