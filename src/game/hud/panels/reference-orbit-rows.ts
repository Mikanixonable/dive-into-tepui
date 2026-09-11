// 軌道ガイドタブ「基本」群のうち、CR3BP の族を持たない地球専用参照軌道(太陽同期準回帰・
// ドーンダスク・モルニヤ・ツンドラ)の行。族の kindRow(orbit-guide-tab.ts)とは構造が異なる
// (本数・族範囲・安定度を持たない)。各行は自分の DOM を組み、設定値への鏡映し反映も自分で行う。
import { SegmentedControl, ToggleSwitch, ValueInput, type Button } from '../../../hud/widgets';
import {
  DIRECTION_ITEMS, OPACITY_MAPPING, PERIGEE_ALTITUDE_MAPPING, RAAN_MAPPING,
  REPEAT_DAYS_MAPPING, REVS_PER_REPEAT_MAPPING,
  buildColorField, buildKindRowHeading, buildValueField, hexColorString, syncSunSyncValidRange, syncValueField,
  type ValueField,
} from './guide-value-field';
import type {
  CriticalInclinationSettings, DawnDuskSettings, LocalTime, SunSyncSettings,
} from '../../celestial/orbit-guide/orbit-guide-settings';
import type { DirectionMarkerMode } from '../../../render/celestial/orbit-guide/direction-markers';

interface AppearancePatch {
  readonly colorStart?: number;
  readonly opacity?: number;
  readonly direction?: DirectionMarkerMode;
  readonly animate?: boolean;
}

interface AppearanceSettings {
  readonly colorStart: number;
  readonly opacity: number;
  readonly direction: DirectionMarkerMode;
  readonly animate: boolean;
}

// 参照軌道の線をどう見せるか(色・透明度・進行方向・アニメーション)を決める4行。
class LineAppearanceRows {
  private readonly colorInput: ValueInput;
  private readonly opacityField: ValueField;
  private readonly direction: SegmentedControl<DirectionMarkerMode>;
  private readonly animateSwitch: ToggleSwitch;

  // configPanel の末尾へ4行を追加する。onCommit は行が操作されるたびに呼ばれる。
  public constructor(configPanel: HTMLElement, onCommit: (patch: AppearancePatch) => void) {
    const colorField = buildColorField('色', 0, (v) => onCommit({ colorStart: v }));
    configPanel.appendChild(colorField.row);
    this.colorInput = colorField.input;
    this.opacityField = buildValueField('透明度', OPACITY_MAPPING, (v) => onCommit({ opacity: v }));
    configPanel.appendChild(this.opacityField.row);
    this.direction = new SegmentedControl<DirectionMarkerMode>('進行方向', DIRECTION_ITEMS, (mode) => onCommit({ direction: mode }));
    configPanel.appendChild(this.direction.element);
    this.animateSwitch = new ToggleSwitch('進行方向のアニメーション', (on) => onCommit({ animate: on }));
    configPanel.appendChild(this.animateSwitch.element);
  }

  // 4行の表示を s へ合わせる。
  public sync(s: AppearanceSettings): void {
    this.colorInput.setValue(hexColorString(s.colorStart));
    syncValueField(this.opacityField, OPACITY_MAPPING, s.opacity);
    this.direction.setSelected(s.direction);
    this.animateSwitch.setOn(s.animate);
  }
}

// 準回帰軌道の回帰周期を決める2行(回帰日数・周回数)。互いに矛盾する組み合わせは
// 有効域の表示で示す。
class RepeatGroundTrackRows {
  private readonly repeatDaysField: ValueField;
  private readonly revsPerRepeatField: ValueField;

  // configPanel の末尾へ2行を追加する。onCommit は行が操作されるたびに呼ばれる。
  public constructor(configPanel: HTMLElement, onCommit: (patch: Partial<SunSyncSettings>) => void) {
    this.repeatDaysField = buildValueField('回帰日数', REPEAT_DAYS_MAPPING, (v) => onCommit({ repeatDays: Math.round(v) }));
    configPanel.appendChild(this.repeatDaysField.row);
    this.revsPerRepeatField = buildValueField('周回数', REVS_PER_REPEAT_MAPPING, (v) => onCommit({ revsPerRepeat: Math.round(v) }));
    configPanel.appendChild(this.revsPerRepeatField.row);
  }

  // 2行の表示と有効域を s へ合わせる。
  public sync(s: SunSyncSettings): void {
    syncValueField(this.repeatDaysField, REPEAT_DAYS_MAPPING, s.repeatDays);
    syncValueField(this.revsPerRepeatField, REVS_PER_REPEAT_MAPPING, s.revsPerRepeat);
    syncSunSyncValidRange(this.repeatDaysField, this.revsPerRepeatField, s.repeatDays, s.revsPerRepeat);
  }
}

