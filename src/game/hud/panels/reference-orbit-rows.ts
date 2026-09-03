// 軌道ガイドタブ「基本」群のうち、CR3BP の族を持たない地球専用参照軌道(太陽同期準回帰・
// ドーンダスク・モルニヤ・ツンドラ)の行を組み立てる。族の kindRow(orbit-guide-tab.ts)とは
// 構造が異なる(本数・族範囲・安定度を持たない)ので、共通の組み立て手続きをここへ集約する。
import { Button, SegmentedControl, ToggleSwitch, ValueInput } from '../../../hud/widgets';
import {
  DIRECTION_ITEMS, OPACITY_MAPPING, PERIGEE_ALTITUDE_MAPPING, RAAN_MAPPING,
  REPEAT_DAYS_MAPPING, REVS_PER_REPEAT_MAPPING,
  buildColorField, buildKindRowHeading, buildValueField, hexColorString, syncSunSyncValidRange, syncValueField,
  type ValueField,
} from './guide-value-field';
import type {
  CriticalInclinationSettings, DawnDuskSettings, DirectionMarkerMode, LocalTime, SunSyncSettings,
} from '../../celestial/orbit-guide/orbit-guide-settings';

interface ReferenceOrbitRow {
  readonly heading: Button;
  readonly configPanel: HTMLElement;
  readonly colorInput: ValueInput;
  readonly opacityField: ValueField;
  readonly direction: SegmentedControl<DirectionMarkerMode>;
  readonly animateSwitch: ToggleSwitch;
}

export interface RepeatGroundTrackRow extends ReferenceOrbitRow {
  readonly repeatDaysField: ValueField;
  readonly revsPerRepeatField: ValueField;
}

export interface DawnDuskRow extends RepeatGroundTrackRow {
  readonly localTime: SegmentedControl<LocalTime>;
}

export interface CriticalInclinationRow extends ReferenceOrbitRow {
  readonly perigeeAltitudeField: ValueField;
  readonly raanField: ValueField;
}

// 色・透明度・進行方向・アニメーションの4行(全ての参照軌道に共通)。
function buildCommonFields(
  configPanel: HTMLElement,
  onCommit: (patch: { colorStart?: number; opacity?: number; direction?: DirectionMarkerMode; animate?: boolean }) => void,
): Omit<ReferenceOrbitRow, 'heading' | 'configPanel'> {
  const colorField = buildColorField('色', 0, (v) => onCommit({ colorStart: v }));
  configPanel.appendChild(colorField.row);
  const opacityField = buildValueField('透明度', OPACITY_MAPPING, (v) => onCommit({ opacity: v }));
  configPanel.appendChild(opacityField.row);
  const direction = new SegmentedControl<DirectionMarkerMode>('進行方向', DIRECTION_ITEMS, (mode) => onCommit({ direction: mode }));
  configPanel.appendChild(direction.element);
  const animateSwitch = new ToggleSwitch('進行方向のアニメーション', (on) => onCommit({ animate: on }));
  configPanel.appendChild(animateSwitch.element);
  return { colorInput: colorField.input, opacityField, direction, animateSwitch };
}

// 回帰日数・周回数の2行(太陽同期準回帰軌道・ドーンダスク軌道に共通)。
function buildRepeatGroundTrackFields(
  configPanel: HTMLElement, onCommit: (patch: Partial<SunSyncSettings>) => void,
): Omit<RepeatGroundTrackRow, keyof ReferenceOrbitRow> {
  const repeatDaysField = buildValueField('回帰日数', REPEAT_DAYS_MAPPING, (v) => onCommit({ repeatDays: Math.round(v) }));
  configPanel.appendChild(repeatDaysField.row);
  const revsPerRepeatField = buildValueField('周回数', REVS_PER_REPEAT_MAPPING, (v) => onCommit({ revsPerRepeat: Math.round(v) }));
  configPanel.appendChild(revsPerRepeatField.row);
  return { repeatDaysField, revsPerRepeatField };
}

// 太陽同期準回帰軌道の行を parent の末尾へ追加する。onToggle は見出しクリック、onCommit は
// 設定値の変更ごとに呼ばれる。
export function buildSunSyncRow(
  parent: HTMLElement, onToggle: () => void, onCommit: (patch: Partial<SunSyncSettings>) => void,
): RepeatGroundTrackRow {
  const { heading, configPanel } = buildKindRowHeading(parent,'太陽同期準回帰軌道(sun-synchronous)', onToggle);
  const { repeatDaysField, revsPerRepeatField } = buildRepeatGroundTrackFields(configPanel, onCommit);
  const common = buildCommonFields(configPanel, onCommit);
  return { heading, configPanel, repeatDaysField, revsPerRepeatField, ...common };
}

