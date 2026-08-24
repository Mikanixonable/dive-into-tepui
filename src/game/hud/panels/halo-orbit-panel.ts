// マップモード左レールの「ハロー軌道パネル」。表示パネルのハロー軌道行の開閉ボタンから
// 出し入れされ、系・ラグランジュ点・南北・族の範囲・発展ファミリー(平面/垂直リヤプノフ・
// リサジュー・DRO)の内訳を選ぶ。状態の正本は持たず、操作のたびに現在の鏡映しから次の
// HaloGuideSettings を組んで onSettingsChange へ渡す。
import {
  COLLAPSE_COLLAPSED_GLYPH,
  COLLAPSE_EXPANDED_GLYPH,
  buildCollapseToggle,
  hudRail,
  type CollapseToggleLabels,
} from '../hud-root';
import { Button, Slider, ToggleSwitch, ValueInput, syncCollapseToggle } from '../widgets';
import { loadPanelCollapsed, onPanelCollapsedViewChange, savePanelCollapsed } from '../panel-shell';
import {
  DEFAULT_HALO_GUIDE_SETTINGS,
  type FamilyToggle,
  type HaloGuideSettings,
  type LissajousToggle,
} from '../../celestial/halo-guide-settings';

const RANGE_STEP = 0.01;
// 振幅スライダーの代表域。実際に妥当な振幅は系・ラグランジュ点ごとに異なるが、パネル自体は
// それを知らないため、系に依らない代表域を対数マッピングで operate する。
const AMPLITUDE_MIN_M = 1_000_000;
const AMPLITUDE_MAX_M = 200_000_000;
const AMPLITUDE_SLIDER_STEPS = 1000;

// 振幅の数値入力欄は km 表示、正本(HaloGuideSettings)はメートルで持つ。
function metersToKm(m: number): number {
  return m / 1000;
}

function kmToMeters(km: number): number {
  return km * 1000;
}

// スライダーのつまみ位置(0..AMPLITUDE_SLIDER_STEPS)を対数区間 [AMPLITUDE_MIN_M, AMPLITUDE_MAX_M]
// の振幅値へ換算する。
function amplitudeSliderToMeters(raw: number): number {
  const ratio = AMPLITUDE_MAX_M / AMPLITUDE_MIN_M;
  return AMPLITUDE_MIN_M * Math.pow(ratio, raw / AMPLITUDE_SLIDER_STEPS);
}

// amplitudeSliderToMeters の逆変換。範囲外の値はスライダーの両端へ丸める。
function metersToAmplitudeSlider(m: number): number {
  const ratio = AMPLITUDE_MAX_M / AMPLITUDE_MIN_M;
  const clamped = Math.max(AMPLITUDE_MIN_M, Math.min(AMPLITUDE_MAX_M, m));
  return Math.round((Math.log(clamped / AMPLITUDE_MIN_M) / Math.log(ratio)) * AMPLITUDE_SLIDER_STEPS);
}

// 見出し + 独立ボタン列の1行(系・点・南北)。同じ軸上の排他選択ではなく、それぞれ独立に
// ON/OFF できるため SegmentedControl ではなく Button を並べる。
function buildToggleRow(parent: HTMLElement, label: string): HTMLElement {
  const row = document.createElement('div');
  row.className = 'w-group halo-toggle-row';
  const heading = document.createElement('span');
  heading.className = 'w-group-title';
  heading.textContent = label;
  row.appendChild(heading);
  parent.appendChild(row);
  return row;
}

interface RangeField {
  readonly row: HTMLElement;
  readonly slider: Slider;
  readonly input: ValueInput;
}

interface AmplitudeField {
  readonly row: HTMLElement;
  readonly slider: Slider;
  readonly input: ValueInput;
}

interface FamilyRow {
  readonly row: HTMLElement;
  readonly toggle: ToggleSwitch;
  readonly amplitude: AmplitudeField;
}

interface LissajousRow {
  readonly row: HTMLElement;
  readonly toggle: ToggleSwitch;
  readonly inPlane: AmplitudeField;
  readonly outOfPlane: AmplitudeField;
}

const ADVANCED_COLLAPSE_LABELS: CollapseToggleLabels = {
  expandedGlyph: COLLAPSE_EXPANDED_GLYPH,
  collapsedGlyph: COLLAPSE_COLLAPSED_GLYPH,
  expandedTitle: '発展的な設定を閉じる',
  collapsedTitle: '発展的な設定を開く',
};

export class HaloOrbitPanel {
  public onSettingsChange: ((settings: HaloGuideSettings) => void) | null = null;

