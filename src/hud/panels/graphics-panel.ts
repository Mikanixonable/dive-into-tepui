// 描画品質の設定面。全体のプリセットと、描画品質設定の各項目を GRAPHICS_FIELDS・GRAPHICS_ELEMENTS・
// GRAPHICS_PREFERENCES の表どおりに群ごとに並べる。表示中の選び方を持ち、操作のたびに新しい選び方を
// onChange で外へ返す。
import {
  GRAPHICS_ELEMENTS, GRAPHICS_FIELDS, GRAPHICS_PREFERENCES, fieldKnob, fieldKnobKeys, graphicsElementKeys,
  graphicsFieldKeys, graphicsPreferenceKeys,
  type ChoiceValue, type GraphicsKey, type GraphicsKnob, type GraphicsPreference, type QualityPreset,
} from '../../render/graphics-settings';
import {
  resolveGraphics, selectOverall, withGraphicsValue, type GraphicsSelection,
} from '../../render/graphics-selection';
import { Pulldown, SegmentedControl, Slider, ToggleSwitch, buildLabeledRow, type PulldownColumn } from '../widgets';
import { MQ_COMPACT } from '../breakpoints';
import { injectOnce } from '../inject-style';

// このパネル自身の CSS。余白を持つ規則は `#hud` を冠した枝を併記する — HUD は `#hud, #hud *` で
// margin/padding を 0 へ落としており、素のクラス 1 つでは詳細度で負けて群の間隔が潰れる。
const STYLE = `
.gp-body, #hud .gp-body {
  display: grid; grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-4) var(--space-5); min-width: 0;
}
.gp-body > .w-group { grid-column: 1 / -1; min-width: 0; }
.gp-group, #hud .gp-group {
  display: grid; grid-template-columns: repeat(2, minmax(0, 1fr));
  column-gap: var(--space-3); row-gap: var(--space-3);
  align-items: start; min-width: 0;
}
.gp-group-title { grid-column: 1 / -1;
  margin: 0; color: var(--color-primary); font-size: var(--font-xxs); letter-spacing: 0.12em;
}
.gp-group > .w-group, .gp-group > .w-toggle { min-width: 0; width: 100%; }
.gp-group > .w-toggle { justify-content: space-between; }
.gp-group > .w-group .w-group-title { flex: 1 1 0; min-width: 0; }
.gp-group > .w-group .w-select { min-width: 0; max-width: 100%; }
.gp-group > .w-group .w-btn { min-width: 0; }
@media ${MQ_COMPACT} {
  .gp-body, #hud .gp-body { grid-template-columns: 1fr; }
  .gp-group, #hud .gp-group { grid-template-columns: 1fr; }
  .gp-group > .w-group .w-group-title { flex: 0 0 100%; }
}
`;

const PRESET_ITEMS: readonly (readonly [QualityPreset, string])[] = [
  ['low', '低'], ['medium', '中'], ['high', '高'],
];

// 表示する要素と好みの群の見出し。
const ELEMENTS_TITLE = '表示する要素';
const PREFERENCES_TITLE = '好み';

// hidden の既定。全項目を並べる。
const NO_HIDDEN_KEYS: ReadonlySet<GraphicsKey> = new Set();

// プルダウンで選ぶ項目の列。描画設定の項目はどれも1列しか持たない。
type SelectColumns = readonly [PulldownColumn<ChoiceValue>];

// 項目1つぶんのコントロール。show に現在値を渡すと点灯を引き直す。
interface ValueControl {
  readonly key: GraphicsKey;
  readonly show: (value: boolean | ChoiceValue) => void;
}

// 群 1 つに並べる行。knob が null なら、分野の有無を切り替える真偽の行。
interface Row {
  readonly key: GraphicsKey;
  readonly label: string;
  readonly knob: GraphicsKnob | GraphicsPreference | null;
}

export class GraphicsPanel {
  public readonly element: HTMLElement;

  // 操作で新しい選び方ができたときに呼ばれる。
  public onChange: ((selection: GraphicsSelection) => void) | null = null;

  private readonly preset: SegmentedControl<QualityPreset>;
  private readonly controls: readonly ValueControl[];

