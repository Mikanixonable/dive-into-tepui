// 描画の品質設定の選び方。全体のプリセット → 分野のプリセット → 分野の詳細の値の 3 層で選んだものを持ち、
// それを描画側が読む平らな値一式へ解く純関数とその逆(平らな値一式と同じ絵になる選び方を当てる純関数)、
// 層ごとの選択を移す操作、値を 1 つ書き換える操作、保存文字列との変換を持つ。

import {
  GRAPHICS_ELEMENTS, GRAPHICS_FIELDS, GRAPHICS_PREFERENCES, OVERALL_FIELD_PRESETS,
  elementPresetValues, fieldKnob, fieldKnobKeys, fieldPresetValues, graphicsElementKeys, graphicsFieldKeys,
  graphicsPreferenceKeys, initialPreferenceValues,
  type ChoiceValue, type FieldKnobValues, type FieldPreset, type GraphicsElementKey, type GraphicsElementValues,
  type GraphicsFieldKey, type GraphicsKey, type GraphicsKnob, type GraphicsPreference, type GraphicsPreferenceKey,
  type GraphicsPreferenceValues, type GraphicsSettingsData, type QualityPreset,
} from './graphics-settings';

// 分野 1 つの選び方。プリセットの名前(消せる分野ではオフも)か、詳細の値一式を持つカスタム。F が分野の union
// なら、分野ごとの選び方の union。
export type FieldSelection<F extends GraphicsFieldKey> =
  F extends unknown ? FieldPreset<F> | { readonly custom: FieldKnobValues<F> } : never;
export type FieldSelections = { readonly [F in GraphicsFieldKey]: FieldSelection<F> };

// 全体がカスタムのときの選び方。分野ごとの選択と、表示する要素の値。
export interface CustomGraphics {
  readonly fields: FieldSelections;
  readonly elements: GraphicsElementValues;
}

export interface GraphicsSelection {
  readonly quality: QualityPreset | CustomGraphics;
  readonly preferences: GraphicsPreferenceValues;
}

// 保存が無いときの選び方。
export const DEFAULT_GRAPHICS_SELECTION: GraphicsSelection = { quality: 'high', preferences: initialPreferenceValues() };

// 分野がオフのあいだ、平らな値一式でそのノブに入れるプリセット。オフからカスタムへ移ったときに始める値でもある。
const OFF_FIELD_PRESET: QualityPreset = 'medium';

// 分野 field の選び方 choice のノブの値一式。プリセットなら表の値、オフなら OFF_FIELD_PRESET の値。
function fieldValuesOf(
  field: GraphicsFieldKey, choice: FieldSelection<GraphicsFieldKey>,
): Readonly<Record<string, boolean | ChoiceValue>> {
  if (typeof choice !== 'string') return choice.custom;
  return fieldPresetValues(field, choice === 'off' ? OFF_FIELD_PRESET : choice);
}

// 分野 field のノブの値一式 values を持つカスタム。values はその分野のノブのキーで組まれているので、as での
// 断定は安全。
function customFieldOf(
  values: Readonly<Record<string, boolean | ChoiceValue>>,
): FieldSelection<GraphicsFieldKey> {
  return { custom: values } as FieldSelection<GraphicsFieldKey>;
}

// 選び方を、描画側が読む平らな値一式へ解く。全体のプリセットは表で分野の選択へ、分野のプリセットはノブの
// presets へ、カスタムはその値へ解く。オフの分野は有無を偽にし、ノブは OFF_FIELD_PRESET の値にする。
// GraphicsSettingsData は表から導いた型なので、as での断定は安全。
export function resolveGraphics(selection: GraphicsSelection): GraphicsSettingsData {
  // 全体の選択を、分野ごとの選択と表示する要素の値へ開く。
  const quality = selection.quality;
  const fields = fieldSelectionsOf(selection);
  const elements = typeof quality === 'string' ? elementPresetValues(quality) : quality.elements;
  // 分野ごとに有無とノブを並べ、表示する要素と好みを続ける。
  const entries: (readonly [string, boolean | ChoiceValue])[] = [];
  for (const field of graphicsFieldKeys()) {
    const choice = fields[field];
    const enabled = GRAPHICS_FIELDS[field].enabled;
    if (enabled !== null) entries.push([enabled, choice !== 'off']);
    entries.push(...Object.entries(fieldValuesOf(field, choice)));
  }
  entries.push(...Object.entries(elements), ...Object.entries(selection.preferences));
  return Object.fromEntries(entries) as GraphicsSettingsData;
}

