// 表示パネル(マップモード左レール)ガイドタブのゼロ速度曲線節。CR3BP のヤコビ定数で決まる
// 到達可能領域の境界を、断面ゲート・ヤコビ定数入力・ラグランジュ点への一発合わせ・範囲/本数・
// 透明度で設定させる。操作のたびに、書き換わった項目だけを onChange へ渡す。
import { Button, ToggleSwitch } from '../../../hud/widgets';
import type { LagrangeLabel } from '../../../physics/lagrange';
import { lagrangePointJacobi } from '../../celestial/orbit-guide/orbit-guide-catalog';
import type { ZeroVelocitySettings } from '../../celestial/orbit-guide/orbit-guide-settings';
import {
  JACOBI_MAPPING, OPACITY_MAPPING, ZERO_VELOCITY_COUNT_MAPPING, buildValueField, syncValueField,
  type ValueField,
} from './guide-value-field';

const ZERO_VELOCITY_SECTION_ROWS: readonly (readonly [keyof ZeroVelocitySettings, string])[] = [
  ['earthMoonXY', '月軌道面'],
  ['earthMoonXZ', '地球と月を通る垂直な断面'],
  ['sunEarthXY', '地球公転面'],
  ['sunEarthXZ', '太陽と地球を通る垂直な断面'],
  ['sunJupiterXY', '木星公転面'],
  ['sunJupiterXZ', '太陽と木星を通る垂直な断面'],
  ['sunSaturnXY', '土星公転面'],
  ['sunSaturnXZ', '太陽と土星を通る垂直な断面'],
];

const LAGRANGE_POINTS: readonly LagrangeLabel[] = ['L1', 'L2', 'L3', 'L4', 'L5'];

// ヤコビ定数の範囲を「多数」表示のために組んで返す3欄(下限・上限・本数)。
interface RangeFields {
  readonly row: HTMLElement;
  readonly minField: ValueField;
  readonly maxField: ValueField;
  readonly countField: ValueField;
}

// 断面が開いている系のラグランジュ点 point のヤコビ定数。複数系が開いていれば先頭、
// 何も開いていなければ地球-月の値を返す。
export function zeroVelocityJacobiAt(s: ZeroVelocitySettings, point: LagrangeLabel): number {
  const system = s.earthMoonXY || s.earthMoonXZ ? 'earth-moon'
    : s.sunEarthXY || s.sunEarthXZ ? 'sun-earth'
      : s.sunJupiterXY || s.sunJupiterXZ ? 'sun-jupiter'
        : s.sunSaturnXY || s.sunSaturnXZ ? 'sun-saturn' : 'earth-moon';
  return lagrangePointJacobi(system, point);
}

export class ZeroVelocitySection {
  public readonly element: HTMLElement;
  // 書き換わった項目だけを載せて呼ばれる。
  public onChange: ((change: Partial<ZeroVelocitySettings>) => void) | null = null;
  // ラグランジュ点ボタンが押されたときに、その点で呼ばれる。
  public onSnapToLagrange: ((point: LagrangeLabel) => void) | null = null;

  private readonly switches: readonly (readonly [keyof ZeroVelocitySettings, ToggleSwitch])[];
  private readonly multipleSwitch: ToggleSwitch;
  private readonly jacobiField: ValueField;
  private readonly jacobiRangeRow: HTMLElement;
  private readonly jacobiMinField: ValueField;
  private readonly jacobiMaxField: ValueField;
  private readonly countRow: HTMLElement;
  private readonly countField: ValueField;
  private readonly opacityField: ValueField;

