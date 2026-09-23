// プロパティウィンドウの値表示。hero/major を上段の Summary、通常値を Metric Grid、
// group を意味単位の折りたたみ Section、collapsible/detail を末尾の詳細欄として組む。
// presentation 未指定の既存 PropertyRow は metric として扱い、旧データとの互換性を保つ。
import { COLLAPSE_COLLAPSED_GLYPH, COLLAPSE_EXPANDED_GLYPH } from '../widgets';
import type { DraggableWindow } from './draggable-window';
import type { PropertyRow, PropertyRowPresentation } from './property-window-content';

function groupToggleLabel(name: string, rowCount: number, expanded: boolean): string {
  return expanded
    ? `${COLLAPSE_EXPANDED_GLYPH} ${name}`
    : `${COLLAPSE_COLLAPSED_GLYPH} ${name} (${rowCount})`;
}

function presentationOf(row: PropertyRow): PropertyRowPresentation {
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

  public constructor(private readonly win: DraggableWindow) {
    this.element = document.createElement('div');
    this.element.className = 'prop-window-rows';
  }

  public sync(rows: readonly PropertyRow[]): void {
    const shapeKey = JSON.stringify(rows.map((r) => [
      r.key, r.label, r.group ?? null, r.collapsible === true, presentationOf(r),
    ]));
    if (shapeKey === this.lastRowShapeKey) {
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
      const activate = (e: Event): void => {
        e.stopPropagation();
        this.setCollapsibleExpanded(!this.collapsibleExpanded);
      };
      toggle.addEventListener('click', activate);
      toggle.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        activate(e);
      });
      this.element.appendChild(toggle);
      this.toggleEl = toggle;

      const container = document.createElement('div');
      container.className = 'prop-window-details';
      for (const row of collapsibleRows) this.appendRowEl(container, row);
      this.element.appendChild(container);
      this.collapsibleContainerEl = container;
      this.syncToggleLabel(collapsibleRows.length);
      container.style.display = this.collapsibleExpanded ? '' : 'none';
    }
  }

  private appendRowEl(container: HTMLElement, row: PropertyRow): void {
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

  private appendGroupEl(name: string, rows: readonly PropertyRow[]): void {
    const expanded = this.groupExpanded.get(name) ?? false;
    const toggle = document.createElement('div');
    toggle.className = 'prop-window-row-group-toggle';
    toggle.setAttribute('role', 'button');
    toggle.tabIndex = 0;
    toggle.textContent = groupToggleLabel(name, rows.length, expanded);

    const container = document.createElement('div');
    container.className = 'prop-window-section';
    container.style.display = expanded ? '' : 'none';
    for (const row of rows) this.appendRowEl(container, row);

    const setExpanded = (): void => {
      const next = !(this.groupExpanded.get(name) ?? false);
      this.groupExpanded.set(name, next);
      toggle.textContent = groupToggleLabel(name, rows.length, next);
      container.style.display = next ? '' : 'none';
      this.reclamp();
    };
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      setExpanded();
    });
    toggle.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      e.stopPropagation();
      setExpanded();
    });

    this.element.append(toggle, container);
  }

  private syncToggleLabel(count: number): void {
    if (!this.toggleEl) return;
    this.toggleEl.textContent = this.collapsibleExpanded
      ? `${COLLAPSE_EXPANDED_GLYPH} DETAILS`
      : `${COLLAPSE_COLLAPSED_GLYPH} DETAILS / ${count}`;
  }

  private setCollapsibleExpanded(expanded: boolean): void {
    this.collapsibleExpanded = expanded;
    if (this.collapsibleContainerEl) this.collapsibleContainerEl.style.display = expanded ? '' : 'none';
    this.syncToggleLabel(this.collapsibleContainerEl?.childElementCount ?? 0);
    this.reclamp();
  }

  private reclamp(): void {
    this.win.moveTo(this.win.element.offsetLeft, this.win.element.offsetTop);
  }
}