// 保存が無いときの選び方を解いた値一式。
export const DEFAULT_GRAPHICS: GraphicsSettingsData = resolveGraphics(DEFAULT_GRAPHICS_SELECTION);

// 全体のプリセット preset が選んでいるものから始めるカスタム。
function customOf(preset: QualityPreset): CustomGraphics {
  return { fields: OVERALL_FIELD_PRESETS[preset], elements: elementPresetValues(preset) };
}

// selection の全体をカスタムにしたもの。既にカスタムならそのまま。
function customQualityOf(selection: GraphicsSelection): CustomGraphics {
  return typeof selection.quality === 'string' ? customOf(selection.quality) : selection.quality;
}

// selection が各分野で選んでいるもの。全体がプリセットなら、そのプリセットが表で選ぶもの。
function fieldSelectionsOf(selection: GraphicsSelection): FieldSelections {
  return typeof selection.quality === 'string' ? OVERALL_FIELD_PRESETS[selection.quality] : selection.quality.fields;
}

// 全体の選択を choice へ移す。低 / 中 / 高へ移ると分野の選択は捨てる。カスタムへ移ると直前の全体のプリセットが
// 選んでいたものから始め、既にカスタムなら変えない。好みは変えない。
export function selectOverall(selection: GraphicsSelection, choice: QualityPreset | 'custom'): GraphicsSelection {
  if (choice === 'custom') {
    return typeof selection.quality === 'string' ? { ...selection, quality: customOf(selection.quality) } : selection;
  }
  return selection.quality === choice ? selection : { ...selection, quality: choice };
}

// 分野 field の選択を next に差し替えた選び方。FieldSelections は分野ごとに型が違うので、計算した
// キーで差し替えた結果は as で断定する — field と next の組は呼び手が合わせている。
function withFieldSelection(
  selection: GraphicsSelection, quality: CustomGraphics, field: GraphicsFieldKey,
  next: FieldSelection<GraphicsFieldKey>,
): GraphicsSelection {
  return { ...selection, quality: { ...quality, fields: { ...quality.fields, [field]: next } as FieldSelections } };
}

// 分野 field の選択を choice へ移す。必要なら先に全体をカスタムへ移す。カスタムへ移ると直前のプリセットの値を
// 写し、オフからなら OFF_FIELD_PRESET の値から始め、既にカスタムなら変えない。プリセットへ移ると調整は捨てる。
// 消せない分野へのオフは無視する。
export function selectField(
  selection: GraphicsSelection, field: GraphicsFieldKey, choice: 'off' | QualityPreset | 'custom',
): GraphicsSelection {
  if (choice === 'off' && GRAPHICS_FIELDS[field].enabled === null) return selection;
  const quality = customQualityOf(selection);
  const current = quality.fields[field];
  if (choice === 'custom') {
    if (typeof current !== 'string') return quality === selection.quality ? selection : { ...selection, quality };
    return withFieldSelection(selection, quality, field, customFieldOf(fieldValuesOf(field, current)));
  }
  if (current === choice) return quality === selection.quality ? selection : { ...selection, quality };
  return withFieldSelection(selection, quality, field, choice);
}

// key が表示する要素のキーか。
function isElementKey(key: GraphicsKey): key is GraphicsElementKey {
  return key in GRAPHICS_ELEMENTS;
}

// key が好みのキーか。
function isPreferenceKey(key: GraphicsKey): key is GraphicsPreferenceKey {
  return key in GRAPHICS_PREFERENCES;
}

// 表の外から来た value を項目 knob が受け入れるか決める。真偽の項目は型だけ、候補から選ぶ項目は候補に
// 含まれるか、スライダーは範囲内の刻みに乗った整数かまで見て、外れていれば null。
function acceptedValue(knob: GraphicsKnob | GraphicsPreference, value: unknown): boolean | ChoiceValue | null {
  if (knob.kind === 'toggle') return typeof value === 'boolean' ? value : null;
  if (knob.kind === 'slider') {
    const accepted = typeof value === 'number' && Number.isInteger(value)
      && value >= knob.min && value <= knob.max && (value - knob.min) % knob.step === 0;
    return accepted ? value : null;
  }
  return knob.items.some(([candidate]) => candidate === value) ? value as ChoiceValue : null;
}

