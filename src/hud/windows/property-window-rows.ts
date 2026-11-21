// プロパティ行を要約・通常値・グループ・詳細欄に分けて表示する。
import { COLLAPSE_COLLAPSED_GLYPH, COLLAPSE_EXPANDED_GLYPH } from '../widgets';
import { bindActivation } from '../widgets/widget-base';
import type { ReclampingWindow } from './draggable-window';
import type { PropertyRow, PropertyRowPresentation } from './property-window-content';

// 展開中は名前だけ、閉じているときは行数も含めたラベルを返す。
function groupToggleLabel(name: string, rowCount: number, expanded: boolean): string {
  // 閉じているときだけ、グループ内の行数を見出しに添える。
  return expanded
    ? `${COLLAPSE_EXPANDED_GLYPH} ${name}`
    : `${COLLAPSE_COLLAPSED_GLYPH} ${name} (${rowCount})`;
}

// 表示形式を省略した行には通常値の形式を適用する。
function presentationOf(row: PropertyRow): PropertyRowPresentation {
  // 表示形式が省略された行は通常値として扱う。
  return row.presentation ?? 'metric';
}

export class PropertyWindowRows {
  public readonly element: HTMLDivElement;
  private lastRowValues = new Map<string, string>();
  private lastRowShapeKey = '';
  private collapsibleContainerEl: HTMLDivElement | null = null;
  private toggleEl: HTMLDivElement | null = null;
  private collapsibleExpanded = false;
  private readonly groupExpanded = new Map<string, boolean>();

  // 内容の開閉後にウィンドウの表示範囲を整えるため、所有ウィンドウを受け取る。
  public constructor(private readonly win: ReclampingWindow) {
    this.element = document.createElement('div');
    this.element.className = 'prop-window-rows';
  }

