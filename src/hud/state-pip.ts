// 押せない行の状態を点と語で示す。点灯は塗り、消灯は輪で表す。

// element を状態ピップとして更新する。on が点灯、own は自分が掛けているモードの点灯(自分の色)。
export function setStatePip(element: HTMLElement, on: boolean, own = false): void {
  element.classList.add('ui-pip');
  element.classList.toggle('on', on);
  element.classList.toggle('is-own', on && own);
  const text = on ? 'ON' : 'OFF';
  if (element.textContent !== text) element.textContent = text;
}
