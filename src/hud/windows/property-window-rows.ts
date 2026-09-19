// プロパティウィンドウの行一覧。key/label/value の行を並べ、同じ group の行はグループ見出しの下へ
// まとめ、collapsible な行は末尾の「詳細」トグルの下へ畳む。開閉状態は行の組み直しをまたいで保つ。
import { COLLAPSE_COLLAPSED_GLYPH, COLLAPSE_EXPANDED_GLYPH } from '../widgets';
import type { DraggableWindow } from './draggable-window';
import type { PropertyRow } from './property-window-content';

// 行グループ見出しの文字列を組む。
function groupToggleLabel(name: string, rowCount: number, expanded: boolean): string {
  return expanded
    ? `${COLLAPSE_EXPANDED_GLYPH} ${name}`
    : `${COLLAPSE_COLLAPSED_GLYPH} ${name} (${rowCount})`;
}

export class PropertyWindowRows {
  public readonly element: HTMLDivElement;
  // 前フレームに描画した行の値。値の差分更新に使う。
  private lastRowValues = new Map<string, string>();
  // 前フレームの行構成(key・見出し・group・collapsible の並び)。DOM 組み直しの要否判定に使う。
  private lastRowShapeKey = '';
  private collapsibleContainerEl: HTMLDivElement | null = null;
  private toggleEl: HTMLDivElement | null = null;
  private collapsibleExpanded = false;
  // グループ名ごとの開閉状態。sync の再構築をまたいで保つ。
  private readonly groupExpanded = new Map<string, boolean>();

  // 行一覧を差し込む要素を用意する。win は開閉で行一覧が伸縮したときに画面内へ収め直す窓。
  public constructor(private readonly win: DraggableWindow) {
    this.element = document.createElement('div');
    this.element.className = 'prop-window-rows';
  }

  // 行一覧を rows へ合わせる。毎フレーム呼び、行構成(key・見出し・group・collapsible の並び)が
  // 変わったフレームでは行の DOM を組み直す。並びは group を持つ行(グループ単位、初出順)→ 無印の行
  // → collapsible な行。
  public sync(rows: readonly PropertyRow[]): void {
    const shapeKey = JSON.stringify(rows.map((r) => [r.key, r.label, r.group ?? null, r.collapsible === true]));
    if (shapeKey === this.lastRowShapeKey) {
      // 構成が変わっていなければ、値が変わった行の表示だけを書き換える。
      for (const r of rows) {
        if (this.lastRowValues.get(r.key) === r.value) continue;
        this.lastRowValues.set(r.key, r.value);
        const valueEl = this.element.querySelector<HTMLElement>(
          `.prop-window-row[data-key="${r.key}"] .prop-window-row-value`,
        );
        if (valueEl) valueEl.textContent = r.value;
      }
      return;
    }
    this.lastRowShapeKey = shapeKey;
    this.element.innerHTML = '';
    this.lastRowValues.clear();
    this.collapsibleContainerEl = null;
    this.toggleEl = null;

    // group・collapsible の有無で3種へ振り分け、グループは初出順で束ねる。
    const groupNames: string[] = [];
    const groupRows = new Map<string, PropertyRow[]>();
    const plainRows: PropertyRow[] = [];
    const collapsibleRows: PropertyRow[] = [];
    for (const r of rows) {
      if (r.group !== undefined) {
        let list = groupRows.get(r.group);
        if (!list) { list = []; groupRows.set(r.group, list); groupNames.push(r.group); }
        list.push(r);
      } else if (r.collapsible) {
        collapsibleRows.push(r);
      } else {
        plainRows.push(r);
      }
    }

    // グループ → 無印 → collapsible の順で組み立てる。
    for (const name of groupNames) this.appendGroupEl(name, groupRows.get(name) ?? []);
    for (const r of plainRows) this.appendRowEl(this.element, r);
    if (collapsibleRows.length > 0) {
      const toggle = document.createElement('div');
      toggle.className = 'prop-window-row-toggle';
      toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        this.setCollapsibleExpanded(!this.collapsibleExpanded);
      });
      this.element.appendChild(toggle);
      this.toggleEl = toggle;
      const container = document.createElement('div');
      for (const r of collapsibleRows) this.appendRowEl(container, r);
      this.element.appendChild(container);
      this.collapsibleContainerEl = container;
      this.syncToggleLabel(collapsibleRows.length);
      container.style.display = this.collapsibleExpanded ? '' : 'none';
    }
  }

  // key/label/value の行 div を組み立てて container へ足す。
  private appendRowEl(container: HTMLElement, r: PropertyRow): void {
    const rowEl = document.createElement('div');
    rowEl.className = 'prop-window-row';
    rowEl.dataset['key'] = r.key;
    const labelEl = document.createElement('div');
    labelEl.className = 'prop-window-row-label';
    labelEl.textContent = r.label;
    const valueEl = document.createElement('div');
    valueEl.className = 'prop-window-row-value';
    valueEl.textContent = r.value;
    rowEl.appendChild(labelEl);
    rowEl.appendChild(valueEl);
    container.appendChild(rowEl);
    // 描いた値を、次フレームの差分更新の基準にする。
    this.lastRowValues.set(r.key, r.value);
  }

  // 1グループ分の見出しと行コンテナを element へ足す。開閉はグループ名ごとに覚え、既定は畳んだ状態。
  private appendGroupEl(name: string, rows: readonly PropertyRow[]): void {
    const expanded = this.groupExpanded.get(name) ?? false;
    const toggle = document.createElement('div');
    toggle.className = 'prop-window-row-group-toggle';
    toggle.textContent = groupToggleLabel(name, rows.length, expanded);
    const container = document.createElement('div');
    container.style.display = expanded ? '' : 'none';
    // 見出しのクリックで開閉する。
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      const next = !(this.groupExpanded.get(name) ?? false);
      this.groupExpanded.set(name, next);
      toggle.textContent = groupToggleLabel(name, rows.length, next);
      container.style.display = next ? '' : 'none';
      this.reclamp();
    });
    this.element.appendChild(toggle);
    for (const r of rows) this.appendRowEl(container, r);
    this.element.appendChild(container);
  }

  // 「詳細」トグルの見出し文字列を、開閉状態と件数へ合わせて書き換える。
  private syncToggleLabel(count: number): void {
    if (!this.toggleEl) return;
    this.toggleEl.textContent = this.collapsibleExpanded
      ? `${COLLAPSE_EXPANDED_GLYPH} 詳細を隠す`
      : `${COLLAPSE_COLLAPSED_GLYPH} 詳細を表示 (${count})`;
  }

  // 「詳細」トグルの開閉状態を切り替え、対象行コンテナの表示とトグル文字列へ反映する。
  private setCollapsibleExpanded(expanded: boolean): void {
    this.collapsibleExpanded = expanded;
    if (this.collapsibleContainerEl) this.collapsibleContainerEl.style.display = expanded ? '' : 'none';
    this.syncToggleLabel(this.collapsibleContainerEl?.childElementCount ?? 0);
    this.reclamp();
  }

  // 伸縮した窓を画面内へ収め直す。
  private reclamp(): void {
    this.win.moveTo(this.win.element.offsetLeft, this.win.element.offsetTop);
  }
}