  // 行の形が同じなら値だけ更新し、形が変わったときは表示区画を組み直す。
  public sync(rows: readonly PropertyRow[]): void {
    const shapeKey = JSON.stringify(rows.map((r) => [
      r.key, r.label, r.group ?? null, r.collapsible === true, presentationOf(r),
    ]));
    if (shapeKey === this.lastRowShapeKey) {
      // 構造が同じなら値だけを差し替え、折りたたみ状態と行 DOM を維持する。
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
    this.element.replaceChildren();
    this.lastRowValues.clear();
    this.collapsibleContainerEl = null;
    this.toggleEl = null;

    const summaryRows: PropertyRow[] = [];
    const plainRows: PropertyRow[] = [];
    const collapsibleRows: PropertyRow[] = [];
    const groupNames: string[] = [];
    const groupRows = new Map<string, PropertyRow[]>();

    // 表示形式ごとに分けてから、要約・通常値・グループ・詳細の順で並べる。
    for (const row of rows) {
      const presentation = presentationOf(row);
      if (row.group !== undefined) {
        let list = groupRows.get(row.group);
        if (!list) {
          list = [];
          groupRows.set(row.group, list);
          groupNames.push(row.group);
        }
        list.push(row);
      } else if (row.collapsible || presentation === 'detail') {
        collapsibleRows.push(row);
      } else if (presentation === 'hero' || presentation === 'major') {
        summaryRows.push(row);
      } else {
        plainRows.push(row);
      }
    }

    if (summaryRows.length > 0) {
      const summary = document.createElement('div');
      summary.className = 'prop-window-summary';
      const orderedSummary = [...summaryRows].sort((a, b) => {
        const rank = (row: PropertyRow): number => presentationOf(row) === 'hero' ? 0 : 1;
        return rank(a) - rank(b);
      });
      for (const row of orderedSummary) this.appendRowEl(summary, row);
      this.element.appendChild(summary);
    }

    if (plainRows.length > 0) {
      const metrics = document.createElement('div');
      metrics.className = 'prop-window-metrics';
      for (const row of plainRows) this.appendRowEl(metrics, row);
      this.element.appendChild(metrics);
    }

    for (const name of groupNames) this.appendGroupEl(name, groupRows.get(name) ?? []);

    if (collapsibleRows.length > 0) {
      const toggle = document.createElement('div');
      toggle.className = 'prop-window-row-toggle';
      toggle.setAttribute('role', 'button');
      toggle.tabIndex = 0;
      toggle.setAttribute('aria-expanded', String(this.collapsibleExpanded));
      bindActivation(toggle, () => this.setCollapsibleExpanded(!this.collapsibleExpanded));
      this.element.appendChild(toggle);
      this.toggleEl = toggle;

      const container = document.createElement('div');
      container.className = 'prop-window-details';
      for (const row of collapsibleRows) this.appendRowEl(container, row);
      this.element.appendChild(container);
      this.collapsibleContainerEl = container;
      this.syncToggleLabel(collapsibleRows.length);
      container.classList.toggle('hidden', !this.collapsibleExpanded);
    }
  }

  // 表示形式に応じたクラスを持つ値行を追加し、次回の差分同期用に値を記録する。
  private appendRowEl(container: HTMLElement, row: PropertyRow): void {
    // 表示形式をクラスへ反映し、次回の値だけの同期に使う値を記録する。
    const presentation = presentationOf(row);
    const rowEl = document.createElement('div');
    rowEl.className = `prop-window-row prop-window-row-${presentation}`;
    rowEl.dataset['key'] = row.key;
    const labelEl = document.createElement('div');
    labelEl.className = 'prop-window-row-label';
    labelEl.textContent = row.label;
    const valueEl = document.createElement('div');
    valueEl.className = 'prop-window-row-value';
    valueEl.textContent = row.value;
    rowEl.append(labelEl, valueEl);
    container.appendChild(rowEl);
    this.lastRowValues.set(row.key, row.value);
  }

  // 展開状態をグループ名ごとに保持する折りたたみ区画を追加する。
  private appendGroupEl(name: string, rows: readonly PropertyRow[]): void {
    // 展開状態はグループ名ごとに保持し、行の再同期後も同じグループへ戻す。
    const expanded = this.groupExpanded.get(name) ?? false;
    const toggle = document.createElement('div');
    toggle.className = 'prop-window-row-group-toggle';
    toggle.setAttribute('role', 'button');
    toggle.tabIndex = 0;
    toggle.setAttribute('aria-expanded', String(expanded));
    toggle.textContent = groupToggleLabel(name, rows.length, expanded);

    const container = document.createElement('div');
    container.className = 'prop-window-section';
    container.classList.toggle('hidden', !expanded);
    for (const row of rows) this.appendRowEl(container, row);

    const setExpanded = (): void => {
      const next = !(this.groupExpanded.get(name) ?? false);
      this.groupExpanded.set(name, next);
      toggle.textContent = groupToggleLabel(name, rows.length, next);
      toggle.setAttribute('aria-expanded', String(next));
      container.classList.toggle('hidden', !next);
      this.reclamp();
    };
    bindActivation(toggle, setExpanded);

    this.element.append(toggle, container);
  }

  private syncToggleLabel(count: number): void {
    if (!this.toggleEl) return;
    this.toggleEl.textContent = this.collapsibleExpanded
      ? `${COLLAPSE_EXPANDED_GLYPH} DETAILS`
      : `${COLLAPSE_COLLAPSED_GLYPH} DETAILS / ${count}`;
  }

  // 詳細欄の表示状態を更新し、変化後の内容に合わせてウィンドウを補正する。
  private setCollapsibleExpanded(expanded: boolean): void {
    // 詳細欄の開閉表示と、ウィンドウの内容に応じた高さ補正を同期する。
    this.collapsibleExpanded = expanded;
    this.collapsibleContainerEl?.classList.toggle('hidden', !expanded);
    this.toggleEl?.setAttribute('aria-expanded', String(expanded));
    this.syncToggleLabel(this.collapsibleContainerEl?.childElementCount ?? 0);
    this.reclamp();
  }

  private reclamp(): void {
    this.win.reclamp();
  }
}
