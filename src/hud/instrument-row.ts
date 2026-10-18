// 計器の1行([ラベル][メーター][値 単位][キー])のマークアップ。メーターや値は、組んだあとに
// data-id で引いて差し込む・書き込む。
import { keyCapHtml } from './key-cap';

// 1行の内容。値の要素は data-id か markup のどちらかを指定する。
interface InstrumentRowBaseSpec {
  readonly label: string;
  // ラベルの文字を後から書き換えるときの data-id。
  readonly labelId?: string;
  // 行の中のメーターを差し込む要素の data-id。
  readonly gaugeId?: string;
  // ラベルの隣へ添えるショートカットのキー(KEY_MAPPING の label)。
  readonly keys?: string;
  // 行そのものの data-id。行ごと出し入れするときに使う。
  readonly rowId?: string;
}

export type InstrumentRowSpec = InstrumentRowBaseSpec & (
  | { readonly valueId: string; readonly valueHtml?: never }
  | { readonly valueId?: never; readonly valueHtml: string }
);

// spec の行の HTML を返す。値の要素は valueId なら output、valueHtml なら span で出る。
export function instrumentRowHtml(spec: InstrumentRowSpec): string {
  const rowAttr = spec.rowId === undefined ? '' : ` data-id="${spec.rowId}"`;
  const labelAttr = spec.labelId === undefined ? '' : ` data-id="${spec.labelId}"`;
  const gauge = spec.gaugeId === undefined ? '' : `<span class="ui-gauge" data-id="${spec.gaugeId}"></span>`;
  const value = spec.valueHtml !== undefined
    ? `<span class="ui-v">${spec.valueHtml}</span>`
    : `<output class="ui-v" data-id="${spec.valueId ?? ''}">—</output>`;
  const key = spec.keys === undefined ? '' : keyCapHtml(spec.keys);
  return `<div class="ui-row"${rowAttr}><span class="ui-k"><span class="ui-k-text"${labelAttr}>${spec.label}</span></span>${gauge}${value}${key}</div>`;
}
