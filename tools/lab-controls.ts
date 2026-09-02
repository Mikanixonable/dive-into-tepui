// 実験環境(render-lab / cloud-lab)の画面が共有する操作部品。row の id を受けてその中へ
// ボタン列・トグル・スライダーを足し、選択の見た目を合わせ直す関数を返す。値の正本は
// 呼び出し側が持ち、ここは表示と入力の受け渡しだけを担う。
//
// **ゲーム本体のウィジェット(src/game/hud/widgets)で足りるものはここに置かない** —
// 排他選択は SegmentedControl、真偽は ToggleSwitch がそのまま使える。

// row の中に選択肢ぶんのボタンを並べ、押されたら select を呼ぶ。返り値で選択の見た目を更新する。
export function buildButtonRow<T extends string>(
  rowId: string, entries: readonly (readonly [T, string])[], select: (value: T) => void,
): (active: T) => void {
  const row = document.getElementById(rowId)!;
  const buttons = new Map<T, HTMLButtonElement>();
  for (const [value, label] of entries) {
    const button = document.createElement('button');
    button.textContent = label;
    button.addEventListener('click', () => select(value));
    row.appendChild(button);
    buttons.set(value, button);
  }
  return (active) => {
    for (const [value, button] of buttons) button.classList.toggle('active', value === active);
  };
}

// row の中に、押すたびに裏返るボタンを1つ足す。ボタンの文字がそのまま見出しになる。
export function buildToggleField(rowId: string, label: string, select: (on: boolean) => void): (on: boolean) => void {
  const button = document.createElement('button');
  button.textContent = label;
  let on = false;
  button.addEventListener('click', () => select(!on));
  document.getElementById(rowId)!.appendChild(button);
  return (next) => {
    on = next;
    button.classList.toggle('active', on);
  };
}

// row の中にスライダーを1本足す。動かすと change を呼び、そのあと format() が返す文字を隣へ出す
// (呼ぶ順は逆にできない — 値の正本は change の書き込み先にあるため)。返り値でつまみを合わせる。
export function buildSlider(
  rowId: string, label: string, min: number, max: number, step: number,
  format: () => string, change: (value: number) => void,
): (value: number) => void {
  const row = document.getElementById(rowId)!;
  const field = document.createElement('label');
  field.className = 'field';
  const name = document.createElement('span');
  name.textContent = label;
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  const readout = document.createElement('output');
  input.addEventListener('input', () => {
    change(Number(input.value));
    readout.textContent = format();
  });
  field.append(name, input, readout);
  row.appendChild(field);
  return (value) => {
    input.value = String(value);
    readout.textContent = format();
  };
}
