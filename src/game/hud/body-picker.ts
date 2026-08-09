// 候補が数十〜百件になる値を選ばせるボタン。SegmentedControl は候補を横並びに積むだけなので、
// 登録天体ぶんの候補を並べると1行に収まらない。現在の選択を出すボタンを押すとポップアップが
// 開き、上から「よく使う候補」「絞り込み入力」「グループ分けした全候補」の順に並ぶ —
// 実際に選ばれるのはほぼ常に「いま見ているもの」か「いまいるところ」なので、それを1クリック目に置く。
import { ACCENT, ACCENT_RGB, ACCENT_SOFT, EDGE, FONT, SURFACE, TEXT as INK } from '../theme';
import { clampOverlayPosition } from './layout';
import { hudButton } from './buttons';

const STYLE = `
#hud .body-picker-pop {
  position: fixed; display: none; z-index: 12; pointer-events: auto;
  background: ${SURFACE}; border: 1px solid ${EDGE}; border-radius: 4px;
  font-family: ${FONT}; font-size: 12px; color: ${INK};
  width: 240px; max-height: 60vh; overflow-y: auto; user-select: none;
  -webkit-user-select: none;
}
#hud .body-picker-pop .bp-filter {
  width: 100%; box-sizing: border-box; padding: 7px 10px; margin: 0;
  background: rgba(0, 0, 0, 0.35); border: none; border-bottom: 1px solid ${EDGE};
  color: ${INK}; font-family: ${FONT}; font-size: 12px; outline: none;
}
#hud .body-picker-pop .bp-group {
  padding: 5px 10px 3px; font-size: 10px; letter-spacing: 1px; opacity: 0.55;
}
#hud .body-picker-pop .bp-row {
  padding: 7px 10px 7px 18px; cursor: pointer; border-bottom: 1px solid ${EDGE};
}
#hud .body-picker-pop .bp-row:last-child { border-bottom: none; }
#hud .body-picker-pop .bp-row:hover { background: rgba(${ACCENT_RGB}, 0.18); color: ${ACCENT_SOFT}; }
#hud .body-picker-pop .bp-row.on { color: ${ACCENT}; }
#hud .body-picker-pop .bp-empty { padding: 9px 10px; opacity: 0.5; }
`;

let styleInjected = false;
// ポップアップのスタイルシートを document.head へ一度だけ挿入する。
function ensureStyle(): void {
  if (styleInjected) return;
  styleInjected = true;
  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.appendChild(style);
}

// 見出しつきの候補のまとまり。label が空の group は見出しを出さない。
export type BodyPickerGroup<T> = {
  readonly label: string;
  readonly items: readonly (readonly [T, string])[];
};

export class BodyPicker<T> {
  readonly element: HTMLElement;
  private readonly trigger: HTMLElement;
  private readonly pop: HTMLElement;
  private readonly filter: HTMLInputElement;
  private readonly list: HTMLElement;
  private groups: readonly BodyPickerGroup<T>[] = [];
  private selected: T | null = null;
  private readonly onSelect: (value: T) => void;

  // title は見出し、root はポップアップの親(#hud の下に置くことで dom.ts の z-index 帯に乗る)。
  constructor(root: HTMLElement, title: string, onSelect: (value: T) => void) {
    ensureStyle();
    this.onSelect = onSelect;

    this.element = document.createElement('div');
    this.element.className = 'hud-seg';
    const heading = document.createElement('span');
    heading.className = 'seg-title';
    heading.textContent = title;
    this.element.appendChild(heading);
    this.trigger = hudButton('—', () => this.toggle());
    this.element.appendChild(this.trigger);

    this.pop = document.createElement('div');
    this.pop.className = 'body-picker-pop';
    this.pop.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.filter = document.createElement('input');
    this.filter.className = 'bp-filter';
    this.filter.placeholder = '絞り込み';
    this.filter.addEventListener('input', () => this.renderList());
    this.filter.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') this.close();
    });
    this.pop.appendChild(this.filter);
    this.list = document.createElement('div');
    this.pop.appendChild(this.list);
    root.appendChild(this.pop);

    // 途中の要素が stopPropagation していても届くよう、キャプチャ段階で外側クリックを拾う。
    document.addEventListener('pointerdown', (e) => {
      if (e.target instanceof Node && (this.pop.contains(e.target) || this.element.contains(e.target))) return;
      this.close();
    }, true);
  }

  // 候補を差し替える。開いている間に呼ばれても、入力中の絞り込みは保つ。
  setGroups(groups: readonly BodyPickerGroup<T>[]): void {
    this.groups = groups;
    if (this.pop.style.display === 'block') this.renderList();
    this.syncTriggerLabel();
  }

  // 選択中の値を反映する(候補に無い値ならボタンには id をそのまま出す)。
  setSelected(value: T): void {
    this.selected = value;
    this.syncTriggerLabel();
  }

  // ボタンの表示を現在の選択のラベルに合わせる。
  private syncTriggerLabel(): void {
    let label: string | null = null;
    for (const g of this.groups) {
      for (const [v, l] of g.items) if (v === this.selected) label = l;
    }
    this.trigger.textContent = `${label ?? String(this.selected ?? '—')} ▾`;
  }

  private toggle(): void {
    if (this.pop.style.display === 'block') this.close();
    else this.open();
  }

  // ポップアップをボタンの直下に開く。絞り込み入力は毎回空に戻す。
  private open(): void {
    this.filter.value = '';
    this.renderList();
    this.pop.style.display = 'block';
    const anchor = this.trigger.getBoundingClientRect();
    const rect = this.pop.getBoundingClientRect();
    const pos = clampOverlayPosition(
      { x: anchor.left, y: anchor.bottom + 2 }, rect,
      { width: window.innerWidth, height: window.innerHeight }, 6,
    );
    this.pop.style.left = `${pos.x}px`;
    this.pop.style.top = `${pos.y}px`;
    this.filter.focus();
  }

  close(): void {
    this.pop.style.display = 'none';
  }

  // 絞り込み文字列に一致する候補だけを、グループ見出しつきで並べ直す。
  private renderList(): void {
    const needle = this.filter.value.trim().toLowerCase();
    this.list.innerHTML = '';
    let shown = 0;
    for (const group of this.groups) {
      const items = needle === ''
        ? group.items
        : group.items.filter(([, label]) => label.toLowerCase().includes(needle));
      if (items.length === 0) continue;
      if (group.label !== '') {
        const head = document.createElement('div');
        head.className = 'bp-group';
        head.textContent = group.label;
        this.list.appendChild(head);
      }
      for (const [value, label] of items) {
        const row = document.createElement('div');
        row.className = 'bp-row';
        row.textContent = label;
        row.classList.toggle('on', value === this.selected);
        row.addEventListener('click', (e) => {
          e.stopPropagation();
          this.close();
          this.onSelect(value);
        });
        this.list.appendChild(row);
        shown++;
      }
    }
    if (shown === 0) {
      const empty = document.createElement('div');
      empty.className = 'bp-empty';
      empty.textContent = '該当なし';
      this.list.appendChild(empty);
    }
  }
}
