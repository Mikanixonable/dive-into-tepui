// 表示パネル(マップモード左レール)ガイドタブのゼロ速度曲線節。CR3BP のヤコビ定数で決まる
// 到達可能領域の境界を、断面ゲート・ヤコビ定数入力・ラグランジュ点への一発合わせ・範囲/本数・
// 透明度で設定させる。状態の正本を持たず、操作のたびに現在値の鏡映しから次の
// ZeroVelocitySettings を組んで onChange へ渡す。
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
];

const LAGRANGE_POINTS: readonly LagrangeLabel[] = ['L1', 'L2', 'L3', 'L4', 'L5'];

// ヤコビ定数の範囲を「多数」表示のために組んで返す3欄(下限・上限・本数)。
interface RangeFields {
  readonly row: HTMLElement;
  readonly minField: ValueField;
  readonly maxField: ValueField;
  readonly countField: ValueField;
}

export class ZeroVelocitySection {
  public readonly element: HTMLElement;
  public onChange: ((settings: ZeroVelocitySettings) => void) | null = null;

  private current: ZeroVelocitySettings;
  private readonly switches: readonly (readonly [keyof ZeroVelocitySettings, ToggleSwitch])[];
  private readonly multipleSwitch: ToggleSwitch;
  private readonly jacobiField: ValueField;
  private readonly jacobiRangeRow: HTMLElement;
  private readonly jacobiMinField: ValueField;
  private readonly jacobiMaxField: ValueField;
  private readonly countRow: HTMLElement;
  private readonly countField: ValueField;
  private readonly opacityField: ValueField;

  // 初期値から節の DOM 一式を組み立てる。以後の状態はコンストラクタ引数でなく setSettings で
  // 差し替える。
  public constructor(initial: ZeroVelocitySettings) {
    this.current = initial;

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

    this.sync();
  }

  // 断面ゲート4種のトグル列を組む。
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
      const btn = new Button(point, () => this.snapToLagrange(point));
      row.appendChild(btn.element);
    }
    parent.appendChild(row);
  }

  // 「多数」表示のときだけ見せる、ヤコビ定数の範囲と本数の入力欄。
  private buildRangeFields(parent: HTMLElement): RangeFields {
    const row = document.createElement('div');
    row.className = 'orbit-guide-zero-velocity-range';
    // 下限・上限は互いに独立して動かせるが、commitRange で常に min ≤ max に整える。
    const minField = buildValueField('ヤコビ定数(下限)', JACOBI_MAPPING, (v) => this.commitRange(v, this.current.jacobiMax));
    const maxField = buildValueField('ヤコビ定数(上限)', JACOBI_MAPPING, (v) => this.commitRange(this.current.jacobiMin, v));
    const countField = buildValueField('本数', ZERO_VELOCITY_COUNT_MAPPING, (count) => this.commit({ count: Math.round(count) }));
    row.appendChild(minField.row);
    row.appendChild(maxField.row);
    row.appendChild(countField.row);
    parent.appendChild(row);
    return { row, minField, maxField, countField };
  }

  // 正本を差し替え、見た目を鏡映しへ合わせて呼び出し側へ通知する。
  private commit(patch: Partial<ZeroVelocitySettings>): void {
    this.current = { ...this.current, ...patch };
    this.sync();
    this.onChange?.(this.current);
  }

  // 下限・上限の大小関係が入れ替わっても壊れないよう、コミット前に min ≤ max へ整える。
  private commitRange(min: number, max: number): void {
    this.commit({ jacobiMin: Math.min(min, max), jacobiMax: Math.max(min, max) });
  }

  // 断面が実際に開いている系(地球-月/太陽-地球)のラグランジュ点の値へヤコビ定数を合わせる。
  // 両方または片方も開いていなければ地球-月を既定にする。
  private snapToLagrange(point: LagrangeLabel): void {
    const s = this.current;
    const sunEarthOnly = (s.sunEarthXY || s.sunEarthXZ) && !(s.earthMoonXY || s.earthMoonXZ);
    this.commit({ jacobi: lagrangePointJacobi(sunEarthOnly ? 'sun-earth' : 'earth-moon', point) });
  }

  // 現在値を各ウィジェットへ映す。
  private sync(): void {
    const s = this.current;
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

  // 正本からの鏡映し反映。
  public setSettings(settings: ZeroVelocitySettings): void {
    this.current = settings;
    this.sync();
  }
}