// 値を 1 つ書き換えた選び方。分野の有無なら偽はその分野をオフへ、真はオフのときだけカスタム(OFF_FIELD_PRESET の
// 値)へ。分野のノブならその分野をカスタムへ(写して)移してから書く。表示する要素なら全体をカスタムへ移してから
// 書く。好みはそのまま書く。**操作する UI は項目名を実行時に持つ**ので、キーと値の対応を型では結べない —
// 表の候補に含まれない値はここで捨て、選び方を変えない。
export function withGraphicsValue(
  selection: GraphicsSelection, key: GraphicsKey, value: boolean | ChoiceValue,
): GraphicsSelection {
  // 好みは全体の選択に触れない。
  if (isPreferenceKey(key)) {
    const accepted = acceptedValue(GRAPHICS_PREFERENCES[key], value);
    if (accepted === null) return selection;
    return { ...selection, preferences: { ...selection.preferences, [key]: accepted } };
  }
  // 表示する要素は全体をカスタムへ移して書く。
  if (isElementKey(key)) {
    const accepted = acceptedValue(GRAPHICS_ELEMENTS[key], value);
    if (accepted === null) return selection;
    const quality = customQualityOf(selection);
    return { ...selection, quality: { ...quality, elements: { ...quality.elements, [key]: accepted } } };
  }
  // 分野の有無とノブは、そのキーを持つ分野を探して書く。
  for (const field of graphicsFieldKeys()) {
    if (GRAPHICS_FIELDS[field].enabled === key) {
      if (typeof value !== 'boolean') return selection;
      if (!value) return selectField(selection, field, 'off');
      return fieldSelectionsOf(selection)[field] === 'off' ? selectField(selection, field, 'custom') : selection;
    }
    const knob = fieldKnob(field, key);
    if (knob === null) continue;
    const accepted = acceptedValue(knob, value);
    if (accepted === null) return selection;
    const quality = customQualityOf(selection);
    const custom = customFieldOf({ ...fieldValuesOf(field, quality.fields[field]), [key]: accepted });
    return withFieldSelection(selection, quality, field, custom);
  }
  return selection;
}

// 平らな値一式 data のうち、分野 field のノブの値。
function fieldValuesIn(
  field: GraphicsFieldKey, data: GraphicsSettingsData,
): Readonly<Record<string, boolean | ChoiceValue>> {
  return Object.fromEntries(fieldKnobKeys(field).map((key) => [key, data[key]]));
}

// a の全キーで b と値が同じか。
function sameValues(a: Readonly<Record<string, unknown>>, b: Readonly<Record<string, unknown>>): boolean {
  return Object.keys(a).every((key) => a[key] === b[key]);
}

// 2 つの値一式が同じ絵になるか。分野の有無と表示する要素が同じで、有る分野のノブが同じなら同じ絵。
function sameRendering(a: GraphicsSettingsData, b: GraphicsSettingsData): boolean {
  for (const field of graphicsFieldKeys()) {
    const enabled = GRAPHICS_FIELDS[field].enabled;
    if (enabled !== null) {
      if (a[enabled] !== b[enabled]) return false;
      if (!a[enabled]) continue;
    }
    if (!sameValues(fieldValuesIn(field, a), fieldValuesIn(field, b))) return false;
  }
  return graphicsElementKeys().every((key) => a[key] === b[key]);
}

const OVERALL_PRESETS: readonly QualityPreset[] = ['low', 'medium', 'high'];
// 分野のプリセットを当てる順。中と高が同じ値の分野ではどちらでも絵は同じ。
const FIELD_PRESETS: readonly QualityPreset[] = ['high', 'medium', 'low'];

// 値一式 data の分野 field と同じ絵になる分野の選び方。有無が偽ならオフ、プリセットと一致すればその名前、
// どれとも一致しなければカスタム。
function fieldSelectionOf(field: GraphicsFieldKey, data: GraphicsSettingsData): FieldSelection<GraphicsFieldKey> {
  const enabled = GRAPHICS_FIELDS[field].enabled;
  if (enabled !== null && !data[enabled]) return 'off';
  const values = fieldValuesIn(field, data);
  const preset = FIELD_PRESETS.find((candidate) => sameValues(values, fieldPresetValues(field, candidate)));
  return preset ?? customFieldOf(values);
}

// 値一式 data と同じ絵になる全体の選び方。全体のプリセットのどれかと同じ絵ならその名前、さもなくば分野ごとに
// 当てたカスタム。FieldSelections と GraphicsElementValues は表のキーで組むので、as での断定は安全。
function qualityOf(data: GraphicsSettingsData): QualityPreset | CustomGraphics {
  const overall = OVERALL_PRESETS.find((preset) => sameRendering(
    data, resolveGraphics({ quality: preset, preferences: DEFAULT_GRAPHICS_SELECTION.preferences })));
  if (overall !== undefined) return overall;
  return {
    fields: Object.fromEntries(
      graphicsFieldKeys().map((field) => [field, fieldSelectionOf(field, data)]),
    ) as FieldSelections,
    elements: Object.fromEntries(graphicsElementKeys().map((key) => [key, data[key]])) as GraphicsElementValues,
  };
}

