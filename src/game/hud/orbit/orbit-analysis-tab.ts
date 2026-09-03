// 軌道分析パネルのタブが実装する共通形と、タブが組み立てる部品(スケール入力欄・リセット行)。
import { Button, ValueInput, injectOnce } from '../../../hud/widgets';
import type { Game } from '../../game';
import type { DynamicEntity } from '../../dynamic/dynamic-entity/dynamic-entity';
import type { OrbitReference } from '../../orbit-reference';
import type { ApproachTargetSource } from './orbit-analysis-data';

export interface AnalysisTab {
  // タブバーに出す名前。
  readonly label: string;
  // タブバーの下に置く要素一式(チャート・補助表示・スケール入力欄・リセット)。
  readonly element: HTMLElement;

  // タブバーに出すか。false になったタブが選ばれていたら、選択は高度タブへ戻る。
  available(
    game: Game, entity: DynamicEntity, reference: OrbitReference, target: ApproachTargetSource | null,
  ): boolean;
  // 選ばれている間だけ呼ばれる。
  draw(
    game: Game, entity: DynamicEntity, reference: OrbitReference, target: ApproachTargetSource | null,
  ): void;
  // 表示範囲を、開いた/このタブを選び直した時点へ戻す。
  resetView(): void;
  dispose(): void;
}

const SCALE_MIN_KM = 1;
const SCALE_MAX_KM = 1_000_000;

// ズームで動かしたスケール [km] を、目盛りが意味を持つ範囲へ収める。
export function clampScaleKm(km: number): number {
  return Math.max(SCALE_MIN_KM, Math.min(SCALE_MAX_KM, km));
}

const SAMPLE_PX_PER_POINT = 2.5;
const MIN_SAMPLES = 20;
const MAX_SAMPLES = 300;
// チャートがまだレイアウトされていないフレームで使う仮の幅 [px]。
const UNLAID_OUT_WIDTH_PX = 300;

// チャートの表示幅から、点列のサンプル数を求める(密度を一定に保つ)。
export function sampleCountFor(chart: HTMLElement): number {
  const width = chart.clientWidth || UNLAID_OUT_WIDTH_PX;
  return Math.max(MIN_SAMPLES, Math.min(MAX_SAMPLES, Math.round(width / SAMPLE_PX_PER_POINT)));
}

const STYLE = `
#hud .orbit-analysis-scales { display: flex; flex-wrap: wrap; gap: var(--space-4); margin-top: var(--space-3); }
#hud .orbit-analysis-scale { display: flex; align-items: center; gap: var(--space-2); }
#hud .orbit-analysis-scale-label { color: var(--text-dim); font-size: var(--font-xs); }
#hud .orbit-analysis-scale-unit { color: var(--text-dim); font-size: var(--font-xs); }
#hud .orbit-analysis-scale .w-input { width: 64px; }
#hud .orbit-analysis-reset { margin-left: auto; }
`;

// ラベル + 数値入力欄 + 単位 の1組。
export class ScaleField {
  public readonly element: HTMLElement;
  private readonly input: ValueInput;

  // current() は入力を破棄したときに戻す現在値、commit は有効な値が確定したときに呼ばれる。
  public constructor(label: string, unit: string, current: () => number, commit: (value: number) => void) {
    injectOnce('orbit-analysis-tab', STYLE);
    this.element = document.createElement('div');
    this.element.className = 'orbit-analysis-scale';
    const labelEl = document.createElement('span');
    labelEl.className = 'orbit-analysis-scale-label';
    labelEl.textContent = label;
    this.element.appendChild(labelEl);
    // 非数値・0以下の確定は破棄して現在値へ戻す。
    const input = new ValueInput({ type: 'number', step: 1 }, (text) => {
      const value = Number(text);
      if (!isFinite(value) || value <= 0) { input.setValue(String(current())); return; }
      commit(value);
      input.setValue(String(value));
    });
    this.input = input;
    this.element.appendChild(input.element);
    const unitEl = document.createElement('span');
    unitEl.className = 'orbit-analysis-scale-unit';
    unitEl.textContent = unit;
    this.element.appendChild(unitEl);
    this.setValue(current());
  }

  public setValue(value: number): void {
    this.input.setValue(String(value));
  }
}

// スケール入力欄(持たないタブもある)とリセットボタンを並べる、タブ下端の行。
export function buildTabControls(fields: readonly ScaleField[], onReset: () => void): HTMLElement {
  injectOnce('orbit-analysis-tab', STYLE);
  const row = document.createElement('div');
  row.className = 'orbit-analysis-scales';
  for (const field of fields) row.appendChild(field.element);
  const reset = new Button('リセット', onReset);
  reset.element.classList.add('orbit-analysis-reset');
  row.appendChild(reset.element);
  return row;
}
