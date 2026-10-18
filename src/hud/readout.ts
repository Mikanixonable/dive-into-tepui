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
