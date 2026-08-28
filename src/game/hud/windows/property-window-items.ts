// プロパティウィンドウの操作項目一覧。項目の集合・ラベル・ショートカットが変わったときだけ
// DOM を組み直し、選択されたら onSelect へ通知する。項目ショートカット文字列とキー入力の一致
// 判定(dispatchShortcut)も併せて持つ。
import { shortcutKeyLabel } from './shortcut-hint';
import type { PropertyWindowItem } from './property-window';

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
  // ウィンドウでは可変な状態(操作対象か等)に応じて呼び出し側から毎フレーム渡されうる。
  public sync(items: readonly PropertyWindowItem<A>[]): void {
    const key = items.map((it) => `${it.act} ${it.label} ${it.shortcut ?? ''} ${it.selected ?? ''} ${it.keepOpen ?? ''}`).join('|');
    if (key === this.lastItemsKey) return;
    this.lastItemsKey = key;
    this.element.innerHTML = '';
    for (const it of items) {
      const row = document.createElement('div');
      row.className = 'prop-window-item';
      row.setAttribute('role', 'button');
      row.tabIndex = 0;
      row.classList.toggle('on', it.selected === true);
      row.textContent = it.label + (it.shortcut ? ` [${shortcutKeyLabel(it.shortcut)}]` : '');
      row.dataset['act'] = it.act;
      row.dataset['shortcut'] = it.shortcut ?? '';
      row.dataset['keepOpen'] = it.keepOpen === true ? '1' : '';
      row.addEventListener('click', (e) => {
        // 外側 pointerdown 検出のキャプチャリスナへ伝播しないようにする。
        e.stopPropagation();
        this.onSelect?.(it.act, it.keepOpen === true);
      });
      row.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        row.click();
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
      this.onSelect?.(item.dataset['act'] as A, item.dataset['keepOpen'] === '1');
      return true;
    }
    return false;
  }
}
