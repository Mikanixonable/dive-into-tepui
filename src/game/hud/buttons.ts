// HUD パネル共通のボタン部品。値を排他選択する SegmentedControl と、単発実行の hudButton。
// 見た目(.hud-seg / .seg-btn)は hud/dom.ts の STYLE に一元管理されている。
// context-menu.ts と同じく DOM とイベント処理だけを担い、押された値の意味づけは所有するパネルが行う。

// 単発の実行ボタン。キャンバス側のドラッグ操作へ pointerdown が抜けるのを止める。
export function hudButton(label: string, onClick: () => void): HTMLElement {
  const btn = document.createElement('span');
  btn.className = 'seg-btn';
  btn.textContent = label;
  btn.addEventListener('pointerdown', (e) => e.stopPropagation());
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return btn;
}

// 見出し + 排他選択のボタン列。
export class SegmentedControl<T extends string> {
  readonly element: HTMLElement;
  private readonly buttons = new Map<T, HTMLElement>();

  // items は [値, 表示ラベル] の並びで、その順にボタンを並べる。
  constructor(title: string, items: readonly (readonly [T, string])[], onSelect: (value: T) => void) {
    this.element = document.createElement('div');
    this.element.className = 'hud-seg';
    const heading = document.createElement('span');
    heading.className = 'seg-title';
    heading.textContent = title;
    this.element.appendChild(heading);
    for (const [value, label] of items) {
      const btn = hudButton(label, () => onSelect(value));
      this.element.appendChild(btn);
      this.buttons.set(value, btn);
    }
  }

  // 選択中の値を点灯させる。候補外の値(ラベルメニューから選んだフォーカスなど)では全消灯になる。
  setSelected(value: T): void {
    for (const [v, btn] of this.buttons) btn.classList.toggle('on', v === value);
  }
}