  private readonly panel: HTMLElement;
  private readonly unsubscribeCollapsedView: () => void;
  // 操作対象クラス外から与えられる正本(呼び出し側の HaloGuideSettings)の鏡映し。
  // 操作のたびにここから次の設定を組んで onSettingsChange へ渡す。
  private current: HaloGuideSettings = DEFAULT_HALO_GUIDE_SETTINGS;
  private visible = false;
  private open = false;

  private readonly sunEarthButton: Button;
  private readonly earthMoonButton: Button;
  private readonly l1Button: Button;
  private readonly l2Button: Button;
  private readonly l3Button: Button;
  private readonly northButton: Button;
  private readonly southButton: Button;
  private readonly rangeMinField: RangeField;
  private readonly rangeMaxField: RangeField;
  private readonly planarLyapunovRow: FamilyRow;
  private readonly verticalLyapunovRow: FamilyRow;
  private readonly lissajousRow: LissajousRow;
  private readonly droRow: FamilyRow;

  public constructor(root: HTMLElement) {
    this.panel = document.createElement('div');
    this.panel.id = 'hud-halo-orbit';
    this.panel.className = 'panel hidden';
    this.panel.addEventListener('pointerdown', (e) => e.stopPropagation());
    const title = document.createElement('h3');
    title.textContent = 'ハロー軌道';
    this.panel.appendChild(title);

    const systemRow = buildToggleRow(this.panel, '系');
    this.sunEarthButton = this.buildBooleanToggle(
      systemRow, '地球系', '地球系(太陽-地球)のガイドを表示', (s) => s.sunEarth, (s, on) => ({ ...s, sunEarth: on }),
    );
    this.earthMoonButton = this.buildBooleanToggle(
      systemRow, '月系', '月系(地球-月)のガイドを表示', (s) => s.earthMoon, (s, on) => ({ ...s, earthMoon: on }),
    );

    const pointRow = buildToggleRow(this.panel, '点');
    this.l1Button = this.buildBooleanToggle(pointRow, 'L1', 'L1のガイドを表示', (s) => s.l1, (s, on) => ({ ...s, l1: on }));
    this.l2Button = this.buildBooleanToggle(pointRow, 'L2', 'L2のガイドを表示', (s) => s.l2, (s, on) => ({ ...s, l2: on }));
    this.l3Button = this.buildBooleanToggle(pointRow, 'L3', 'L3のガイドを表示', (s) => s.l3, (s, on) => ({ ...s, l3: on }));

    const northSouthRow = buildToggleRow(this.panel, '南北');
    this.northButton = this.buildBooleanToggle(
      northSouthRow, '北側', '北側のガイドを表示', (s) => s.north, (s, on) => ({ ...s, north: on }),
    );
    this.southButton = this.buildBooleanToggle(
      northSouthRow, '南側', '南側のガイドを表示', (s) => s.south, (s, on) => ({ ...s, south: on }),
    );

    this.rangeMinField = this.buildRangeField('族の下限', (value) => this.commitRange(value, this.current.rangeMax));
    this.panel.appendChild(this.rangeMinField.row);
    this.rangeMaxField = this.buildRangeField('族の上限', (value) => this.commitRange(this.current.rangeMin, value));
    this.panel.appendChild(this.rangeMaxField.row);

    const advancedHead = document.createElement('div');
    advancedHead.className = 'halo-advanced-head';
    const advancedTitle = document.createElement('span');
    advancedTitle.className = 'w-group-title';
    advancedTitle.textContent = '発展的な設定';
    advancedHead.appendChild(advancedTitle);
    this.panel.appendChild(advancedHead);

    const advancedBody = document.createElement('div');
    advancedBody.className = 'halo-advanced-body';
    this.panel.appendChild(advancedBody);

    const advancedToggle = buildCollapseToggle(
      advancedHead, 'hud-halo-orbit-advanced-toggle', 'halo-advanced-toggle', advancedBody, ADVANCED_COLLAPSE_LABELS,
    );
    const applyAdvancedCollapsed = (): void => {
      const collapsed = loadPanelCollapsed('hud-halo-orbit-advanced') ?? true;
      advancedBody.classList.toggle('collapsed', collapsed);
      syncCollapseToggle(advancedToggle, advancedBody, ADVANCED_COLLAPSE_LABELS);
    };
    applyAdvancedCollapsed();
    this.unsubscribeCollapsedView = onPanelCollapsedViewChange(applyAdvancedCollapsed);
    advancedToggle.addEventListener('click', () => {
      savePanelCollapsed('hud-halo-orbit-advanced', advancedBody.classList.contains('collapsed'));
    });

    this.planarLyapunovRow = this.buildFamilyRow(
      advancedBody, '平面リヤプノフ軌道', '面内振幅', (s) => s.planarLyapunov, (s, family) => ({ ...s, planarLyapunov: family }),
    );
    this.verticalLyapunovRow = this.buildFamilyRow(
      advancedBody, '垂直リヤプノフ軌道', '面外振幅', (s) => s.verticalLyapunov, (s, family) => ({ ...s, verticalLyapunov: family }),
    );
    this.lissajousRow = this.buildLissajousRow(advancedBody);
    this.droRow = this.buildFamilyRow(
      advancedBody, '遠距離逆行軌道(DRO)', '軌道半径', (s) => s.dro, (s, family) => ({ ...s, dro: family }),
    );

    hudRail(root, 'left').appendChild(this.panel);
  }

