// プロパティウィンドウの値表示。hero を主読み値、major をその脇の行にした上段の Summary、通常値を
// 行の束、group を名前付きの折り畳みとして組む。刻々変わる値を先に、腰を据えて読む値(group)を末尾に置く。
// presentation 未指定の PropertyRow は metric として扱う。
import { COLLAPSE_COLLAPSED_GLYPH, COLLAPSE_EXPANDED_GLYPH, Meter } from '../widgets';
import { bindActivation, stopDragPropagation } from '../widgets/widget-base';
import { setReadout } from '../readout';
import type { ReclampingWindow } from './draggable-window';
import type { PropertyRow, PropertyRowPresentation } from './property-window-content';

// presentation 未指定の行は metric。
function presentationOf(row: PropertyRow): PropertyRowPresentation {
  return row.presentation ?? 'metric';
}

// 行の値を書き換えるために覚えておく要素。meter は fill を持つ行だけが持つ。
interface RowRefs {
  readonly valueEl: HTMLElement;
  readonly meter: Meter | null;
}

// 値・単位・メーターのどれかが変われば変わる行の署名。
function rowSignature(row: PropertyRow): string {
  return `${row.value}|${row.unit ?? ''}|${row.fill ?? ''}`;
}

export class PropertyWindowRows {
  public readonly element: HTMLDivElement;
  private readonly refs = new Map<string, RowRefs>();
  private readonly lastSignatures = new Map<string, string>();
  private lastRowShapeKey = '';
  private readonly groupExpanded = new Map<string, boolean>();

  // 折り畳みの開閉で高さが変わるときのはみ出し補正を win へ頼む。
  public constructor(private readonly win: ReclampingWindow) {
    this.element = document.createElement('div');
    this.element.className = 'prop-window-rows';
  }

  // 行構成が変わったときだけ DOM を組み直し、構成が同じなら値・単位・メーターだけを更新する。
  public sync(rows: readonly PropertyRow[]): void {
    const shapeKey = JSON.stringify(rows.map((r) => [
      r.key, r.label, r.group ?? null, presentationOf(r), r.fill !== undefined,
    ]));
    if (shapeKey === this.lastRowShapeKey) {
      for (const row of rows) this.updateRow(row);
      return;
    }

    this.lastRowShapeKey = shapeKey;
    this.element.replaceChildren();
    this.refs.clear();
    this.lastSignatures.clear();

    // presentation ごと・group ごとに振り分け、上段の Summary → 通常の行 → 折り畳みの順に並べる。
    const heroRows = rows.filter((r) => r.group === undefined && presentationOf(r) === 'hero');
    const majorRows = rows.filter((r) => r.group === undefined && presentationOf(r) === 'major');
    const plainRows = rows.filter((r) => r.group === undefined && presentationOf(r) === 'metric');
    const groupNames: string[] = [];
    const groupRows = new Map<string, PropertyRow[]>();
    for (const row of rows) {
      if (row.group === undefined) continue;
      let list = groupRows.get(row.group);
      if (!list) {
        list = [];
        groupRows.set(row.group, list);
        groupNames.push(row.group);
      }
      list.push(row);
    }

    if (heroRows.length > 0 || majorRows.length > 0) {
      const summary = document.createElement('div');
      summary.className = 'prop-window-summary';
      if (heroRows.length > 0) {
        const heroes = document.createElement('div');
        heroes.className = 'prop-window-heroes';
        for (const row of heroRows) heroes.appendChild(this.buildHero(row));
        summary.appendChild(heroes);
      }
      if (majorRows.length > 0) summary.appendChild(this.buildRows(majorRows, 'prop-window-majors'));
      this.element.appendChild(summary);
    }
    if (plainRows.length > 0) this.element.appendChild(this.buildRows(plainRows, 'prop-window-metrics'));
    for (const name of groupNames) this.appendGroupEl(name, groupRows.get(name) ?? []);
  }

