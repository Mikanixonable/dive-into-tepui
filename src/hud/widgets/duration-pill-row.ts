// 「見出し + 固定期間ピル列 + 常時表示の数値入力」の1行。
import { Button } from './button';
import { DurationValueInput } from './duration-value-input';
import { buildLabeledRow } from './widget-base';

// K は固定ピルのキー、Kd は選択状態として受け取るキー(固定ピルに加えて 'custom' を含む)。
// 数値入力を書き換えて確定した値は onCustomConfirm へ渡す — 選択キーとしては 'custom' に相当する。
export class DurationPillRow<K extends string, Kd extends K | 'custom'> {
  public readonly element: HTMLElement;
  private readonly buttons = new Map<K, Button>();
  private readonly input: DurationValueInput;

  // title を見出しにした1行を組む。ピルの押下は onSelect、数値入力の確定は onCustomConfirm。
  // minSec/maxSec は数値入力へ許す秒数の範囲。
  public constructor(
    title: string,
    entries: readonly (readonly [K, string])[],
    private readonly onSelect: (key: K) => void,
    onCustomConfirm: (sec: number) => void,
    private readonly minSec: number,
    private readonly maxSec: number,
  ) {
    this.element = buildLabeledRow(title, 'predict-row1');

    // 固定期間のピルを並べ、末尾に手動レンジの入力欄を置く。
    const pillsEl = document.createElement('span');
    pillsEl.className = 'predict-pills';
    for (const [key, text] of entries) {
      const btn = new Button(text, () => this.onSelect(key));
      pillsEl.appendChild(btn.element);
      this.buttons.set(key, btn);
    }
    this.element.appendChild(pillsEl);

    this.input = new DurationValueInput('day', onCustomConfirm, () => {});
    this.element.appendChild(this.input.element);
  }

  // 選択中のキーと、数値入力欄に示す秒数を反映する。入力欄は編集中(フォーカス中)なら
  // ユーザー入力を壊さないよう書き換えない。
  public render(key: Kd, currentSec: number): void {
    for (const [k, btn] of this.buttons) btn.setOn(key === k);
    if (!this.input.focused) this.input.syncSec(currentSec, this.minSec, this.maxSec);
  }
}