  // クリックのたびに反転する独立トグルボタンを row へ組み込む。current は反転元として読む
  // 鏡映しで、withOn が組んだ次の設定をそのまま current へ書き戻して通知する。
  private buildBooleanToggle(
    row: HTMLElement, label: string, description: string,
    getOn: (settings: HaloGuideSettings) => boolean,
    withOn: (settings: HaloGuideSettings, on: boolean) => HaloGuideSettings,
  ): Button {
    const btn = new Button(label, () => {
      const next = !getOn(this.current);
      this.current = withOn(this.current, next);
      btn.setOn(next);
      this.onSettingsChange?.(this.current);
    });
    btn.element.title = description;
    btn.element.setAttribute('aria-label', description);
    row.appendChild(btn.element);
    return btn;
  }

  // 0..1 の範囲入力(族の下限・上限)。スライダーは0..100の整数刻みで、小数2桁の表示へ換算する。
  private buildRangeField(label: string, onCommit: (value: number) => void): RangeField {
    const row = document.createElement('div');
    row.className = 'w-group halo-range-row';
    const heading = document.createElement('span');
    heading.className = 'w-group-title';
    heading.textContent = label;
    row.appendChild(heading);

    const sliderCol = document.createElement('div');
    sliderCol.className = 'slider-col';
    row.appendChild(sliderCol);

    const slider = new Slider({ min: 0, max: 100, step: 1 }, (raw) => {
      const value = raw / 100;
      input.setValue(value.toFixed(2));
      onCommit(value);
    });
    sliderCol.appendChild(slider.element);

    const input = new ValueInput({ type: 'number', min: 0, max: 1, step: RANGE_STEP }, (text) => {
      const value = Math.max(0, Math.min(1, Number(text)));
      slider.setValue(Math.round(value * 100));
      input.setValue(value.toFixed(2));
      onCommit(value);
    });
    row.appendChild(input.element);

    return { row, slider, input };
  }

  // 振幅入力(平面/垂直リヤプノフ・リサジュー・DRO)。値はメートルで持つが、対数マッピングの
  // スライダーと km 表示の数値入力で操作する。
  private buildAmplitudeField(label: string, onCommit: (meters: number) => void): AmplitudeField {
    const row = document.createElement('div');
    row.className = 'w-group halo-amplitude-row';
    const heading = document.createElement('span');
    heading.className = 'w-group-title';
    heading.textContent = label;
    row.appendChild(heading);

    const sliderCol = document.createElement('div');
    sliderCol.className = 'slider-col';
    row.appendChild(sliderCol);

    const slider = new Slider({ min: 0, max: AMPLITUDE_SLIDER_STEPS, step: 1 }, (raw) => {
      const meters = amplitudeSliderToMeters(raw);
      input.setValue(metersToKm(meters).toFixed(0));
      onCommit(meters);
    });
    sliderCol.appendChild(slider.element);

    const input = new ValueInput({
      type: 'number', min: metersToKm(AMPLITUDE_MIN_M), max: metersToKm(AMPLITUDE_MAX_M), step: 100,
    }, (text) => {
      const km = Math.max(metersToKm(AMPLITUDE_MIN_M), Math.min(metersToKm(AMPLITUDE_MAX_M), Number(text)));
      const meters = kmToMeters(km);
      slider.setValue(metersToAmplitudeSlider(meters));
      input.setValue(km.toFixed(0));
      onCommit(meters);
    });
    row.appendChild(input.element);

    const unit = document.createElement('span');
    unit.className = 'halo-amplitude-unit';
    unit.textContent = 'km';
    row.appendChild(unit);

    return { row, slider, input };
  }

  // 表示トグル+振幅の1ファミリー分(平面/垂直リヤプノフ・DRO)。
  private buildFamilyRow(
    parent: HTMLElement, label: string, amplitudeLabel: string,
    get: (settings: HaloGuideSettings) => FamilyToggle,
    withFamily: (settings: HaloGuideSettings, family: FamilyToggle) => HaloGuideSettings,
  ): FamilyRow {
    const row = document.createElement('div');
    row.className = 'halo-family-row';
    const toggle = new ToggleSwitch(label, (on) => {
      this.current = withFamily(this.current, { ...get(this.current), on });
      this.onSettingsChange?.(this.current);
    });
    row.appendChild(toggle.element);
    const amplitude = this.buildAmplitudeField(amplitudeLabel, (meters) => {
      this.current = withFamily(this.current, { ...get(this.current), amplitude: meters });
      this.onSettingsChange?.(this.current);
    });
    row.appendChild(amplitude.row);
    parent.appendChild(row);
    return { row, toggle, amplitude };
  }

