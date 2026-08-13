// 候補が数十〜百件になる値を選ばせるボタン。SegmentedControl は候補を横並びに積むだけなので、
// 登録天体ぶんの候補を並べると1行に収まらない。現在の選択を出すボタンを押すとポップアップが
// 開き、上から「絞り込み入力」「グループ分けした全候補」の順に並ぶ。候補はグループごとに
// 複数列のグリッドへ並べる(百件規模を縦一列に積むと画面高をはみ出すため)。
import { clampOverlayPosition } from './layout';
import { Button } from './widgets';
import { bringToFront } from './overlay-layer';
import type { OverlayHandle, OverlayManager } from './overlay-manager';

const STYLE = `
#hud .object-picker-pop {
  position: fixed; display: none; pointer-events: auto;
  background: var(--surface); border: 1px solid var(--edge); border-radius: var(--radius-m);
  font-family: var(--font-family); font-size: var(--font-m); color: var(--text);
  width: min(520px, calc(100vw - 24px)); max-height: 60vh; max-height: 60dvh; overflow-y: auto; user-select: none;
  -webkit-user-select: none;
}
#hud .object-picker-pop .op-filter {
  width: 100%; box-sizing: border-box; padding: var(--space-3) var(--space-5); margin: 0;
  background: var(--shade-1); border: none; border-bottom: 1px solid var(--edge);
  color: var(--text); font-family: var(--font-family); font-size: var(--font-m); outline: none;
}
#hud .object-picker-pop .op-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
}
#hud .object-picker-pop .op-group {
  grid-column: 1 / -1; padding: var(--space-3) var(--space-5) var(--space-2); font-size: var(--font-xs); letter-spacing: 1px; opacity: 0.55;
}
#hud .object-picker-pop .op-row {
  padding: var(--space-3) var(--space-5) var(--space-3) 18px; cursor: pointer; border-left: 1px solid var(--edge);
}
#hud .object-picker-pop .op-row:hover { background: var(--accent-fill); color: var(--accent-soft); }
#hud .object-picker-pop .op-row.on { color: var(--accent); }
#hud .object-picker-pop .op-empty { grid-column: 1 / -1; padding: var(--space-4) var(--space-5); opacity: 0.5; }
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
export type ObjectPickerGroup<T> = {
  readonly label: string;
  readonly items: readonly (readonly [T, string])[];
};

// groups が現在の内容と同じかどうかを、ラベルと各項目の並び(値は参照同一性)で判定する。
function groupsEqual<T>(a: readonly ObjectPickerGroup<T>[], b: readonly ObjectPickerGroup<T>[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((ga, i) => {
    const gb = b[i]!;
    if (ga.label !== gb.label || ga.items.length !== gb.items.length) return false;
    return ga.items.every(([v, l], j) => {
      const [vb, lb] = gb.items[j]!;
      return v === vb && l === lb;
    });
  });
}

export class ObjectPicker<T> implements OverlayHandle {
  private static nextId = 0;
  private readonly overlayId: string;
  readonly element: HTMLElement;
  private readonly trigger: Button;
  private readonly pop: HTMLElement;
  private readonly filter: HTMLInputElement;
  private readonly list: HTMLElement;
  private groups: readonly ObjectPickerGroup<T>[] = [];
  private selected: T | null = null;
  private isOpen = false;
  private readonly onSelect: (value: T) => void;

  // title は見出し、root はポップアップを popup レイヤへ追加する親。
  constructor(
    root: HTMLElement, title: string, onSelect: (value: T) => void,
    private readonly overlayManager: OverlayManager,
  ) {
    this.overlayId = `object-picker-${ObjectPicker.nextId++}`;
    ensureStyle();
    this.onSelect = onSelect;

    this.element = document.createElement('div');
    this.element.className = 'w-group';
    const heading = document.createElement('span');
    heading.className = 'w-group-title';
    heading.textContent = title;
    this.element.appendChild(heading);
    this.trigger = new Button('—', () => this.toggle());
    this.element.appendChild(this.trigger.element);

    this.pop = document.createElement('div');
    this.pop.className = 'object-picker-pop';
    this.pop.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.filter = document.createElement('input');
    this.filter.className = 'op-filter';
    this.filter.placeholder = '絞り込み';
    this.filter.addEventListener('input', () => this.renderList());
    this.filter.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') this.close();
    });
    this.pop.appendChild(this.filter);
    this.list = document.createElement('div');
    this.list.className = 'op-grid';
    this.pop.appendChild(this.list);
    root.appendChild(this.pop);
  }

  contains(target: Node): boolean {
    return this.pop.contains(target) || this.element.contains(target);
  }

  // 候補を差し替える。前回と同じ内容(ラベルと項目の並びが一致)なら何もしない —
  // 呼び出し側が毎フレーム同じ内容を渡してくることがあり、無条件に再構築するとポップアップを
  // 開いたままの絞り込み入力・ホバーと競合する。
  setGroups(groups: readonly ObjectPickerGroup<T>[]): void {
    if (groupsEqual(this.groups, groups)) return;
    this.groups = groups;
    if (this.isOpen) this.renderList();
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
    this.trigger.setLabel(`${label ?? String(this.selected ?? '—')} ▾`);
  }

  // ボタンを押すたびにポップアップの開閉を切り替える。
  private toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }

  // ポップアップをボタンの直下に開く。絞り込み入力は毎回空に戻す(前回の絞り込みが残っていると
  // 候補が欠けて見える)。開いた直後に入力へフォーカスするので、そのまま名前を打てる。
  private open(): void {
    this.filter.value = '';
    this.renderList();
    this.isOpen = true;
    this.pop.style.display = 'block';
    bringToFront(this.pop);
    // 画面端で開いてもはみ出さないよう、実寸を測ってから位置を決める。
    const anchor = this.trigger.element.getBoundingClientRect();
    const rect = this.pop.getBoundingClientRect();
    const pos = clampOverlayPosition(
      { x: anchor.left, y: anchor.bottom + 2 }, rect,
      { width: window.innerWidth, height: window.innerHeight }, 6,
    );
    this.pop.style.left = `${pos.x}px`;
    this.pop.style.top = `${pos.y}px`;
    this.filter.focus();
    this.overlayManager.open(this.overlayId, this, {
      kind: 'popup', closeOnEscape: true, closeOnOutsideClick: true, gatesInput: false,
    });
  }

  // ポップアップを閉じる。
  close(): void {
    this.isOpen = false;
    this.pop.style.display = 'none';
    this.overlayManager.close(this.overlayId);
  }

  // 絞り込み文字列に一致する候補だけを、グループ見出しつきで並べ直す。候補が1件も無い
  // グループは見出しごと出さない。
  private renderList(): void {
    const needle = this.filter.value.trim().toLowerCase();
    this.list.innerHTML = '';
    // 1件も残らなかったら「該当なし」を出す — 空のポップアップは壊れて見える。
    let shown = 0;
    for (const group of this.groups) {
      const items = needle === ''
        ? group.items
        : group.items.filter(([, label]) => label.toLowerCase().includes(needle));
      if (items.length === 0) continue;
      if (group.label !== '') {
        const head = document.createElement('div');
        head.className = 'op-group';
        head.textContent = group.label;
        this.list.appendChild(head);
      }
      for (const [value, label] of items) {
        const row = document.createElement('div');
        row.className = 'op-row';
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
      empty.className = 'op-empty';
      empty.textContent = '該当なし';
      this.list.appendChild(empty);
    }
  }
}
