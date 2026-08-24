// 表示パネル(マップモード左レール)の軌道ガイドタブ。静止軌道・ハロー軌道・平面リヤプノフ・
// 垂直リヤプノフ・リサジュー・DRO の6区画を持ち、区画ごとに見出し(表示トグル)・軸トグル
// (系/点/南北。種類ごとに独立)・値(スライダー+数値入力)を並べる。状態の正本は持たず、
// 操作のたびに現在の鏡映しから次の OrbitGuideSettings を組んで onSettingsChange へ渡す。
import { Button, Slider, ValueInput } from '../widgets';
import {
  AmplitudeGuide,
  DroGuide,
  HaloGuide,
  LissajousGuide,
  DEFAULT_ORBIT_GUIDE_SETTINGS,
  OrbitGuideSettings,
} from '../../celestial/orbit-guide-settings';

// 振幅スライダーの代表域。妥当な振幅は系・ラグランジュ点ごとに桁で異なるので、系に依らない
// 広い区間を対数で割り当てる。
const AMPLITUDE_MIN_M = 1_000_000;
const AMPLITUDE_MAX_M = 200_000_000;
const AMPLITUDE_SLIDER_STEPS = 1000;

function metersToKm(m: number): number {
  return m / 1000;
}
function kmToMeters(km: number): number {
  return km * 1000;
}
function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
function amplitudeSliderToMeters(raw: number): number {
  const ratio = AMPLITUDE_MAX_M / AMPLITUDE_MIN_M;
  return AMPLITUDE_MIN_M * Math.pow(ratio, raw / AMPLITUDE_SLIDER_STEPS);
}
function metersToAmplitudeSlider(m: number): number {
  const ratio = AMPLITUDE_MAX_M / AMPLITUDE_MIN_M;
  const clamped = Math.max(AMPLITUDE_MIN_M, Math.min(AMPLITUDE_MAX_M, m));
  return Math.round((Math.log(clamped / AMPLITUDE_MIN_M) / Math.log(ratio)) * AMPLITUDE_SLIDER_STEPS);
}

// スライダー+数値入力1組ぶんの値⇔つまみ位置の写像と表示書式。0〜1 の族範囲・対数の振幅の
// どちらもこの1つの形で表す。
interface ValueMapping {
  readonly sliderMin: number;
  readonly sliderMax: number;
  readonly sliderStep: number;
  readonly toSlider: (value: number) => number;
  readonly fromSlider: (raw: number) => number;
  readonly format: (value: number) => string;
  readonly parse: (text: string) => number;
  readonly inputMin: number;
  readonly inputMax: number;
  readonly inputStep: number;
  readonly unit?: string;
}

const RANGE_MAPPING: ValueMapping = {
  sliderMin: 0, sliderMax: 100, sliderStep: 1,
  toSlider: (v) => Math.round(v * 100),
  fromSlider: (raw) => raw / 100,
  format: (v) => v.toFixed(2),
  parse: (text) => clamp01(Number(text)),
  inputMin: 0, inputMax: 1, inputStep: 0.01,
};

const AMPLITUDE_MAPPING: ValueMapping = {
  sliderMin: 0, sliderMax: AMPLITUDE_SLIDER_STEPS, sliderStep: 1,
  toSlider: metersToAmplitudeSlider,
  fromSlider: amplitudeSliderToMeters,
  format: (m) => metersToKm(m).toFixed(0),
  parse: (text) => kmToMeters(Math.max(metersToKm(AMPLITUDE_MIN_M), Math.min(metersToKm(AMPLITUDE_MAX_M), Number(text)))),
  inputMin: metersToKm(AMPLITUDE_MIN_M), inputMax: metersToKm(AMPLITUDE_MAX_M), inputStep: 100,
  unit: 'km',
};

interface ValueField {
  readonly row: HTMLElement;
  readonly slider: Slider;
  readonly input: ValueInput;
}