  // selection は組み立て時に点灯させる選び方。hidden は伏せる項目(この置き場では切り替えても
  // 効かないもの)で、項目の無くなった群は見出しごと消える。
  public constructor(
    private selection: GraphicsSelection,
    hidden: ReadonlySet<GraphicsKey> = NO_HIDDEN_KEYS,
  ) {
    injectOnce('graphics-panel', STYLE);
    this.element = document.createElement('div');
    this.element.className = 'gp-body';

    this.preset = new SegmentedControl('品質プリセット', PRESET_ITEMS, (preset) => {
      this.select(selectOverall(this.selection, preset));
    });
    this.element.appendChild(this.preset.element);

    // 分野ごとに有無とノブを、続けて表示する要素と好みを並べる。伏せた結果空になった群は見出しごと省く。
    const controls: ValueControl[] = [];
    for (const field of graphicsFieldKeys()) {
      const def = GRAPHICS_FIELDS[field];
      const rows: Row[] = def.enabled === null ? [] : [{ key: def.enabled, label: def.label, knob: null }];
      for (const key of fieldKnobKeys(field)) {
        const knob = fieldKnob(field, key)!;
        rows.push({ key, label: knob.label, knob });
      }
      controls.push(...this.addSection(def.label, rows, hidden));
    }
    controls.push(...this.addSection(ELEMENTS_TITLE, graphicsElementKeys().map((key) => {
      const knob = GRAPHICS_ELEMENTS[key];
      return { key, label: knob.label, knob };
    }), hidden));
    controls.push(...this.addSection(PREFERENCES_TITLE, graphicsPreferenceKeys().map((key) => {
      const knob = GRAPHICS_PREFERENCES[key];
      return { key, label: knob.label, knob };
    }), hidden));
    this.controls = controls;

    // 引き直す先が揃ってから点灯させる。
    this.sync(selection);
  }

  // 外から選び方が変わったときに、全コントロールの点灯を引き直す。全体のプリセットは、全体が
  // カスタムなら全消灯。
  public sync(selection: GraphicsSelection): void {
    this.selection = selection;
    this.preset.setSelected(typeof selection.quality === 'string' ? selection.quality : null);
    const graphics = resolveGraphics(selection);
    for (const control of this.controls) control.show(graphics[control.key]);
  }

  // 見出し title と rows の行を 1 つの群に組んで並べ、その群のコントロールを返す。hidden の行は省き、
  // 行が無くなれば群ごと省く。
  private addSection(title: string, rows: readonly Row[], hidden: ReadonlySet<GraphicsKey>): ValueControl[] {
    const shown = rows.filter((row) => !hidden.has(row.key));
    if (shown.length === 0) return [];
    // 群の器と見出し。
    const section = document.createElement('div');
    section.className = 'gp-group';
    const heading = document.createElement('h4');
    heading.className = 'gp-group-title';
    heading.textContent = title;
    section.appendChild(heading);
    this.element.appendChild(section);
    // 行ごとのコントロール。
    return shown.map((row) => (
      row.knob === null ? this.addToggle(section, row.key, row.label) : this.addControl(section, row.key, row.knob)
    ));
  }

  // 真偽の行を section へ並べる。
  private addToggle(section: HTMLElement, key: GraphicsKey, label: string): ValueControl {
    const widget = new ToggleSwitch(label, (on) => this.write(key, on));
    section.appendChild(widget.element);
    return { key, show: (value) => widget.setOn(value === true) };
  }

  // 項目1つぶんのコントロールを、表の kind に応じた部品で組んで section へ並べる。2 候補の choice は
  // items[1] をオンとするトグルで出す。
  private addControl(section: HTMLElement, key: GraphicsKey, knob: GraphicsKnob | GraphicsPreference): ValueControl {
    if (knob.kind === 'toggle') return this.addToggle(section, key, knob.label);
    if (knob.kind === 'slider') {
      const row = buildLabeledRow(knob.label);
      const widget = new Slider({ min: knob.min, max: knob.max, step: knob.step }, (value) => this.write(key, value));
      row.appendChild(widget.element);
      section.appendChild(row);
      return { key, show: (value) => { if (typeof value === 'number') widget.setValue(value); } };
    }
    // 見比べながら選ぶものなので、反映ボタンを添えず選び直した時点で反映する。
    if (knob.kind === 'select') {
      const columns: SelectColumns = [{ items: knob.items }];
      const widget = new Pulldown(knob.label, columns, null, ([value]) => this.write(key, value));
      section.appendChild(widget.element);
      return { key, show: (value) => { if (typeof value !== 'boolean') widget.setSelected(0, value); } };
    }
    if (knob.items.length === 2) {
      const [off, on] = [knob.items[0]![0], knob.items[1]![0]];
      const widget = new ToggleSwitch(knob.label, (isOn) => this.write(key, isOn ? on : off));
      section.appendChild(widget.element);
      return { key, show: (value) => widget.setOn(value === on) };
    }
    const widget = new SegmentedControl<ChoiceValue>(knob.label, knob.items, (value) => this.write(key, value));
    section.appendChild(widget.element);
    return { key, show: (value) => widget.setSelected(typeof value === 'boolean' ? null : value) };
  }

  // 値を 1 つ書き換えた選び方へ移る。
  private write(key: GraphicsKey, value: boolean | ChoiceValue): void {
    this.select(withGraphicsValue(this.selection, key, value));
  }

  // 選ばれた選び方へ移る。自分の点灯を引き直してから外へ返す。
  private select(selection: GraphicsSelection): void {
    this.sync(selection);
    this.onChange?.(selection);
  }
}