// ドーンダスク軌道の行。太陽同期準回帰軌道の行に、昇交点の地方太陽時(朝/夕)を選ぶ行を加える。
export function buildDawnDuskRow(
  parent: HTMLElement, onToggle: () => void,
  onCommit: (patch: Partial<SunSyncSettings> & { localTime?: LocalTime }) => void,
): DawnDuskRow {
  const { heading, configPanel } = buildKindRowHeading(parent,'ドーンダスク軌道(dawn-dusk)', onToggle);
  const localTime = new SegmentedControl<LocalTime>(
    '昇交点の地方時', [['dawn', '朝(6時)'], ['dusk', '夕(18時)']], (v) => onCommit({ localTime: v }),
  );
  configPanel.appendChild(localTime.element);
  const { repeatDaysField, revsPerRepeatField } = buildRepeatGroundTrackFields(configPanel, onCommit);
  const common = buildCommonFields(configPanel, onCommit);
  return { heading, configPanel, localTime, repeatDaysField, revsPerRepeatField, ...common };
}

// モルニヤ軌道・ツンドラ軌道は近地点高度・昇交点赤経だけが違うので、同じ組み立て手続きを使う。
export function buildCriticalInclinationRow(
  parent: HTMLElement, label: string, onToggle: () => void, onCommit: (patch: Partial<CriticalInclinationSettings>) => void,
): CriticalInclinationRow {
  const { heading, configPanel } = buildKindRowHeading(parent,label, onToggle);
  const perigeeAltitudeField = buildValueField('近地点高度', PERIGEE_ALTITUDE_MAPPING, (v) => onCommit({ perigeeAltitude: v }));
  configPanel.appendChild(perigeeAltitudeField.row);
  const raanField = buildValueField('昇交点赤経', RAAN_MAPPING, (v) => onCommit({ raan: v }));
  configPanel.appendChild(raanField.row);
  const common = buildCommonFields(configPanel, onCommit);
  return { heading, configPanel, perigeeAltitudeField, raanField, ...common };
}

// 地球専用参照軌道に共通する見出し・色・透明度・進行方向・アニメーションの鏡映し反映。
function syncCommon(
  row: ReferenceOrbitRow,
  s: { readonly on: boolean; readonly colorStart: number; readonly opacity: number; readonly direction: DirectionMarkerMode; readonly animate: boolean },
): void {
  row.heading.setOn(s.on);
  row.configPanel.classList.toggle('hidden', !s.on);
  row.colorInput.setValue(hexColorString(s.colorStart));
  syncValueField(row.opacityField, OPACITY_MAPPING, s.opacity);
  row.direction.setSelected(s.direction);
  row.animateSwitch.setOn(s.animate);
}

// buildSunSyncRow が作った行を、現在の設定値へ合わせる。
export function syncSunSyncRow(row: RepeatGroundTrackRow, s: SunSyncSettings): void {
  syncCommon(row, s);
  syncValueField(row.repeatDaysField, REPEAT_DAYS_MAPPING, s.repeatDays);
  syncValueField(row.revsPerRepeatField, REVS_PER_REPEAT_MAPPING, s.revsPerRepeat);
  syncSunSyncValidRange(row.repeatDaysField, row.revsPerRepeatField, s.repeatDays, s.revsPerRepeat);
}

// buildDawnDuskRow が作った行を、現在の設定値へ合わせる。
export function syncDawnDuskRow(row: DawnDuskRow, s: DawnDuskSettings): void {
  syncSunSyncRow(row, s);
  row.localTime.setSelected(s.localTime);
}

// buildCriticalInclinationRow が作った行(モルニヤ・ツンドラ共通)を、現在の設定値へ合わせる。
export function syncCriticalInclinationRow(row: CriticalInclinationRow, s: CriticalInclinationSettings): void {
  syncCommon(row, s);
  syncValueField(row.perigeeAltitudeField, PERIGEE_ALTITUDE_MAPPING, s.perigeeAltitude);
  syncValueField(row.raanField, RAAN_MAPPING, s.raan);
}
