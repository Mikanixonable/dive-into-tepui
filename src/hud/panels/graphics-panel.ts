// 描画品質の設定面。好み → 全体のプリセット → (全体がカスタムのとき)分野のプリセットと表示する要素 →
// (分野がカスタムのとき)その分野の詳細の値、の順に GRAPHICS_FIELDS・GRAPHICS_ELEMENTS・GRAPHICS_PREFERENCES の
// 表どおりに並べる。表示中の選び方を持ち、操作のたびに新しい選び方を onChange で外へ返す。
import {
  GRAPHICS_ELEMENTS, GRAPHICS_FIELDS, GRAPHICS_PREFERENCES, fieldKnob, fieldKnobKeys, graphicsElementKeys,
  graphicsFieldKeys, graphicsPreferenceKeys,
  type ChoiceValue, type GraphicsFieldKey, type GraphicsKey, type GraphicsKnob, type GraphicsPreference,
  type QualityPreset,
} from '../../render/graphics-settings';
import {
  resolveGraphics, selectField, selectOverall, withGraphicsValue, type GraphicsSelection,
} from '../../render/graphics-selection';
import { Pulldown, SegmentedControl, Slider, ToggleSwitch, buildLabeledRow, type PulldownColumn } from '../widgets';
import { MQ_COMPACT } from '../breakpoints';
import { injectOnce } from '../inject-style';

// このパネル自身の CSS。余白を持つ規則は `#hud` を冠した枝を併記する — HUD は `#hud, #hud *` で
// margin/padding を 0 へ落としており、素のクラスでは詳細度で負けて余白が潰れる。
const STYLE = `
.gp-body, .gp-custom { display: flex; flex-direction: column; gap: var(--space-4); min-width: 0; }
.gp-fields {
  display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-4) var(--space-5); min-width: 0;
}
.gp-field { display: flex; flex-direction: column; gap: var(--space-2); min-width: 0; }
.gp-knobs {
  display: flex; flex-direction: column; gap: var(--space-2); min-width: 0;
  background: var(--glass-inset); border-radius: var(--radius-control);
}
.gp-knobs, #hud .gp-knobs { padding: var(--space-3); }
.gp-custom[hidden], .gp-knobs[hidden] { display: none; }
.gp-group {
  display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-3) var(--space-5);
  align-items: start; min-width: 0;
}
.gp-group-title, #hud .gp-group-title {
  grid-column: 1 / -1; margin: 0; color: var(--color-primary); font-size: var(--font-xxs); letter-spacing: 0.12em;
}
/* 項目の行はラベルを左へ、操作を右へ寄せる。折り返した操作も右端で揃う。 */
.gp-body > .w-group, .gp-field > .w-group, .gp-group > .w-group, .gp-knobs > .w-group {
  justify-content: flex-end; min-width: 0;
}
.gp-body > .w-group > .w-group-title, .gp-field > .w-group > .w-group-title,
.gp-group > .w-group > .w-group-title, .gp-knobs > .w-group > .w-group-title,
#hud .gp-body > .w-group > .w-group-title, #hud .gp-field > .w-group > .w-group-title,
#hud .gp-group > .w-group > .w-group-title, #hud .gp-knobs > .w-group > .w-group-title { margin-right: auto; }
.gp-group > .w-toggle, .gp-knobs > .w-toggle { justify-content: space-between; min-width: 0; }
.gp-group .w-select, .gp-knobs .w-select { min-width: 0; max-width: 100%; }
.gp-slider > .w-slider { flex: 1 1 0; min-width: 0; }
.gp-slider-value {
  min-width: var(--space-6); color: var(--text); font-size: var(--font-xs); text-align: right;
  font-variant-numeric: tabular-nums;
}
@media ${MQ_COMPACT} {
  .gp-fields, .gp-group { grid-template-columns: 1fr; }
}
`;

// 全体と分野のセグメントコントロールで選ぶもの。消せる分野だけが 'off' を持つ。
type OverallChoice = QualityPreset | 'custom';
type FieldChoice = 'off' | OverallChoice;

const OVERALL_ITEMS: readonly (readonly [OverallChoice, string])[] = [
  ['low', '低'], ['medium', '中'], ['high', '高'], ['custom', 'カスタム'],
];
const OFF_ITEM: readonly [FieldChoice, string] = ['off', 'オフ'];

// 全体のプリセットの行と、表示する要素・好みの群の見出し。
const OVERALL_TITLE = '全体';
const ELEMENTS_TITLE = '表示する要素';
const PREFERENCES_TITLE = '好み';

