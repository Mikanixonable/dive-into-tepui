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
