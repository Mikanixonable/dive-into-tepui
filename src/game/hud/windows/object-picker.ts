// 候補が数十〜百件になる値を選ばせるボタン。SegmentedControl は候補を横並びに積むだけなので、
// 登録天体ぶんの候補を並べると1行に収まらない。現在の選択を出すボタンを押すとポップアップが
// 開き、上から「絞り込み入力」「グループ分けした全候補」の順に並ぶ。候補はグループごとに
// 複数列のグリッドへ並べる(百件規模を縦一列に積むと画面高をはみ出すため)。
import { clampOverlayPosition } from '../layout';
import { Button, buildLabeledRow } from '../widgets';
import { injectOnce } from '../widgets/inject-style';
import { bringToFront } from '../overlay-layer';
import { isCompactViewport, MQ_COMPACT } from '../breakpoints';
import type { OverlayHandle, OverlayManager } from '../overlay-manager';

const STYLE = `
#hud .object-picker-pop {
  position: fixed; display: none; pointer-events: auto;
  background: var(--glass-focus); border: 0; border-radius: var(--radius-window);
  font-family: var(--font-family); font-size: var(--font-m); color: var(--text);
  width: min(520px, calc(100vw - 24px)); max-height: 60vh; max-height: 60dvh; overflow-y: auto; user-select: none;
  box-shadow: 0 16px 48px var(--shade-1); backdrop-filter: blur(20px) saturate(82%);
  -webkit-user-select: none;
}
/* compact: トリガー直下ではなく画面下端のシートとして開く(left/top は付けない —
   その位置決めは open() が isCompactViewport() の間スキップする)。 */
@media ${MQ_COMPACT} {
  #hud .object-picker-pop {
    right: 0; bottom: 0; width: 100%;
    max-height: 70vh; max-height: 70dvh; border-radius: var(--radius-window) var(--radius-window) 0 0;
  }
}
#hud .object-picker-pop .op-filter {
  width: 100%; box-sizing: border-box; padding: var(--space-3) var(--space-5); margin: 0;
  background: var(--surface-2); border: none;
  color: var(--text); font-family: var(--font-family); font-size: var(--font-m); outline: none;
}
#hud .object-picker-pop .op-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
}
#hud .object-picker-pop .op-group {
  grid-column: 1 / -1; padding: var(--space-3) var(--space-5) var(--space-2); font-size: var(--font-xs); letter-spacing: 1px; opacity: 0.55;
}
#hud .object-picker-pop .op-row {
  margin: var(--space-1); padding: var(--space-3) var(--space-5); cursor: pointer;
  border: 0; border-radius: var(--radius-micro);
}
#hud .object-picker-pop .op-row:hover { background: var(--surface-2); color: var(--color-primary-hover); }
#hud .object-picker-pop .op-row.on { color: var(--color-primary); background: var(--color-primary-fill); }
#hud .object-picker-pop .op-row:focus-visible { outline: 2px solid var(--color-focus); outline-offset: -2px; }
#hud .object-picker-pop .op-empty { grid-column: 1 / -1; padding: var(--space-4) var(--space-5); opacity: 0.5; }
`;

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
  public readonly element: HTMLElement;
  private readonly trigger: Button;
  private readonly pop: HTMLElement;
  private readonly filter: HTMLInputElement;
  private readonly list: HTMLElement;
  private groups: readonly ObjectPickerGroup<T>[] = [];
  private selected: T | null = null;
  private isOpen = false;
  private readonly onSelect: (value: T) => void;
  private previouslyFocused: HTMLElement | null = null;
  private disposed = false;

  // title は見出し、root はポップアップを popup レイヤへ追加する親。
  public constructor(
    root: HTMLElement, title: string, onSelect: (value: T) => void,
    private readonly overlayManager: OverlayManager,
  ) {
    this.overlayId = `object-picker-${ObjectPicker.nextId++}`;
    injectOnce('obj-picker', STYLE);
    this.onSelect = onSelect;

    // 見出しと現在の選択を表示するトリガーボタンを組み立てる。
    this.element = buildLabeledRow(title);
    this.trigger = new Button('—', () => this.toggle());
    this.trigger.element.setAttribute('aria-haspopup', 'dialog');
    this.trigger.element.setAttribute('aria-expanded', 'false');
    this.element.appendChild(this.trigger.element);

    // ポップアップ本体(絞り込み入力+候補一覧)を組み立てる。
    this.pop = document.createElement('div');
    this.pop.className = 'object-picker-pop';
    this.pop.setAttribute('role', 'dialog');
    this.pop.setAttribute('aria-label', title);
    this.pop.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.pop.addEventListener('keydown', (event) => {
      if (event.key === 'Tab') this.close();
    });
    this.filter = document.createElement('input');
    this.filter.className = 'op-filter';
    this.filter.placeholder = '絞り込み';
    this.filter.setAttribute('aria-label', `${title}を絞り込む`);
    this.filter.addEventListener('input', () => this.renderList());
    this.filter.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') this.close();
      if (e.key === 'Tab' && (e.shiftKey || this.list.querySelector('[role="option"]') === null)) this.close();
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        this.focusOption(0);
      }
    });
    this.pop.appendChild(this.filter);
    // 候補一覧はグリッドとして並べる。実際の行は renderList が描画する。
    this.list = document.createElement('div');
    this.list.className = 'op-grid';
    this.list.setAttribute('role', 'listbox');
    this.list.setAttribute('aria-label', `${title}の候補`);
    this.pop.appendChild(this.list);
    root.appendChild(this.pop);
  }

  // OverlayHandle 実装。target がトリガーボタンかポップアップの内部かどうかを返す。
  public contains(target: Node): boolean {
    return this.pop.contains(target) || this.element.contains(target);
  }

  // 候補を差し替える。前回と同じ内容(ラベルと項目の並びが一致)なら何もしない —
  // 呼び出し側が毎フレーム同じ内容を渡してくることがあり、無条件に再構築するとポップアップを
  // 開いたままの絞り込み入力・ホバーと競合する。
  public setGroups(groups: readonly ObjectPickerGroup<T>[]): void {
    if (groupsEqual(this.groups, groups)) return;
    this.groups = groups;
    if (this.isOpen) this.renderList();
    this.syncTriggerLabel();
  }

  // 選択中の値を反映する(候補に無い値ならボタンには id をそのまま出す)。
  public setSelected(value: T): void {
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
    this.previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.filter.value = '';
    this.renderList();
    this.isOpen = true;
    this.trigger.element.setAttribute('aria-expanded', 'true');
    this.pop.style.display = 'block';
    bringToFront(this.pop);
    // compact では下端シートとして CSS が位置を決めるので、トリガー直下への配置は行わない
    // (前回の非 compact 時に付いた left/top が残っていると right/bottom を上書きしてしまうため消す)。
    if (isCompactViewport()) {
      this.pop.style.left = '';
      this.pop.style.top = '';
    } else {
      // 画面端で開いてもはみ出さないよう、実寸を測ってから位置を決める。
      const anchor = this.trigger.element.getBoundingClientRect();
      const rect = this.pop.getBoundingClientRect();
      const pos = clampOverlayPosition(
        { x: anchor.left, y: anchor.bottom + 2 }, rect,
        { width: window.innerWidth, height: window.innerHeight }, 6,
      );
      this.pop.style.left = `${pos.x}px`;
      this.pop.style.top = `${pos.y}px`;
    }
    this.filter.focus();
    this.overlayManager.open(this.overlayId, this, {
      kind: 'popup', closeOnEscape: true, closeOnOutsideClick: true, gatesInput: false,
    });
  }

  // ポップアップを閉じる。
  public close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.trigger.element.setAttribute('aria-expanded', 'false');
    this.pop.style.display = 'none';
    this.overlayManager.close(this.overlayId);
    const focusTarget = this.previouslyFocused;
    this.previouslyFocused = null;
    (focusTarget?.isConnected ? focusTarget : this.trigger.element).focus({ preventScroll: true });
  }

  // 開いていれば閉じ、トリガーボタンとポップアップの両方を取り除く。以後このインスタンスは使えない。
  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.close();
    this.element.remove();
    this.pop.remove();
  }

  // index 番目の候補(範囲外は循環)へ roving tabindex を移してフォーカスする。
  private focusOption(index: number): void {
    const options = Array.from(this.list.querySelectorAll<HTMLElement>('[role="option"]'));
    if (options.length === 0) return;
    const wrappedIndex = (index + options.length) % options.length;
    const option = options[wrappedIndex]!;
    this.setRovingOption(option);
    option.focus({ preventScroll: true });
  }

  // 矢印キー・Home/End で roving tabindex 対象を隣接候補・先頭・末尾へ移す。
  private handleOptionKeydown(event: KeyboardEvent, option: HTMLElement): void {
    const options = Array.from(this.list.querySelectorAll<HTMLElement>('[role="option"]'));
    const index = options.indexOf(option);
    // キーごとに移動先のインデックスを決めて focusOption へ委ねる。
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      this.focusOption(index + 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      this.focusOption(index - 1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      this.focusOption(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      this.focusOption(options.length - 1);
    }
  }

  // フォーカス対象の候補だけ tabIndex 0 にし、それ以外を -1 にする(roving tabindex)。
  private setRovingOption(activeOption: HTMLElement): void {
    for (const option of Array.from(this.list.querySelectorAll<HTMLElement>('[role="option"]'))) {
      option.tabIndex = option === activeOption ? 0 : -1;
    }
  }

  // 絞り込み文字列に一致する候補だけを、グループ見出しつきで並べ直す。候補が1件も無い
  // グループは見出しごと出さない。
  private renderList(): void {
    // 再構築でフォーカスを失わないよう、直前にリスト内へフォーカスがあったかを覚えておく。
    const restoreOptionFocus = this.isOpen && this.list.contains(document.activeElement);
    const needle = this.filter.value.trim().toLowerCase();
    this.list.innerHTML = '';
    // 1件も残らなかったら「該当なし」を出す — 空のポップアップは壊れて見える。
    let shown = 0;
    // グループごとに絞り込みへ一致する項目だけを残し、見出し→各行の順に積む。
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
      // 各候補行を組み立て、クリック・キー操作・フォーカスの挙動を配線する。
      for (const [value, label] of items) {
        const row = document.createElement('div');
        row.className = 'op-row';
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', String(value === this.selected));
        row.tabIndex = -1;
        row.textContent = label;
        row.classList.toggle('on', value === this.selected);
        row.addEventListener('click', (e) => {
          e.stopPropagation();
          this.close();
          this.onSelect(value);
        });
        row.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            row.click();
            return;
          }
          this.handleOptionKeydown(e, row);
        });
        row.addEventListener('focus', () => this.setRovingOption(row));
        this.list.appendChild(row);
        shown++;
      }
    }
    // 候補が1件もなければ空表記を出し、あれば選択中(無ければ先頭)の行へ roving tabindex を合わせる。
    if (shown === 0) {
      const empty = document.createElement('div');
      empty.className = 'op-empty';
      empty.textContent = '該当なし';
      this.list.appendChild(empty);
    } else {
      const options = Array.from(this.list.querySelectorAll<HTMLElement>('[role="option"]'));
      const selectedOption = options.find((option) => option.getAttribute('aria-selected') === 'true');
      const activeOption = selectedOption ?? options[0]!;
      this.setRovingOption(activeOption);
      if (restoreOptionFocus) activeOption.focus({ preventScroll: true });
    }
  }
}