// 平らな値一式 data のうち、好みの値。GraphicsPreferenceValues は表のキーで組むので、as での断定は安全。
function preferencesIn(data: GraphicsSettingsData): GraphicsPreferenceValues {
  return Object.fromEntries(graphicsPreferenceKeys().map((key) => [key, data[key]])) as GraphicsPreferenceValues;
}

// 平らな値一式 data と同じ絵になる選び方。全体のプリセットのどれかと同じ絵ならその名前、さもなくば分野ごとに
// プリセットを当てた全体カスタム。好みは data の値。
export function selectionOfGraphics(data: GraphicsSettingsData): GraphicsSelection {
  return { quality: qualityOf(data), preferences: preferencesIn(data) };
}

// 選び方を保存へ載せる文字列にする。
export function formatGraphicsSelection(selection: GraphicsSelection): string {
  return JSON.stringify(selection);
}

// value が保存値として重ねられるオブジェクトか。
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// value がプリセットの名前か。
function isQualityPreset(value: unknown): value is QualityPreset {
  return value === 'low' || value === 'medium' || value === 'high';
}

// 項目の表 knobs に並ぶキーを、保存値 saved から受け入れられる値で、受け入れられなければ fallbacks の値で埋める。
function acceptedValues(
  knobs: Readonly<Record<string, GraphicsKnob | GraphicsPreference>>, saved: Record<string, unknown>,
  fallbacks: Readonly<Record<string, boolean | ChoiceValue>>,
): Record<string, boolean | ChoiceValue> {
  return Object.fromEntries(
    Object.entries(knobs).map(([key, knob]) => [key, acceptedValue(knob, saved[key]) ?? fallbacks[key]!]),
  );
}

// 分野 field の保存された選択を読み直す。欠けていれば全体「高」が選ぶもの、カスタムでノブが欠けていれば
// その分野の「高」の値で埋める。
function parseFieldSelection(field: GraphicsFieldKey, saved: unknown): FieldSelection<GraphicsFieldKey> {
  const fallback = OVERALL_FIELD_PRESETS.high[field];
  if (isQualityPreset(saved)) return saved;
  if (saved === 'off') return GRAPHICS_FIELDS[field].enabled === null ? fallback : 'off';
  if (!isRecord(saved) || !isRecord(saved['custom'])) return fallback;
  return customFieldOf(acceptedValues(GRAPHICS_FIELDS[field].knobs, saved['custom'], fieldPresetValues(field, 'high')));
}

// 保存された全体の選択を読み直す。プリセットの名前でもカスタムでもなければ既定の全体のプリセット。
function parseQuality(saved: unknown): QualityPreset | CustomGraphics {
  if (isQualityPreset(saved)) return saved;
  if (!isRecord(saved)) return DEFAULT_GRAPHICS_SELECTION.quality;
  // カスタム。分野の選択と表示する要素をそれぞれ検証して埋める。
  const fields = isRecord(saved['fields']) ? saved['fields'] : {};
  const elements = isRecord(saved['elements']) ? saved['elements'] : {};
  return {
    fields: Object.fromEntries(
      graphicsFieldKeys().map((field) => [field, parseFieldSelection(field, fields[field])]),
    ) as FieldSelections,
    elements: acceptedValues(GRAPHICS_ELEMENTS, elements, elementPresetValues('high')) as GraphicsElementValues,
  };
}

// 保存された文字列を選び方へ読み直す。保存値は利用者がいつ書いたか分からないので、表に無いキーは読まず、
// 欠けた分野・候補外・範囲外の値は既定で埋め、壊れた文字列と null は保存が無いときの選び方にする。
export function parseGraphicsSelection(text: string | null): GraphicsSelection {
  if (text === null) return DEFAULT_GRAPHICS_SELECTION;
  try {
    const saved: unknown = JSON.parse(text);
    if (!isRecord(saved)) return DEFAULT_GRAPHICS_SELECTION;
    // 全体の選択と好みを別々に検証する。
    const preferences = isRecord(saved['preferences']) ? saved['preferences'] : {};
    return {
      quality: parseQuality(saved['quality']),
      preferences: acceptedValues(
        GRAPHICS_PREFERENCES, preferences, initialPreferenceValues(),
      ) as GraphicsPreferenceValues,
    };
  } catch {
    return DEFAULT_GRAPHICS_SELECTION;
  }
}