  // initial の状態で節の DOM 一式を組み立てる。
  public constructor(initial: ZeroVelocitySettings) {
    // 節見出し。
    this.element = document.createElement('div');
    this.element.className = 'orbit-guide-section-divider-wrap';
    const heading = document.createElement('div');
    heading.className = 'view-options-section-divider';
    heading.textContent = 'ゼロ速度曲線';
    this.element.appendChild(heading);

    // 断面ゲートと表示方式。
    this.switches = this.buildGateSwitches(this.element);
    this.multipleSwitch = new ToggleSwitch('多数の曲線を表示', (multiple) => this.commit({ multiple }));
    this.element.appendChild(this.multipleSwitch.element);

    // ヤコビ定数とラグランジュ点スナップ。
    this.jacobiField = buildValueField('ヤコビ定数', JACOBI_MAPPING, (jacobi) => this.commit({ jacobi }));
    this.element.appendChild(this.jacobiField.row);
    this.buildLagrangeRow(this.element);

    // 「多数」表示時の範囲・本数。
    const range = this.buildRangeFields(this.element);
    this.jacobiRangeRow = range.row;
    this.jacobiMinField = range.minField;
    this.jacobiMaxField = range.maxField;
    this.countField = range.countField;
    this.countRow = range.countField.row;

    this.opacityField = buildValueField('透明度', OPACITY_MAPPING, (opacity) => this.commit({ opacity }));
    this.element.appendChild(this.opacityField.row);

    this.sync(initial);
  }

  // 断面ゲート8種のトグル列を組む。
  private buildGateSwitches(parent: HTMLElement): readonly (readonly [keyof ZeroVelocitySettings, ToggleSwitch])[] {
    const switches: (readonly [keyof ZeroVelocitySettings, ToggleSwitch])[] = [];
    for (const [key, label] of ZERO_VELOCITY_SECTION_ROWS) {
      const sw = new ToggleSwitch(label, (on) => this.commit({ [key]: on }));
      parent.appendChild(sw.element);
      switches.push([key, sw]);
    }
    return switches;
  }

  // 各ラグランジュ点の値へヤコビ定数を一発で合わせるボタン列。
  private buildLagrangeRow(parent: HTMLElement): void {
    const row = document.createElement('div');
    row.className = 'w-group orbit-guide-toggle-row';
    for (const point of LAGRANGE_POINTS) {
      const btn = new Button(point, () => this.onSnapToLagrange?.(point));
      row.appendChild(btn.element);
    }
    parent.appendChild(row);
  }

  // 「多数」表示のときだけ見せる、ヤコビ定数の範囲と本数の入力欄。
  private buildRangeFields(parent: HTMLElement): RangeFields {
    const row = document.createElement('div');
    row.className = 'orbit-guide-zero-velocity-range';
    // 下限・上限は互いに独立して動かせる。大小関係の整えは設定を組み直す側が行う。
    const minField = buildValueField('ヤコビ定数(下限)', JACOBI_MAPPING, (v) => this.commit({ jacobiMin: v }));
    const maxField = buildValueField('ヤコビ定数(上限)', JACOBI_MAPPING, (v) => this.commit({ jacobiMax: v }));
    const countField = buildValueField('本数', ZERO_VELOCITY_COUNT_MAPPING, (count) => this.commit({ count: Math.round(count) }));
    row.appendChild(minField.row);
    row.appendChild(maxField.row);
    row.appendChild(countField.row);
    parent.appendChild(row);
    return { row, minField, maxField, countField };
  }

  // 書き換わった項目を呼び出し側へ通知する。
  private commit(change: Partial<ZeroVelocitySettings>): void {
    this.onChange?.(change);
  }

  // 各ウィジェットの表示を s へ合わせる。
  public sync(s: ZeroVelocitySettings): void {
    for (const [key, sw] of this.switches) sw.setOn(Boolean(s[key]));
    this.multipleSwitch.setOn(s.multiple);

    syncValueField(this.jacobiField, JACOBI_MAPPING, s.jacobi);
    syncValueField(this.jacobiMinField, JACOBI_MAPPING, s.jacobiMin);
    syncValueField(this.jacobiMaxField, JACOBI_MAPPING, s.jacobiMax);
    syncValueField(this.countField, ZERO_VELOCITY_COUNT_MAPPING, s.count);
    syncValueField(this.opacityField, OPACITY_MAPPING, s.opacity);

    // 表示方式に応じて「1本」欄と「多数」欄を排他に出し分ける。
    this.jacobiField.row.classList.toggle('hidden', s.multiple);
    this.jacobiRangeRow.classList.toggle('hidden', !s.multiple);
    this.countRow.classList.toggle('hidden', !s.multiple);
  }
}