  // リサジュー軌道は面内・面外の振幅を独立に持つため、専用の1行を組む。
  private buildLissajousRow(parent: HTMLElement): LissajousRow {
    const row = document.createElement('div');
    row.className = 'halo-family-row';
    const toggle = new ToggleSwitch('リサジュー軌道', (on) => {
      const family: LissajousToggle = { ...this.current.lissajous, on };
      this.current = { ...this.current, lissajous: family };
      this.onSettingsChange?.(this.current);
    });
    row.appendChild(toggle.element);
    const inPlane = this.buildAmplitudeField('面内振幅', (meters) => {
      const family: LissajousToggle = { ...this.current.lissajous, inPlane: meters };
      this.current = { ...this.current, lissajous: family };
      this.onSettingsChange?.(this.current);
    });
    row.appendChild(inPlane.row);
    const outOfPlane = this.buildAmplitudeField('面外振幅', (meters) => {
      const family: LissajousToggle = { ...this.current.lissajous, outOfPlane: meters };
      this.current = { ...this.current, lissajous: family };
      this.onSettingsChange?.(this.current);
    });
    row.appendChild(outOfPlane.row);
    parent.appendChild(row);
    return { row, toggle, inPlane, outOfPlane };
  }

  // 下限・上限どちらの操作からも呼ばれ、min>max の入れ替えを一箇所へ集約する。
  private commitRange(min: number, max: number): void {
    const rangeMin = Math.min(min, max);
    const rangeMax = Math.max(min, max);
    this.current = { ...this.current, rangeMin, rangeMax };
    this.syncRangeField(this.rangeMinField, rangeMin);
    this.syncRangeField(this.rangeMaxField, rangeMax);
    this.onSettingsChange?.(this.current);
  }

  private syncRangeField(field: RangeField, value: number): void {
    if (document.activeElement !== field.input.element) field.input.setValue(value.toFixed(2));
    field.slider.setValue(Math.round(value * 100));
  }

  private syncAmplitudeField(field: AmplitudeField, meters: number): void {
    if (document.activeElement !== field.input.element) field.input.setValue(metersToKm(meters).toFixed(0));
    field.slider.setValue(metersToAmplitudeSlider(meters));
  }

  private syncFamilyRow(row: FamilyRow, family: FamilyToggle): void {
    row.toggle.setOn(family.on);
    this.syncAmplitudeField(row.amplitude, family.amplitude);
  }

  // 正本からの鏡映し反映。編集中の入力欄は打鍵中の値を壊さないよう上書きしない。
  public setSettings(settings: HaloGuideSettings): void {
    this.current = settings;
    this.sunEarthButton.setOn(settings.sunEarth);
    this.earthMoonButton.setOn(settings.earthMoon);
    this.l1Button.setOn(settings.l1);
    this.l2Button.setOn(settings.l2);
    this.l3Button.setOn(settings.l3);
    this.northButton.setOn(settings.north);
    this.southButton.setOn(settings.south);
    this.syncRangeField(this.rangeMinField, settings.rangeMin);
    this.syncRangeField(this.rangeMaxField, settings.rangeMax);
    this.syncFamilyRow(this.planarLyapunovRow, settings.planarLyapunov);
    this.syncFamilyRow(this.verticalLyapunovRow, settings.verticalLyapunov);
    this.lissajousRow.toggle.setOn(settings.lissajous.on);
    this.syncAmplitudeField(this.lissajousRow.inPlane, settings.lissajous.inPlane);
    this.syncAmplitudeField(this.lissajousRow.outOfPlane, settings.lissajous.outOfPlane);
    this.syncFamilyRow(this.droRow, settings.dro);
  }

  // マップビューでの表示可否。開閉ボタンの状態とは別軸で、両方が真のときだけ画面に出る。
  public setVisible(visible: boolean): void {
    this.visible = visible;
    this.updateHidden();
  }

  // 表示パネルのハロー軌道行にある開閉ボタンからの開閉。
  public setOpen(open: boolean): void {
    this.open = open;
    this.updateHidden();
  }

  public isOpen(): boolean {
    return this.open;
  }

  private updateHidden(): void {
    this.panel.classList.toggle('hidden', !(this.visible && this.open));
  }

  // パネルを取り除き、折りたたみ状態変化の購読を解く。
  public dispose(): void {
    this.unsubscribeCollapsedView();
    this.panel.remove();
  }
}