// 太陽同期準回帰軌道の行。
export class SunSyncRow {
  private readonly heading: Button;
  private readonly configPanel: HTMLElement;
  private readonly repeat: RepeatGroundTrackRows;
  private readonly appearance: LineAppearanceRows;

  // parent の末尾へ行を追加する。onToggle は見出しクリック、onCommit は設定値の変更ごとに呼ばれる。
  public constructor(parent: HTMLElement, onToggle: () => void, onCommit: (patch: Partial<SunSyncSettings>) => void) {
    const { heading, configPanel } = buildKindRowHeading(parent, '太陽同期準回帰軌道(sun-synchronous)', onToggle);
    this.heading = heading;
    this.configPanel = configPanel;
    this.repeat = new RepeatGroundTrackRows(configPanel, onCommit);
    this.appearance = new LineAppearanceRows(configPanel, onCommit);
  }

  // 見出しの点灯・設定パネルの開閉を含めて、行全体を s へ合わせる。
  public sync(s: SunSyncSettings): void {
    this.heading.setOn(s.on);
    this.configPanel.classList.toggle('hidden', !s.on);
    this.repeat.sync(s);
    this.appearance.sync(s);
  }
}

// ドーンダスク軌道の行。太陽同期準回帰軌道と同じ回帰周期に、昇交点の地方太陽時(朝/夕)を加える。
export class DawnDuskRow {
  private readonly heading: Button;
  private readonly configPanel: HTMLElement;
  private readonly localTime: SegmentedControl<LocalTime>;
  private readonly repeat: RepeatGroundTrackRows;
  private readonly appearance: LineAppearanceRows;

  // parent の末尾へ行を追加する。onToggle は見出しクリック、onCommit は設定値の変更ごとに呼ばれる。
  public constructor(parent: HTMLElement, onToggle: () => void, onCommit: (patch: Partial<DawnDuskSettings>) => void) {
    const { heading, configPanel } = buildKindRowHeading(parent, 'ドーンダスク軌道(dawn-dusk)', onToggle);
    this.heading = heading;
    this.configPanel = configPanel;
    this.localTime = new SegmentedControl<LocalTime>(
      '昇交点の地方時', [['dawn', '朝(6時)'], ['dusk', '夕(18時)']], (v) => onCommit({ localTime: v }),
    );
    configPanel.appendChild(this.localTime.element);
    this.repeat = new RepeatGroundTrackRows(configPanel, onCommit);
    this.appearance = new LineAppearanceRows(configPanel, onCommit);
  }

  // 見出しの点灯・設定パネルの開閉を含めて、行全体を s へ合わせる。
  public sync(s: DawnDuskSettings): void {
    this.heading.setOn(s.on);
    this.configPanel.classList.toggle('hidden', !s.on);
    this.localTime.setSelected(s.localTime);
    this.repeat.sync(s);
    this.appearance.sync(s);
  }
}

// 臨界傾斜角の軌道(モルニヤ・ツンドラ)の行。両者は見出しと既定値だけが違うので、
// 見出しを引数で受ける同じ行として組む。
export class CriticalInclinationRow {
  private readonly heading: Button;
  private readonly configPanel: HTMLElement;
  private readonly perigeeAltitudeField: ValueField;
  private readonly raanField: ValueField;
  private readonly appearance: LineAppearanceRows;

  // parent の末尾へ label を見出しとする行を追加する。onToggle は見出しクリック、onCommit は
  // 設定値の変更ごとに呼ばれる。
  public constructor(
    parent: HTMLElement, label: string, onToggle: () => void, onCommit: (patch: Partial<CriticalInclinationSettings>) => void,
  ) {
    const { heading, configPanel } = buildKindRowHeading(parent, label, onToggle);
    this.heading = heading;
    this.configPanel = configPanel;
    this.perigeeAltitudeField = buildValueField('近地点高度', PERIGEE_ALTITUDE_MAPPING, (v) => onCommit({ perigeeAltitude: v }));
    configPanel.appendChild(this.perigeeAltitudeField.row);
    this.raanField = buildValueField('昇交点赤経', RAAN_MAPPING, (v) => onCommit({ raan: v }));
    configPanel.appendChild(this.raanField.row);
    this.appearance = new LineAppearanceRows(configPanel, onCommit);
  }

  // 見出しの点灯・設定パネルの開閉を含めて、行全体を s へ合わせる。
  public sync(s: CriticalInclinationSettings): void {
    this.heading.setOn(s.on);
    this.configPanel.classList.toggle('hidden', !s.on);
    syncValueField(this.perigeeAltitudeField, PERIGEE_ALTITUDE_MAPPING, s.perigeeAltitude);
    syncValueField(this.raanField, RAAN_MAPPING, s.raan);
    this.appearance.sync(s);
  }
}
