// 小さな DOM 部品の組み立て。キーキャップ・状態ピップ・計器行・読み値・ショートカット表記の5種。

// ショートカットキーの表記(キーキャップ)。表記はこの1種に統一し、項目の名前にはキーを埋め込まず
// 名前の隣へ添える。label は KEY_MAPPING の label を渡す。

const KEY_CAP_CLASS = 'ui-key';

// label を表示するキーキャップ(kbd 要素)を作る。
export function createKeyCap(label: string): HTMLElement {
  const cap = document.createElement('kbd');
  cap.className = KEY_CAP_CLASS;
  cap.textContent = label;
  return cap;
}

// innerHTML へ差し込むための、label のキーキャップのマークアップ。
export function keyCapHtml(label: string): string {
  const text = label.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<kbd class="${KEY_CAP_CLASS}">${text}</kbd>`;
}

// 押せない行の ON/OFF を示す状態ピップ。点(ON は塗り、OFF は輪)と語で示し、文字色では区別しない。
// 押して切り替えるものはトグルスイッチかボタンで、この表示ではない。

// element を状態ピップとして更新する。on が点灯、own は自分が掛けているモードの点灯(自分の色)。
export function setStatePip(element: HTMLElement, on: boolean, own = false): void {
  element.classList.add('ui-pip');
  element.classList.toggle('on', on);
  element.classList.toggle('is-own', on && own);
  const text = on ? 'ON' : 'OFF';
  if (element.textContent !== text) element.textContent = text;
}

// 計器の1行([ラベル][メーター][値 単位][キー])のマークアップ。メーターや値は、組んだあとに
// data-id で引いて差し込む・書き込む。

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

type InstrumentRowSpec = InstrumentRowBaseSpec & (
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
    : `<output class="ui-v" data-id="${spec.valueId}">—</output>`;
  const key = spec.keys === undefined ? '' : keyCapHtml(spec.keys);
  return `<div class="ui-row"${rowAttr}><span class="ui-k"><span class="ui-k-text"${labelAttr}>${spec.label}</span></span>${gauge}${value}${key}</div>`;
}

// 値と単位の組を読み値の要素へ書く。単位は値より小さく淡く出る(.ui-u)。

// element を「値 単位」の表示にする。unit が空なら単位を持たない。毎フレーム呼んでよい。
export function setReadout(element: HTMLElement, value: string, unit = ''): void {
  // 値と単位を独立した表示領域に保つ。
  const first = element.firstChild;
  let valueNode: Text;
  if (first instanceof Text) {
    valueNode = first;
  } else {
    valueNode = document.createTextNode('');
    element.replaceChildren(valueNode);
  }
  if (valueNode.data !== value) valueNode.data = value;

  let unitEl = element.querySelector<HTMLElement>(':scope > .ui-u');
  if (unit === '') {
    unitEl?.remove();
    return;
  }
  if (unitEl === null) {
    unitEl = document.createElement('span');
    unitEl.className = 'ui-u';
    element.appendChild(unitEl);
  }
  if (unitEl.textContent !== unit) unitEl.textContent = unit;
}

// ショートカットキー(KeyboardEvent.code)を、メニュー項目に添える短い表記へ変換する。
// 主たるポインタが粗い環境では、項目そのものがタッチの操作部品でありキー名は案内に
// ならないので、添え字を出さない(空文字列を返す)。
export function shortcutKeyLabel(shortcut: string, coarse: boolean): string {
  if (coarse) return '';
  if (shortcut === 'Escape') return 'ESC';
  if (shortcut === 'Delete') return 'DEL';
  if (shortcut.startsWith('Key')) return shortcut.slice(3);
  return shortcut.toUpperCase();
}