// mapping に従うスライダー+数値入力欄を1行分組む。onCommit はどちらの操作からも値の形
// (0〜1 または振幅メートル)で呼ばれる。
function buildValueField(label: string, mapping: ValueMapping, onCommit: (value: number) => void): ValueField {
  const row = document.createElement('div');
  row.className = 'w-group orbit-guide-value-row';
  const heading = document.createElement('span');
  heading.className = 'w-group-title';
  heading.textContent = label;
  row.appendChild(heading);

  const sliderCol = document.createElement('div');
  sliderCol.className = 'slider-col';
  row.appendChild(sliderCol);

  // スライダーは掴んでいる間ずっと、数値入力欄は Enter/blur で確定したときだけ commit する。
  const slider = new Slider({ min: mapping.sliderMin, max: mapping.sliderMax, step: mapping.sliderStep }, (raw) => {
    const value = mapping.fromSlider(raw);
    input.setValue(mapping.format(value));
    onCommit(value);
  });
  sliderCol.appendChild(slider.element);

  const input = new ValueInput({
    type: 'number', min: mapping.inputMin, max: mapping.inputMax, step: mapping.inputStep,
  }, (text) => {
    const value = mapping.parse(text);
    slider.setValue(mapping.toSlider(value));
    input.setValue(mapping.format(value));
    onCommit(value);
  });
  row.appendChild(input.element);

  if (mapping.unit !== undefined) {
    const unit = document.createElement('span');
    unit.className = 'orbit-guide-value-unit';
    unit.textContent = mapping.unit;
    row.appendChild(unit);
  }

  return { row, slider, input };
}

// スライダーと数値入力を value へ揃える。打鍵中の欄は確定前の文字を壊さないよう触らない。
function syncValueField(field: ValueField, mapping: ValueMapping, value: number): void {
  if (document.activeElement !== field.input.element) field.input.setValue(mapping.format(value));
  field.slider.setValue(mapping.toSlider(value));
}

// 見出し + 独立ボタン列の1行(系・点・南北)。同じ軸上の排他選択ではなく、それぞれ独立に
// ON/OFF できるため SegmentedControl ではなく Button を並べる。
function buildToggleRow(parent: HTMLElement, label: string): HTMLElement {
  const row = document.createElement('div');
  row.className = 'w-group orbit-guide-toggle-row';
  const heading = document.createElement('span');
  heading.className = 'w-group-title';
  heading.textContent = label;
  row.appendChild(heading);
  parent.appendChild(row);
  return row;
}

function withHalo(s: OrbitGuideSettings, patch: Partial<HaloGuide>): OrbitGuideSettings {
  return { ...s, halo: { ...s.halo, ...patch } };
}
function withPlanar(s: OrbitGuideSettings, patch: Partial<AmplitudeGuide>): OrbitGuideSettings {
  return { ...s, planarLyapunov: { ...s.planarLyapunov, ...patch } };
}
function withVertical(s: OrbitGuideSettings, patch: Partial<AmplitudeGuide>): OrbitGuideSettings {
  return { ...s, verticalLyapunov: { ...s.verticalLyapunov, ...patch } };
}
function withLissajous(s: OrbitGuideSettings, patch: Partial<LissajousGuide>): OrbitGuideSettings {
  return { ...s, lissajous: { ...s.lissajous, ...patch } };
}
function withDro(s: OrbitGuideSettings, patch: Partial<DroGuide>): OrbitGuideSettings {
  return { ...s, dro: { ...s.dro, ...patch } };
}

interface BooleanControl {
  readonly button: Button;
  readonly get: (s: OrbitGuideSettings) => boolean;
}
interface ValueControl {
  readonly field: ValueField;
  readonly mapping: ValueMapping;
  readonly get: (s: OrbitGuideSettings) => number;
}
interface Section {
  readonly root: HTMLElement;
  readonly isOn: (s: OrbitGuideSettings) => boolean;
}

export class OrbitGuideTab {
  public readonly element: HTMLElement;
  public onSettingsChange: ((settings: OrbitGuideSettings) => void) | null = null;

  private current: OrbitGuideSettings = DEFAULT_ORBIT_GUIDE_SETTINGS;
  private readonly booleanControls: BooleanControl[] = [];
  private readonly valueControls: ValueControl[] = [];
  private readonly sections: Section[] = [];

  private rangeMinField!: ValueField;
  private rangeMaxField!: ValueField;

