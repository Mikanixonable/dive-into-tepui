// 調整値のつまみ。1 つの値を動かす単一つまみと、下限と上限を 1 本のバーの範囲として動かす二つまみ。
// どちらも「見出し・つまみ・読み出し・既定へ戻すボタン」を 1 行(.item)に並べる。

// 行の見た目の状態を操作する口。
export interface TuningRow {
  // 既定値と違う項目として強調するか。
  setChanged(changed: boolean): void;
  // つまみと読み出しを、いまの値へ合わせる(変更通知は出さない)。
  sync(): void;
}

// 行の外枠(見出しと読み出しと戻すボタン)を組んで row へ足す。中央の部品は呼び出し側が差す。
function buildItem(
  rowId: string, label: string, center: HTMLElement, extraClass: string, onReset: () => void,
): { field: HTMLElement; readout: HTMLOutputElement } {
  const field = document.createElement('div');
  field.className = `item ${extraClass}`;
  const name = document.createElement('span');
  name.textContent = label;
  name.title = label;
  const readout = document.createElement('output');
  const reset = document.createElement('button');
  reset.className = 'reset';
  reset.textContent = '↺';
  reset.title = '既定値へ戻す';
  reset.addEventListener('click', onReset);
  field.append(name, center, readout, reset);
  document.getElementById(rowId)!.appendChild(field);
  return { field, readout };
}

function rangeInput(min: number, max: number, step: number): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  return input;
}

// row の中に単一つまみを1本足す。動かすと change(value) を呼ぶ。current は値の正本からいまの値を読む。
export function buildValueControl(
  rowId: string, label: string, min: number, max: number, step: number,
  current: () => number, format: () => string, change: (value: number) => void, onReset: () => void,
): TuningRow {
  const input = rangeInput(min, max, step);
  const { field, readout } = buildItem(rowId, label, input, 'value', onReset);
  input.addEventListener('input', () => {
    change(Number(input.value));
    readout.textContent = format();
  });
  return {
    setChanged: (changed) => field.classList.toggle('changed', changed),
    sync: () => {
      input.value = String(current());
      readout.textContent = format();
    },
  };
}

// row の中に、下限と上限を 1 本のバーの範囲として動かす二つまみを足す。動かすと change(low, high) を呼ぶ。
// 下限が上限を越えないよう、動かしたつまみを相手の位置で止める。
export function buildRangeControl(
  rowId: string, label: string, min: number, max: number, step: number,
  current: () => readonly [low: number, high: number], format: () => string,
  change: (low: number, high: number) => void, onReset: () => void,
): TuningRow {
  const wrap = document.createElement('div');
  wrap.className = 'range-wrap';
  const fill = document.createElement('div');
  fill.className = 'range-fill';
  const lowInput = rangeInput(min, max, step);
  const highInput = rangeInput(min, max, step);
  wrap.append(fill, lowInput, highInput);
  const { field, readout } = buildItem(rowId, label, wrap, 'range', onReset);

  const paint = (): void => {
    const t = (value: number): number => (value - min) / (max - min);
    fill.style.left = `${t(Number(lowInput.value)) * 100}%`;
    fill.style.right = `${(1 - t(Number(highInput.value))) * 100}%`;
    readout.textContent = format();
  };
  lowInput.addEventListener('input', () => {
    if (Number(lowInput.value) > Number(highInput.value)) lowInput.value = highInput.value;
    change(Number(lowInput.value), Number(highInput.value));
    paint();
  });
  highInput.addEventListener('input', () => {
    if (Number(highInput.value) < Number(lowInput.value)) highInput.value = lowInput.value;
    change(Number(lowInput.value), Number(highInput.value));
    paint();
  });
  return {
    setChanged: (changed) => field.classList.toggle('changed', changed),
    sync: () => {
      const [low, high] = current();
      lowInput.value = String(low);
      highInput.value = String(high);
      paint();
    },
  };
}