// hidden の既定。全項目を並べる。
const NO_HIDDEN_KEYS: ReadonlySet<GraphicsKey> = new Set();

// プルダウンで選ぶ項目の列。描画設定の項目はどれも1列しか持たない。
type SelectColumns = readonly [PulldownColumn<ChoiceValue>];

// 現在値を渡すと、その項目の点灯を引き直す関数。
type ShowValue = (value: boolean | ChoiceValue) => void;

// 項目 1 つぶんのコントロール。
interface ValueControl {
  readonly key: GraphicsKey;
  readonly show: ShowValue;
}

// 分野 1 つぶんの行。preset は分野のプリセットの点灯、knobs は詳細の値の器。
interface FieldRow {
  readonly field: GraphicsFieldKey;
  readonly preset: SegmentedControl<FieldChoice>;
  readonly knobs: HTMLElement;
}

// 分野 field のセグメントコントロールの候補。消せる分野だけオフを先頭に置く。
function fieldItems(field: GraphicsFieldKey): readonly (readonly [FieldChoice, string])[] {
  return GRAPHICS_FIELDS[field].enabled === null ? OVERALL_ITEMS : [OFF_ITEM, ...OVERALL_ITEMS];
}

// 項目 knob のコントロールを、表の kind に応じた部品で組んで parent へ並べ、点灯を引き直す関数を返す。操作の
// たびに write へ新しい値を渡す。2 候補の choice は items[1] をオンとするトグル、3 候補以上はセグメントコントロール、
// select は反映ボタンを添えないプルダウン(見比べながら選ぶもの)、slider は今の値の数字を添えたスライダー。
function buildControl(
  parent: HTMLElement, knob: GraphicsKnob | GraphicsPreference, write: (value: boolean | ChoiceValue) => void,
): ShowValue {
  // 真偽の項目。
  if (knob.kind === 'toggle') {
    const widget = new ToggleSwitch(knob.label, write);
    parent.appendChild(widget.element);
    return (value) => widget.setOn(value === true);
  }
  // 範囲から選ぶ項目。見出し・スライダー・今の値の数字を 1 行に並べる。
  if (knob.kind === 'slider') {
    const row = buildLabeledRow(knob.label);
    row.classList.add('gp-slider');
    const widget = new Slider({ min: knob.min, max: knob.max, step: knob.step }, write);
    const number = document.createElement('span');
    number.className = 'gp-slider-value';
    row.append(widget.element, number);
    parent.appendChild(row);
    return (value) => {
      if (typeof value !== 'number') return;
      widget.setValue(value);
      number.textContent = String(value);
    };
  }
  // 名前で選ぶ多数の候補。
  if (knob.kind === 'select') {
    const columns: SelectColumns = [{ items: knob.items }];
    const widget = new Pulldown(knob.label, columns, null, ([value]) => write(value));
    parent.appendChild(widget.element);
    return (value) => { if (typeof value !== 'boolean') widget.setSelected(0, value); };
  }
  // 短い候補。2 候補はトグル、3 候補以上はセグメントコントロール。
  if (knob.items.length === 2) {
    const [off, on] = [knob.items[0]![0], knob.items[1]![0]];
    const widget = new ToggleSwitch(knob.label, (isOn) => write(isOn ? on : off));
    parent.appendChild(widget.element);
    return (value) => widget.setOn(value === on);
  }
  const widget = new SegmentedControl<ChoiceValue>(knob.label, knob.items, write);
  parent.appendChild(widget.element);
  return (value) => { if (typeof value !== 'boolean') widget.setSelected(value); };
}

export class GraphicsPanel {
  public readonly element: HTMLElement;

  // 操作で新しい選び方ができたときに呼ばれる。
  public onChange: ((selection: GraphicsSelection) => void) | null = null;

  private readonly overall: SegmentedControl<OverallChoice>;
  // 分野の行と表示する要素の器。全体がカスタムのときだけ見せる。
  private readonly custom: HTMLElement;
  private readonly fieldRows: FieldRow[] = [];
  private readonly controls: ValueControl[] = [];