  // SPEC §5.2 の6区画(静止軌道・ハロー・平面/垂直リヤプノフ・リサジュー・DRO)を
  // その種類が持つ軸(系/点/南北)と値だけで順に組む。
  public constructor() {
    this.element = document.createElement('div');
    this.element.className = 'orbit-guide-tab';

    this.buildSection('静止軌道', (s) => s.geostationary, (s, on) => ({ ...s, geostationary: on }), () => {});

    this.buildSection('ハロー軌道', (s) => s.halo.on, (s, on) => withHalo(s, { on }), (section) => {
      this.buildSystemRow(section, (s) => s.halo, withHalo);
      this.buildPointRow(section, (s) => s.halo, withHalo);
      const northSouthRow = buildToggleRow(section, '南北');
      this.buildBooleanToggle(northSouthRow, '北側', '北側のガイドを表示', (s) => s.halo.north, (s, on) => withHalo(s, { north: on }));
      this.buildBooleanToggle(northSouthRow, '南側', '南側のガイドを表示', (s) => s.halo.south, (s, on) => withHalo(s, { south: on }));

      this.rangeMinField = buildValueField('族の下限', RANGE_MAPPING, (v) => this.commitHaloRange(v, this.current.halo.rangeMax));
      section.appendChild(this.rangeMinField.row);
      this.valueControls.push({ field: this.rangeMinField, mapping: RANGE_MAPPING, get: (s) => s.halo.rangeMin });
      this.rangeMaxField = buildValueField('族の上限', RANGE_MAPPING, (v) => this.commitHaloRange(this.current.halo.rangeMin, v));
      section.appendChild(this.rangeMaxField.row);
      this.valueControls.push({ field: this.rangeMaxField, mapping: RANGE_MAPPING, get: (s) => s.halo.rangeMax });
    });

    this.buildSection('平面リヤプノフ軌道', (s) => s.planarLyapunov.on, (s, on) => withPlanar(s, { on }), (section) => {
      this.buildSystemRow(section, (s) => s.planarLyapunov, withPlanar);
      this.buildPointRow(section, (s) => s.planarLyapunov, withPlanar);
      this.buildValueControl(section, '面内振幅', AMPLITUDE_MAPPING, (s) => s.planarLyapunov.amplitude, (s, v) => withPlanar(s, { amplitude: v }));
    });

    this.buildSection('垂直リヤプノフ軌道', (s) => s.verticalLyapunov.on, (s, on) => withVertical(s, { on }), (section) => {
      this.buildSystemRow(section, (s) => s.verticalLyapunov, withVertical);
      this.buildPointRow(section, (s) => s.verticalLyapunov, withVertical);
      this.buildValueControl(section, '面外振幅', AMPLITUDE_MAPPING, (s) => s.verticalLyapunov.amplitude, (s, v) => withVertical(s, { amplitude: v }));
    });

    this.buildSection('リサジュー軌道', (s) => s.lissajous.on, (s, on) => withLissajous(s, { on }), (section) => {
      this.buildSystemRow(section, (s) => s.lissajous, withLissajous);
      this.buildPointRow(section, (s) => s.lissajous, withLissajous);
      this.buildValueControl(section, '面内振幅', AMPLITUDE_MAPPING, (s) => s.lissajous.inPlane, (s, v) => withLissajous(s, { inPlane: v }));
      this.buildValueControl(section, '面外振幅', AMPLITUDE_MAPPING, (s) => s.lissajous.outOfPlane, (s, v) => withLissajous(s, { outOfPlane: v }));
    });

    this.buildSection('遠距離逆行軌道(DRO)', (s) => s.dro.on, (s, on) => withDro(s, { on }), (section) => {
      this.buildSystemRow(section, (s) => s.dro, withDro);
      this.buildValueControl(section, '軌道半径', AMPLITUDE_MAPPING, (s) => s.dro.amplitude, (s, v) => withDro(s, { amplitude: v }));
    });
  }

  // 種類1区画ぶんの見出し(表示トグル)を組み、build に軸行・値行を積ませる。見出しが
  // OFF の間は区画全体を淡色化する(category-off、操作は無効にしない)。
  private buildSection(
    label: string,
    getOn: (s: OrbitGuideSettings) => boolean,
    withOn: (s: OrbitGuideSettings, on: boolean) => OrbitGuideSettings,
    build: (section: HTMLElement) => void,
  ): void {
    const section = document.createElement('div');
    section.className = 'orbit-guide-section';
    const headingRow = document.createElement('div');
    headingRow.className = 'orbit-guide-heading';
    const headingButton = this.buildBooleanToggle(headingRow, label, `${label}を表示`, getOn, withOn);
    headingButton.element.classList.add('orbit-guide-heading-btn');
    section.appendChild(headingRow);
    build(section);
    this.element.appendChild(section);
    this.sections.push({ root: section, isOn: getOn });
  }