  // 値だけが変わった行を書き換える。
  private updateRow(row: PropertyRow): void {
    const signature = rowSignature(row);
    if (this.lastSignatures.get(row.key) === signature) return;
    this.lastSignatures.set(row.key, signature);
    const refs = this.refs.get(row.key);
    if (refs === undefined) return;
    setReadout(refs.valueEl, row.value, row.unit ?? '');
    refs.meter?.setRatio(row.fill ?? 0);
  }

  // 主読み値(大きな値と、その下の見出し)を組む。
  private buildHero(row: PropertyRow): HTMLElement {
    const hero = document.createElement('div');
    hero.className = 'ui-readout prop-window-row prop-window-row-hero';
    hero.dataset['key'] = row.key;
    const valueEl = document.createElement('span');
    valueEl.className = 'ui-readout-value prop-window-row-value';
    const capEl = document.createElement('span');
    capEl.className = 'ui-readout-cap prop-window-row-label';
    capEl.textContent = row.label;
    hero.append(valueEl, capEl);
    this.refs.set(row.key, { valueEl, meter: null });
    this.updateRow(row);
    return hero;
  }

  // 行の束。ラベル・(あれば)メーター・値と単位の1行を並べる。
  private buildRows(rows: readonly PropertyRow[], className: string): HTMLElement {
    const container = document.createElement('div');
    container.className = `ui-rows ${className}`;
    for (const row of rows) container.appendChild(this.buildRow(row));
    return container;
  }

  // ラベル・(fill があれば)メーター・値と単位の1行。
  private buildRow(row: PropertyRow): HTMLElement {
    const rowEl = document.createElement('div');
    rowEl.className = `ui-row prop-window-row prop-window-row-${presentationOf(row)}`;
    rowEl.dataset['key'] = row.key;
    const keyEl = document.createElement('span');
    keyEl.className = 'ui-k';
    const labelEl = document.createElement('span');
    labelEl.className = 'ui-k-text prop-window-row-label';
    labelEl.textContent = row.label;
    keyEl.appendChild(labelEl);
    rowEl.appendChild(keyEl);
    let meter: Meter | null = null;
    if (row.fill !== undefined) {
      meter = new Meter(row.label);
      const gaugeEl = document.createElement('span');
      gaugeEl.className = 'ui-gauge';
      gaugeEl.appendChild(meter.element);
      rowEl.appendChild(gaugeEl);
    }
    const valueEl = document.createElement('span');
    valueEl.className = 'ui-v prop-window-row-value';
    rowEl.appendChild(valueEl);
    this.refs.set(row.key, { valueEl, meter });
    this.updateRow(row);
    return rowEl;
  }

  // 名前付きの折り畳み。既定では畳まれ、開閉の状態は名前ごとに覚える。
  private appendGroupEl(name: string, rows: readonly PropertyRow[]): void {
    const toggle = document.createElement('div');
    toggle.className = 'ui-fold prop-window-row-group-toggle';
    toggle.setAttribute('role', 'button');
    toggle.tabIndex = 0;
    const glyphEl = document.createElement('span');
    const nameEl = document.createElement('span');
    nameEl.textContent = name;
    const countEl = document.createElement('span');
    countEl.className = 'ui-fold-n';
    countEl.textContent = String(rows.length);
    toggle.append(glyphEl, nameEl, countEl);

    const container = this.buildRows(rows, 'prop-window-section');
    // 開閉の見た目(記号・aria・本文の表示)を open に合わせる。
    const apply = (open: boolean): void => {
      glyphEl.textContent = open ? COLLAPSE_EXPANDED_GLYPH : COLLAPSE_COLLAPSED_GLYPH;
      toggle.setAttribute('aria-expanded', String(open));
      container.style.display = open ? '' : 'none';
    };
    apply(this.groupExpanded.get(name) ?? false);
    stopDragPropagation(toggle);
    bindActivation(toggle, () => {
      const next = !(this.groupExpanded.get(name) ?? false);
      this.groupExpanded.set(name, next);
      apply(next);
      this.win.reclamp();
    });
    this.element.append(toggle, container);
  }
}