  // selection は組み立て時に点灯させる選び方。hidden は伏せる項目(この置き場では切り替えても効かないもの)で、
  // 伏せた項目は並べず、項目の無くなった群は見出しごと消える。
  public constructor(
    private selection: GraphicsSelection,
    hidden: ReadonlySet<GraphicsKey> = NO_HIDDEN_KEYS,
  ) {
    injectOnce('graphics-panel', STYLE);
    this.element = document.createElement('div');
    this.element.className = 'gp-body';

    // 好みと全体のプリセットは、全体の選択によらず見せる。
    this.addGroup(this.element, PREFERENCES_TITLE, graphicsPreferenceKeys().map(
      (key) => [key, GRAPHICS_PREFERENCES[key]],
    ), hidden);
    this.overall = new SegmentedControl<OverallChoice>(OVERALL_TITLE, OVERALL_ITEMS, (choice) => {
      this.select(selectOverall(this.selection, choice));
    });
    this.element.appendChild(this.overall.element);

    // 分野の行を 2 列の grid に、表示する要素をその下に組む。
    this.custom = document.createElement('div');
    this.custom.className = 'gp-custom';
    const fields = document.createElement('div');
    fields.className = 'gp-fields';
    for (const field of graphicsFieldKeys()) this.addField(fields, field, hidden);
    this.custom.appendChild(fields);
    this.addGroup(this.custom, ELEMENTS_TITLE, graphicsElementKeys().map(
      (key) => [key, GRAPHICS_ELEMENTS[key]],
    ), hidden);
    this.element.appendChild(this.custom);

    // 引き直す先が揃ってから点灯させる。
    this.sync(selection);
  }

  // 外から選び方が変わったときに、全層の点灯と器の表示を引き直す。分野の行と表示する要素は全体がカスタムの
  // ときだけ、分野の詳細の値はその分野がカスタムのときだけ見せる。
  public sync(selection: GraphicsSelection): void {
    this.selection = selection;
    // 全体の点灯と、分野の行の器。
    const quality = selection.quality;
    this.overall.setSelected(typeof quality === 'string' ? quality : 'custom');
    this.custom.hidden = typeof quality === 'string';
    // 分野ごとの点灯と、詳細の値の器。
    if (typeof quality !== 'string') {
      for (const row of this.fieldRows) {
        const choice = quality.fields[row.field];
        row.preset.setSelected(typeof choice === 'string' ? choice : 'custom');
        row.knobs.hidden = typeof choice === 'string';
      }
    }
    // 詳細の値・表示する要素・好みの点灯。
    const graphics = resolveGraphics(selection);
    for (const control of this.controls) control.show(graphics[control.key]);
  }

  // 分野 field の行を parent へ並べる。プリセットのセグメントコントロールと、その直下に詳細の値の器。伏せた
  // ノブは並べず、ノブの無くなった器は置かない。
  private addField(parent: HTMLElement, field: GraphicsFieldKey, hidden: ReadonlySet<GraphicsKey>): void {
    const cell = document.createElement('div');
    cell.className = 'gp-field';
    // 分野のプリセット。
    const preset = new SegmentedControl<FieldChoice>(GRAPHICS_FIELDS[field].label, fieldItems(field), (choice) => {
      this.select(selectField(this.selection, field, choice));
    });
    cell.appendChild(preset.element);
    // 詳細の値。
    const knobs = document.createElement('div');
    knobs.className = 'gp-knobs';
    for (const key of fieldKnobKeys(field)) {
      if (!hidden.has(key)) this.addControl(knobs, key, fieldKnob(field, key)!);
    }
    if (knobs.childElementCount > 0) cell.appendChild(knobs);
    parent.appendChild(cell);
    this.fieldRows.push({ field, preset, knobs });
  }

  // 見出し title と items の項目を 1 つの群に組んで parent へ並べる。伏せた項目は省き、項目が無くなれば群ごと省く。
  private addGroup(
    parent: HTMLElement, title: string,
    items: readonly (readonly [GraphicsKey, GraphicsKnob | GraphicsPreference])[], hidden: ReadonlySet<GraphicsKey>,
  ): void {
    const shown = items.filter(([key]) => !hidden.has(key));
    if (shown.length === 0) return;
    // 群の器と見出し。
    const section = document.createElement('div');
    section.className = 'gp-group';
    const heading = document.createElement('h4');
    heading.className = 'gp-group-title';
    heading.textContent = title;
    section.appendChild(heading);
    // 項目ごとのコントロール。
    for (const [key, knob] of shown) this.addControl(section, key, knob);
    parent.appendChild(section);
  }

  // 項目 key のコントロールを parent へ並べ、点灯を引き直す対象に加える。
  private addControl(parent: HTMLElement, key: GraphicsKey, knob: GraphicsKnob | GraphicsPreference): void {
    const show = buildControl(parent, knob, (value) => this.select(withGraphicsValue(this.selection, key, value)));
    this.controls.push({ key, show });
  }

  // 選ばれた選び方へ移る。自分の点灯を引き直してから外へ返す。
  private select(selection: GraphicsSelection): void {
    this.sync(selection);
    this.onChange?.(selection);
  }
}