  // 系(地球系/月系)の独立トグル行。ハロー・平面/垂直リヤプノフ・リサジュー・DRO が持つ。
  private buildSystemRow(
    parent: HTMLElement,
    getAxes: (s: OrbitGuideSettings) => { readonly sunEarth: boolean; readonly earthMoon: boolean },
    withAxes: (s: OrbitGuideSettings, patch: { sunEarth?: boolean; earthMoon?: boolean }) => OrbitGuideSettings,
  ): void {
    const row = buildToggleRow(parent, '系');
    this.buildBooleanToggle(row, '地球系', '地球系(太陽-地球)のガイドを表示', (s) => getAxes(s).sunEarth, (s, on) => withAxes(s, { sunEarth: on }));
    this.buildBooleanToggle(row, '月系', '月系(地球-月)のガイドを表示', (s) => getAxes(s).earthMoon, (s, on) => withAxes(s, { earthMoon: on }));
  }

  // ラグランジュ点(L1/L2/L3)の独立トグル行。ハロー・平面/垂直リヤプノフ・リサジューが持つ。
  private buildPointRow(
    parent: HTMLElement,
    getAxes: (s: OrbitGuideSettings) => { readonly l1: boolean; readonly l2: boolean; readonly l3: boolean },
    withAxes: (s: OrbitGuideSettings, patch: { l1?: boolean; l2?: boolean; l3?: boolean }) => OrbitGuideSettings,
  ): void {
    const row = buildToggleRow(parent, '点');
    this.buildBooleanToggle(row, 'L1', 'L1のガイドを表示', (s) => getAxes(s).l1, (s, on) => withAxes(s, { l1: on }));
    this.buildBooleanToggle(row, 'L2', 'L2のガイドを表示', (s) => getAxes(s).l2, (s, on) => withAxes(s, { l2: on }));
    this.buildBooleanToggle(row, 'L3', 'L3のガイドを表示', (s) => getAxes(s).l3, (s, on) => withAxes(s, { l3: on }));
  }

  // クリックのたびに反転する独立トグルボタンを row へ組み込む。get は反転元として読む現在値、
  // withOn が組んだ次の設定をそのまま commit する。
  private buildBooleanToggle(
    row: HTMLElement, label: string, desc: string,
    get: (s: OrbitGuideSettings) => boolean,
    withOn: (s: OrbitGuideSettings, on: boolean) => OrbitGuideSettings,
  ): Button {
    const btn = new Button(label, () => {
      const next = !get(this.current);
      btn.setOn(next);
      this.commit(withOn(this.current, next));
    });
    btn.element.title = desc;
    btn.element.setAttribute('aria-label', desc);
    row.appendChild(btn.element);
    this.booleanControls.push({ button: btn, get });
    return btn;
  }

  // スライダー+数値入力の1行を parent へ組み込み、確定のたびに withValue で次の設定を commit する。
  private buildValueControl(
    parent: HTMLElement, label: string, mapping: ValueMapping,
    get: (s: OrbitGuideSettings) => number,
    withValue: (s: OrbitGuideSettings, value: number) => OrbitGuideSettings,
  ): ValueField {
    const field = buildValueField(label, mapping, (value) => this.commit(withValue(this.current, value)));
    parent.appendChild(field.row);
    this.valueControls.push({ field, mapping, get });
    return field;
  }

  // 下限・上限どちらの操作からも呼ばれ、min>max の入れ替えを一箇所へ集約する。
  private commitHaloRange(min: number, max: number): void {
    const rangeMin = Math.min(min, max);
    const rangeMax = Math.max(min, max);
    this.commit(withHalo(this.current, { rangeMin, rangeMax }));
    syncValueField(this.rangeMinField, RANGE_MAPPING, rangeMin);
    syncValueField(this.rangeMaxField, RANGE_MAPPING, rangeMax);
  }

  // 正本を差し替え、区画の淡色化を更新して呼び出し側へ通知する。
  private commit(next: OrbitGuideSettings): void {
    this.current = next;
    this.updateDim();
    this.onSettingsChange?.(this.current);
  }

  private updateDim(): void {
    for (const section of this.sections) section.root.classList.toggle('category-off', !section.isOn(this.current));
  }

  // 正本からの鏡映し反映。編集中の入力欄は打鍵中の値を壊さないよう上書きしない。
  public setSettings(settings: OrbitGuideSettings): void {
    this.current = settings;
    for (const control of this.booleanControls) control.button.setOn(control.get(settings));
    for (const control of this.valueControls) syncValueField(control.field, control.mapping, control.get(settings));
    this.updateDim();
  }
}
